"""N-BEATS comparison (candidate #3): a pure time-series model, standard
(per-station independent) training, run only on the top-15 stations by
bike-shortage rate as a first check before deciding whether to scale up.

Unlike XGBoost, this model never sees station_id, neighbor state, or any
tabular feature -- it only sees each station's own raw available_bikes /
available_docks history (a from-scratch, "generic" N-BEATS: stacked blocks of
plain fully-connected layers with backcast/forecast heads, no basis
functions). One model is trained per station per series (bikes, docks),
predicting the value 60 minutes (2 slots) ahead from the last 24h (48 slots).

Same frozen split as everywhere else in this PoC: Jan-Apr train, May picks
the alert threshold, June is the held-out test. A predicted "issue" fires if
either series' prediction crosses its own tuned threshold; tp/fp/fn/tn are
computed against target_60_issue exactly like evaluate.py, so the numbers in
ml/output/nbeats_evaluation.json are directly comparable to the rule
baseline's and XGBoost's per-station numbers already in
app/data/station-risk-evaluation.json.

Usage:
    python ml/src/train_nbeats.py
"""
from __future__ import annotations

import json
from pathlib import Path

import duckdb
import numpy as np
import torch
from torch import nn

REPO_ROOT = Path(__file__).resolve().parents[2]
CLEAN_FILE = REPO_ROOT / "ml" / "data" / "clean.parquet"
STATIONS_FILE = REPO_ROOT / "docs" / "_scratch" / "top15_bikerisk.csv"
OUTPUT_FILE = REPO_ROOT / "ml" / "output" / "nbeats_evaluation.json"

WINDOW = 48          # 24h of 30-min history feeds the network
HORIZON_SLOTS = 2    # 60 minutes ahead
PERIOD_DAYS = 181
SLOTS_PER_DAY = 48
ORIGIN = np.datetime64("2026-01-01T00:00:00")

TRAIN_END = np.datetime64("2026-05-01T00:00:00")
VAL_END = np.datetime64("2026-06-01T00:00:00")
TEST_END = np.datetime64("2026-07-01T00:00:00")

torch.manual_seed(0)


class NBeatsBlock(nn.Module):
    """Generic block: FC stack -> theta -> separate linear backcast/forecast heads."""

    def __init__(self, input_size: int, hidden: int, forecast_size: int, layers: int = 3):
        super().__init__()
        dims = [input_size] + [hidden] * layers
        self.fc = nn.Sequential(*[
            layer
            for i in range(layers)
            for layer in (nn.Linear(dims[i], dims[i + 1]), nn.ReLU())
        ])
        self.backcast = nn.Linear(hidden, input_size)
        self.forecast = nn.Linear(hidden, forecast_size)

    def forward(self, x):
        h = self.fc(x)
        return self.backcast(h), self.forecast(h)


class NBeatsNet(nn.Module):
    def __init__(self, input_size: int, forecast_size: int, hidden: int = 64, n_blocks: int = 3):
        super().__init__()
        self.blocks = nn.ModuleList([
            NBeatsBlock(input_size, hidden, forecast_size) for _ in range(n_blocks)
        ])

    def forward(self, x):
        residual = x
        forecast_total = 0.0
        for block in self.blocks:
            backcast, forecast = block(residual)
            residual = residual - backcast
            forecast_total = forecast_total + forecast
        return forecast_total


