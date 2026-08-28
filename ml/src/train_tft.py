"""TFT comparison (candidate #4): a global Temporal Fusion Transformer trained
across all top-15 stations at once (unlike N-BEATS, which trained one network
per station and lost badly to both the rule baseline and XGBoost -- see
docs/PoC交接.md's "候選方向 N-BEATS" section for that result).

Adds the two external signals validated as real, cross-station-consistent
signal in the weather feature-analysis pass (docs/_scratch/weather_feature_analysis.md):
precipitation and temperature (residualized correlation with shortage rate
-0.16~-0.20 and +0.11~+0.12; wind speed was inconsistent across the two
weather stations and is deliberately left out). Also adds a holiday flag
built from docs/_scratch/calandar.md.

Same frozen split as everywhere else: Jan-Apr train, May validation, June
test. Two separate TFT models are trained (available_bikes, available_docks),
each predicting 2 steps (30/60 min) ahead from a 48-step (24h) encoder
window; only the 60-min (step index 1) prediction is evaluated, with the
same threshold-tuned-on-May / confusion-matrix-on-June methodology as
train_nbeats.py, so the numbers are directly comparable.

Usage:
    python ml/src/train_tft.py
"""
from __future__ import annotations

import csv
import json
import warnings
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import torch
from lightning.pytorch import Trainer
from lightning.pytorch.callbacks import EarlyStopping
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data import GroupNormalizer
from pytorch_forecasting.metrics import RMSE

warnings.filterwarnings("ignore")

REPO_ROOT = Path(__file__).resolve().parents[2]
CLEAN_FILE = REPO_ROOT / "ml" / "data" / "clean.parquet"
STATIONS_FILE = REPO_ROOT / "docs" / "_scratch" / "top15_bikerisk.csv"
WEATHER_FILE = REPO_ROOT / "docs" / "_scratch" / "weather_hourly.csv"
OUTPUT_FILE = REPO_ROOT / "ml" / "output" / "tft_evaluation.json"

PERIOD_DAYS = 181
SLOTS_PER_DAY = 48
ORIGIN = np.datetime64("2026-01-01T00:00:00")
ENCODER_LENGTH = 48
PREDICTION_LENGTH = 2  # 30min, 60min -- only step index 1 (60min) is scored

TRAIN_END = np.datetime64("2026-05-01T00:00:00")
VAL_END = np.datetime64("2026-06-01T00:00:00")
TEST_END = np.datetime64("2026-07-01T00:00:00")

HOLIDAYS: set[date] = set()
for start, end in [
    (date(2026, 1, 1), date(2026, 1, 1)),
    (date(2026, 2, 16), date(2026, 2, 20)),
    (date(2026, 2, 27), date(2026, 2, 27)),
    (date(2026, 4, 3), date(2026, 4, 6)),
    (date(2026, 5, 1), date(2026, 5, 1)),
    (date(2026, 6, 19), date(2026, 6, 19)),
]:
    d = start
    while d <= end:
        HOLIDAYS.add(d)
        d += timedelta(days=1)

torch.manual_seed(0)


def load_weather() -> pd.DataFrame:
    """Citywide average of the two CWA hourly stations, expanded to the 30-min
    grid (both half-hour slots inside an hour share that hour's reading)."""
    rows = []
    with WEATHER_FILE.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            rows.append(row)
    df = pd.DataFrame(rows)
    df["datetime"] = pd.to_datetime(df["datetime"])
    df["precip_mm"] = pd.to_numeric(df["precip_mm"], errors="coerce")
    df["air_temp_c"] = pd.to_numeric(df["air_temp_c"], errors="coerce")
    hourly = df.groupby("datetime")[["precip_mm", "air_temp_c"]].mean().reset_index()
    hourly = hourly.set_index("datetime").asfreq("h").interpolate().reset_index()
    return hourly