def build_station_grid(con, station_id: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (bikes, docks, valid) arrays of length PERIOD_DAYS*SLOTS_PER_DAY,
    where `valid[i]` marks a real is_operational reading (not suspended, not a
    gap in the 30-min grid)."""
    rows = con.execute(
        """
        SELECT bucket_at, available_bikes, available_docks
        FROM read_parquet(?)
        WHERE station_id = ? AND is_operational
        ORDER BY bucket_at
        """,
        [str(CLEAN_FILE), station_id],
    ).fetchall()

    n = PERIOD_DAYS * SLOTS_PER_DAY
    bikes = np.full(n, np.nan)
    docks = np.full(n, np.nan)
    valid = np.zeros(n, dtype=bool)
    for bucket_at, available_bikes, available_docks in rows:
        offset = np.datetime64(bucket_at) - ORIGIN
        index = int(offset / np.timedelta64(30, "m"))
        if 0 <= index < n:
            bikes[index] = available_bikes
            docks[index] = available_docks
            valid[index] = True
    return bikes, docks, valid


def forward_fill(values: np.ndarray) -> np.ndarray:
    filled = values.copy()
    last = np.nan
    for i in range(len(filled)):
        if np.isnan(filled[i]):
            filled[i] = last
        else:
            last = filled[i]
    return filled


def slot_timestamp(index: int) -> np.datetime64:
    return ORIGIN + np.timedelta64(30 * index, "m")


def build_supervised(series: np.ndarray, valid: np.ndarray):
    """Direct-horizon supervised windows: X = last WINDOW readings (forward-filled),
    y = the real reading HORIZON_SLOTS ahead. Skipped when the input window has
    no real data at all, or the target itself is not a real operational reading."""
    filled = forward_fill(series)
    n = len(series)
    X, y, ts, split = [], [], [], []
    for target_index in range(WINDOW - 1 + HORIZON_SLOTS, n):
        anchor_index = target_index - HORIZON_SLOTS
        if not valid[target_index]:
            continue
        window = filled[anchor_index - WINDOW + 1: anchor_index + 1]
        if np.isnan(window).all():
            continue
        window = np.nan_to_num(window, nan=np.nanmean(window) if not np.isnan(window).all() else 0.0)
        X.append(window)
        y.append(series[target_index])
        t = slot_timestamp(target_index)
        ts.append(t)
        if t < TRAIN_END:
            split.append("train")
        elif t < VAL_END:
            split.append("validation")
        elif t < TEST_END:
            split.append("test")
        else:
            split.append(None)
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32), np.array(split)


def train_series_model(X_train, y_train, X_val, y_val, epochs=150, patience=15):
    mean, std = y_train.mean(), max(y_train.std(), 1e-6)
    Xt = torch.from_numpy((X_train - mean) / std)
    yt = torch.from_numpy((y_train - mean) / std).unsqueeze(1)
    Xv = torch.from_numpy((X_val - mean) / std)
    yv = torch.from_numpy((y_val - mean) / std).unsqueeze(1)

    model = NBeatsNet(input_size=WINDOW, forecast_size=1)
    optim = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()

    best_val, best_state, bad_epochs = float("inf"), None, 0
    for _epoch in range(epochs):
        model.train()
        optim.zero_grad()
        pred = model(Xt)
        loss = loss_fn(pred, yt)
        loss.backward()
        optim.step()

        model.eval()
        with torch.no_grad():
            val_loss = loss_fn(model(Xv), yv).item()
        if val_loss < best_val - 1e-5:
            best_val, best_state, bad_epochs = val_loss, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            bad_epochs += 1
            if bad_epochs >= patience:
                break

    model.load_state_dict(best_state)
    model.eval()
    return model, mean, std


def predict(model, X, mean, std) -> np.ndarray:
    with torch.no_grad():
        Xn = torch.from_numpy((X - mean) / std)
        pred = model(Xn).squeeze(1).numpy()
    return pred * std + mean


def best_threshold(predicted: np.ndarray, actual_zero: np.ndarray) -> tuple[float, float]:
    """Alert fires when predicted <= threshold. Search thresholds that maximize
    validation F1 against the real empty/full event."""
    candidates = np.round(np.arange(-0.5, 4.05, 0.1), 2)
    best_f1, best_t = -1.0, 0.5
    for t in candidates:
        alert = predicted <= t
        tp = int(np.sum(alert & actual_zero))
        fp = int(np.sum(alert & ~actual_zero))
        fn = int(np.sum(~alert & actual_zero))
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        if f1 > best_f1:
            best_f1, best_t = f1, t
    return best_t, best_f1


def confusion(alert: np.ndarray, actual: np.ndarray) -> dict:
    tp = int(np.sum(alert & actual))
    fp = int(np.sum(alert & ~actual))
    fn = int(np.sum(~alert & actual))
    tn = int(np.sum(~alert & ~actual))
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": precision, "recall": recall, "f1": f1}


def main():
    stations = []
    with STATIONS_FILE.open(encoding="utf-8") as fh:
        import csv
        for row in csv.DictReader(fh):
            stations.append((row["stationId"], row["name"]))

    con = duckdb.connect()
    results = {}
    for station_id, name in stations:
        print(f"\n=== {name} ({station_id}) ===")
        bikes, docks, valid = build_station_grid(con, station_id)

        Xb, yb, split_b = build_supervised(bikes, valid)
        Xd, yd, split_d = build_supervised(docks, valid)
        if len(yb) < 200:
            print(f"  skipped: only {len(yb)} usable windows")
            continue

        def split_arrays(X, y, split, name):
            parts = {}
            for key in ("train", "validation", "test"):
                mask = split == key
                parts[key] = (X[mask], y[mask])
                print(f"  {name} {key}: {mask.sum()} rows")
            return parts

        bike_parts = split_arrays(Xb, yb, split_b, "bikes")
        dock_parts = split_arrays(Xd, yd, split_d, "docks")

        bike_model, bm, bs = train_series_model(*bike_parts["train"], *bike_parts["validation"])
        dock_model, dm, ds = train_series_model(*dock_parts["train"], *dock_parts["validation"])

        val_bike_pred = predict(bike_model, bike_parts["validation"][0], bm, bs)
        val_dock_pred = predict(dock_model, dock_parts["validation"][0], dm, ds)
        bike_t, bike_val_f1 = best_threshold(val_bike_pred, bike_parts["validation"][1] == 0)
        dock_t, dock_val_f1 = best_threshold(val_dock_pred, dock_parts["validation"][1] == 0)
        print(f"  bike threshold={bike_t} (val F1={bike_val_f1:.3f}); dock threshold={dock_t} (val F1={dock_val_f1:.3f})")

        # test set: bikes/docks test windows share the same target timestamps
        # (both built from the same `valid` mask), so they align positionally.
        test_bike_X, test_bike_y = bike_parts["test"]
        test_dock_X, test_dock_y = dock_parts["test"]
        if len(test_bike_y) != len(test_dock_y):
            print(f"  WARNING: bike/dock test set length mismatch ({len(test_bike_y)} vs {len(test_dock_y)}), skipping")
            continue

        test_bike_pred = predict(bike_model, test_bike_X, bm, bs)
        test_dock_pred = predict(dock_model, test_dock_X, dm, ds)
        bike_alert = test_bike_pred <= bike_t
        dock_alert = test_dock_pred <= dock_t
        issue_alert = bike_alert | dock_alert
        issue_actual = (test_bike_y == 0) | (test_dock_y == 0)

        metrics = confusion(issue_alert, issue_actual)
        print(f"  TEST: precision={metrics['precision']:.3f} recall={metrics['recall']:.3f} f1={metrics['f1']:.3f} "
              f"(tp={metrics['tp']} fp={metrics['fp']} fn={metrics['fn']} tn={metrics['tn']})")
        results[station_id] = {"name": name, "60": metrics}

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps({
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "method": {
            "model": "N-BEATS (generic, from-scratch, per-station independent, WINDOW=48 slots / 24h, "
                      "direct-horizon regression at 60min)",
            "scope": "top15_bikerisk (docs/_scratch/top15_bikerisk.csv)",
            "note": "bikes/docks each get their own N-BEATS regressor per station; an alert fires when either "
                    "series' prediction crosses its own May-tuned threshold. Compare against the same stations' "
                    "baseline/model numbers in app/data/station-risk-evaluation.json.",
        },
        "stations": results,
    }, indent=2), encoding="utf-8")
    print(f"\nWrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