def weather_lookup(hourly: pd.DataFrame):
    hourly = hourly.set_index("datetime")
    precip_mean, precip_std = hourly["precip_mm"].mean(), hourly["precip_mm"].std() or 1.0
    temp_mean, temp_std = hourly["air_temp_c"].mean(), hourly["air_temp_c"].std() or 1.0

    def lookup(timestamps: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        hour_ts = pd.DatetimeIndex(timestamps).floor("h")
        matched = hourly.reindex(hour_ts)
        precip = matched["precip_mm"].fillna(precip_mean).to_numpy()
        temp = matched["air_temp_c"].fillna(temp_mean).to_numpy()
        return (precip - precip_mean) / precip_std, (temp - temp_mean) / temp_std

    return lookup


def build_station_frame(con, station_id: str, name: str, weather_fn) -> pd.DataFrame:
    rows = con.execute(
        """
        SELECT bucket_at, available_bikes, available_docks, total_docks
        FROM read_parquet(?)
        WHERE station_id = ? AND is_operational
        ORDER BY bucket_at
        """,
        [str(CLEAN_FILE), station_id],
    ).fetchall()

    n = PERIOD_DAYS * SLOTS_PER_DAY
    timestamps = ORIGIN + np.arange(n) * np.timedelta64(30, "m")
    bikes = np.full(n, np.nan)
    docks = np.full(n, np.nan)
    valid = np.zeros(n, dtype=bool)
    total_docks = np.nan
    for bucket_at, available_bikes, available_docks, td in rows:
        offset = np.datetime64(bucket_at) - ORIGIN
        index = int(offset / np.timedelta64(30, "m"))
        if 0 <= index < n:
            bikes[index] = available_bikes
            docks[index] = available_docks
            valid[index] = True
            total_docks = td

    bikes_filled = pd.Series(bikes).ffill().bfill().to_numpy()
    docks_filled = pd.Series(docks).ffill().bfill().to_numpy()
    precip, temp = weather_fn(timestamps)

    dt = pd.DatetimeIndex(timestamps)
    slot = (dt.hour * 2 + dt.minute // 30).to_numpy()
    weekday = dt.weekday.to_numpy()  # Monday=0
    is_holiday = np.array([d.date() in HOLIDAYS for d in dt], dtype=np.float32)
    is_workday = ((weekday < 5) & (is_holiday == 0)).astype(np.float32)

    frame = pd.DataFrame({
        "station_id": station_id,
        "name": name,
        "time_idx": np.arange(n),
        "timestamp": timestamps,
        "available_bikes": bikes_filled.astype(np.float32),
        "available_docks": docks_filled.astype(np.float32),
        "is_target_valid": valid,
        "total_docks": float(total_docks),
        "slot_sin": np.sin(2 * np.pi * slot / SLOTS_PER_DAY).astype(np.float32),
        "slot_cos": np.cos(2 * np.pi * slot / SLOTS_PER_DAY).astype(np.float32),
        "weekday_sin": np.sin(2 * np.pi * weekday / 7).astype(np.float32),
        "weekday_cos": np.cos(2 * np.pi * weekday / 7).astype(np.float32),
        "is_holiday": is_holiday,
        "is_workday": is_workday,
        "precip_mm": precip.astype(np.float32),
        "air_temp_c": temp.astype(np.float32),
    })
    frame["split"] = np.select(
        [frame["timestamp"] < TRAIN_END, frame["timestamp"] < VAL_END, frame["timestamp"] < TEST_END],
        ["train", "validation", "test"], default="none",
    )
    return frame


def make_dataset(df: pd.DataFrame, target: str, cutoff_time_idx: int | None) -> TimeSeriesDataSet:
    train_df = df if cutoff_time_idx is None else df[df.time_idx <= cutoff_time_idx]
    return TimeSeriesDataSet(
        train_df,
        time_idx="time_idx",
        target=target,
        group_ids=["station_id"],
        min_encoder_length=ENCODER_LENGTH,
        max_encoder_length=ENCODER_LENGTH,
        min_prediction_length=PREDICTION_LENGTH,
        max_prediction_length=PREDICTION_LENGTH,
        static_categoricals=["station_id"],
        static_reals=["total_docks"],
        time_varying_known_reals=[
            "time_idx", "slot_sin", "slot_cos", "weekday_sin", "weekday_cos", "is_holiday", "is_workday",
        ],
        time_varying_unknown_reals=[target, "precip_mm", "air_temp_c"],
        target_normalizer=GroupNormalizer(groups=["station_id"]),
        allow_missing_timesteps=False,
    )


def best_threshold(predicted: np.ndarray, actual_zero: np.ndarray) -> tuple[float, float]:
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


def train_target_model(df: pd.DataFrame, target: str) -> TemporalFusionTransformer:
    train_cutoff = int(df[df.split == "train"].time_idx.max())
    training = make_dataset(df, target, cutoff_time_idx=train_cutoff)
    validation = TimeSeriesDataSet.from_dataset(training, df, predict=False, stop_randomization=True)

    train_loader = training.to_dataloader(train=True, batch_size=128, num_workers=0)
    val_loader = validation.to_dataloader(train=False, batch_size=256, num_workers=0)

    model = TemporalFusionTransformer.from_dataset(
        training,
        hidden_size=16,
        attention_head_size=1,
        dropout=0.1,
        hidden_continuous_size=8,
        loss=RMSE(),
        learning_rate=0.03,
        log_interval=0,
    )
    trainer = Trainer(
        max_epochs=12,
        accelerator="cpu",
        enable_progress_bar=False,
        enable_model_summary=False,
        gradient_clip_val=0.1,
        callbacks=[EarlyStopping(monitor="val_loss", patience=3, mode="min")],
        logger=False,
    )
    trainer.fit(model, train_dataloaders=train_loader, val_dataloaders=val_loader)
    return model


def predict_for_split(model: TemporalFusionTransformer, df: pd.DataFrame, target: str, split: str):
    """Returns (predicted_60min, actual_60min, is_valid) aligned by prediction
    window whose LAST decoder step (60min) falls inside `split`."""
    dataset = make_dataset(df, target, cutoff_time_idx=None)
    loader = dataset.to_dataloader(train=False, batch_size=512, num_workers=0)
    raw = model.predict(loader, mode="prediction", return_x=True)
    preds = raw.output.numpy()  # (n_samples, PREDICTION_LENGTH)
    decoder_time_idx = raw.x["decoder_time_idx"].numpy()  # (n_samples, PREDICTION_LENGTH)

    # time_idx repeats across stations (same shared 30-min grid for every
    # group), so a lookup keyed on time_idx alone is ambiguous -- must also
    # key on station_id, decoded from the encoded group ids pytorch_forecasting
    # puts in raw.x["groups"].
    group_encoder = dataset._categorical_encoders["station_id"]
    station_ids = group_encoder.inverse_transform(raw.x["groups"][:, 0].numpy())

    target_time_idx = decoder_time_idx[:, 1]  # 60min step
    pred_60 = preds[:, 1]

    lookup = df.assign(station_id=df["station_id"].astype(str)).set_index(["station_id", "time_idx"])
    key = pd.MultiIndex.from_arrays([station_ids.astype(str), target_time_idx])
    matched = lookup.loc[key]
    actual = matched[target].to_numpy()
    is_valid = matched["is_target_valid"].to_numpy()
    in_split = (matched["split"] == split).to_numpy()

    mask = in_split
    return pred_60[mask], actual[mask], is_valid[mask]


def main():
    stations = []
    with STATIONS_FILE.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            stations.append((row["stationId"], row["name"]))

    print("Building station frames...")
    con = duckdb.connect()
    weather_fn = weather_lookup(load_weather())
    frames = [build_station_frame(con, sid, name, weather_fn) for sid, name in stations]
    df = pd.concat(frames, ignore_index=True)
    df["station_id"] = df["station_id"].astype("category")
    print(f"  {len(df):,} rows across {len(stations)} stations")

    results = {sid: {"name": name} for sid, name in stations}
    predictions = {}
    for target in ["available_bikes", "available_docks"]:
        print(f"\n=== Training TFT for {target} ===")
        model = train_target_model(df, target)

        val_pred, val_actual, val_valid = predict_for_split(model, df, target, "validation")
        val_pred, val_actual = val_pred[val_valid], val_actual[val_valid]
        threshold, val_f1 = best_threshold(val_pred, val_actual == 0)
        print(f"  {target} threshold={threshold} (val F1={val_f1:.3f})")

        test_pred, test_actual, test_valid = predict_for_split(model, df, target, "test")
        predictions[target] = {"pred": test_pred, "actual": test_actual, "valid": test_valid, "threshold": threshold}

    # Per-station breakdown would need station_id carried through predict_for_split's
    # masks; left as a follow-up if this pooled (all 15 stations combined) result looks
    # promising enough to be worth the extra plumbing.
    bike_p, bike_a, bike_v = predictions["available_bikes"]["pred"], predictions["available_bikes"]["actual"], predictions["available_bikes"]["valid"]
    dock_p, dock_a, dock_v = predictions["available_docks"]["pred"], predictions["available_docks"]["actual"], predictions["available_docks"]["valid"]
    n = min(len(bike_p), len(dock_p))
    valid_both = bike_v[:n] & dock_v[:n]
    bike_alert = (bike_p[:n] <= predictions["available_bikes"]["threshold"])[valid_both]
    dock_alert = (dock_p[:n] <= predictions["available_docks"]["threshold"])[valid_both]
    issue_alert = bike_alert | dock_alert
    issue_actual = (bike_a[:n][valid_both] == 0) | (dock_a[:n][valid_both] == 0)
    metrics = confusion(issue_alert, issue_actual)
    print(f"\nPOOLED TEST (all 15 stations, 60min): precision={metrics['precision']:.3f} "
          f"recall={metrics['recall']:.3f} f1={metrics['f1']:.3f}")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps({
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "method": {
            "model": "TFT (pytorch-forecasting TemporalFusionTransformer), global model across top15_bikerisk "
                     "stations, ENCODER_LENGTH=48 slots, features = own history + precip_mm + air_temp_c + "
                     "is_holiday + is_workday + cyclical slot/weekday",
            "scope": "top15_bikerisk (docs/_scratch/top15_bikerisk.csv), pooled evaluation only",
        },
        "pooled60": metrics,
    }, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
