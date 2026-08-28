"""Re-scores XGBoost / N-BEATS / TFT (bikes side only, restricted to the
top15_bikerisk stations whose rule-baseline 60min F1 is BELOW 40% --
docs/_scratch/lowf1_bikerisk.csv, 5 stations -- matching the hybrid
deployment threshold already validated elsewhere in this PoC: baseline F1
<40% is where a model is worth switching in) against two severity tiers
instead of the single "available_bikes == 0" event used everywhere else in
this PoC:

    complete : available_bikes == 0          (the existing target_60_empty)
    near     : available_bikes <= 2          (early warning, before it's empty)

The rule baseline is intentionally NOT touched -- it stays on its existing
definition (forecast-evaluation.json), per instruction. This is an
evaluate-only pass: no model is retrained on a new label. XGBoost reuses its
already-trained probability output and is just re-thresholded/re-scored
against the "near" label; N-BEATS and TFT ARE retrained here (bikes target
only, no docks) because their raw continuous predictions from the earlier
run were never persisted to disk.

Usage:
    python ml/src/evaluate_severity_tiers.py
"""
from __future__ import annotations

import csv
import json
import sys
import warnings
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import xgboost as xgb

warnings.filterwarnings("ignore")

SRC_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SRC_DIR))
import train_nbeats as nb  # noqa: E402
import train_tft as tft  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FEATURES_FILE = REPO_ROOT / "ml" / "data" / "features.parquet"
CLEAN_FILE = REPO_ROOT / "ml" / "data" / "clean.parquet"
MODEL_FILE = REPO_ROOT / "ml" / "output" / "model_60.json"
STATIONS_FILE = REPO_ROOT / "docs" / "_scratch" / "lowf1_bikerisk.csv"
OUTPUT_FILE = REPO_ROOT / "ml" / "output" / "severity_tier_evaluation.json"

TIERS = {
    "complete": lambda bikes: bikes == 0,
    "near": lambda bikes: bikes <= 2,
}


def confusion(alert: np.ndarray, actual: np.ndarray) -> dict:
    tp = int(np.sum(alert & actual))
    fp = int(np.sum(alert & ~actual))
    fn = int(np.sum(~alert & actual))
    tn = int(np.sum(~alert & ~actual))
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3)}


def search_threshold(scores: np.ndarray, actual_positive: np.ndarray, candidates: np.ndarray) -> tuple[float, float]:
    best_f1, best_t = -1.0, candidates[0]
    for t in candidates:
        alert = scores >= t if candidates[0] >= 0 and candidates[-1] <= 1 else scores <= t
        tp = int(np.sum(alert & actual_positive))
        fp = int(np.sum(alert & ~actual_positive))
        fn = int(np.sum(~alert & actual_positive))
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        if f1 > best_f1:
            best_f1, best_t = f1, t
    return best_t, best_f1


def load_top15_ids() -> list[str]:
    with STATIONS_FILE.open(encoding="utf-8") as fh:
        return [row["stationId"] for row in csv.DictReader(fh)]


# ---------------------------------------------------------------------------
# XGBoost: reuse the already-trained model_60.json's probability output,
# just re-threshold/re-score it against each tier's actual label.
# ---------------------------------------------------------------------------

def evaluate_xgboost(station_ids: list[str]) -> dict:
    from train import STATIC_NUMERIC_FEATURES, CATEGORICAL_FEATURES  # noqa: E402

    con = duckdb.connect()
    all_station_ids = con.execute(
        f"SELECT DISTINCT station_id FROM read_parquet('{FEATURES_FILE.as_posix()}') ORDER BY station_id"
    ).df()["station_id"].tolist()
    categories = {
        "station_id": pd.CategoricalDtype(categories=all_station_ids),
        "slot": pd.CategoricalDtype(categories=list(range(48))),
        "weekday": pd.CategoricalDtype(categories=list(range(7))),
    }

    ids_sql = ", ".join(f"'{sid}'" for sid in station_ids)
    query = f"""
        SELECT
            station_id, bucket_at, split, slot, weekday,
            total_docks, available_bikes, available_docks, bike_ratio, dock_ratio,
            lag_30m_bikes, lag_30m_docks, lag_60m_bikes, lag_60m_docks,
            lag_120m_bikes, lag_120m_docks, lag_1d_bikes, lag_1d_docks,
            (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
            (available_docks - lag_30m_docks) AS momentum_docks_30m,
            neighbor_low_bikes_rate, neighbor_count
        FROM read_parquet('{FEATURES_FILE.as_posix()}')
        WHERE station_id IN ({ids_sql}) AND split IN ('validation', 'test') AND target_60_issue IS NOT NULL
    """
    df = con.execute(query).df()
    df["station_id"] = df["station_id"].astype(categories["station_id"])
    df["slot"] = df["slot"].astype(categories["slot"])
    df["weekday"] = df["weekday"].astype(categories["weekday"])

    # The actual 60min-ahead bike count isn't stored in features.parquet (only
    # the pre-computed booleans are) -- pull it fresh from clean.parquet with
    # the same LEAD(2 rows)+is_operational validity check features.py uses.
    lead_query = f"""
        SELECT station_id, bucket_at,
               CASE WHEN lead_at = bucket_at + INTERVAL '60 minutes' AND lead_operational
                    THEN lead_bikes END AS actual_bikes_60
        FROM (
            SELECT station_id, bucket_at,
                   LEAD(bucket_at, 2) OVER w AS lead_at,
                   LEAD(available_bikes, 2) OVER w AS lead_bikes,
                   LEAD(is_operational, 2) OVER w AS lead_operational
            FROM read_parquet('{CLEAN_FILE.as_posix()}')
            WHERE station_id IN ({ids_sql}) AND is_operational
            WINDOW w AS (PARTITION BY station_id ORDER BY bucket_at)
        )
    """
    leads = con.execute(lead_query).df().dropna(subset=["actual_bikes_60"])

    merged = df.merge(leads, on=["station_id", "bucket_at"], how="inner")
    merged["station_id"] = merged["station_id"].astype(categories["station_id"])
    merged["slot"] = merged["slot"].astype(categories["slot"])
    merged["weekday"] = merged["weekday"].astype(categories["weekday"])
    feature_columns = STATIC_NUMERIC_FEATURES + CATEGORICAL_FEATURES

    model = xgb.XGBClassifier()
    model.load_model(str(MODEL_FILE))
    proba = model.predict_proba(merged[feature_columns])[:, 1]
    merged = merged.assign(proba=proba)

    val = merged[merged.split == "validation"]
    test = merged[merged.split == "test"]

    results = {}
    for tier_name, tier_fn in TIERS.items():
        val_actual = tier_fn(val["actual_bikes_60"].to_numpy())
        threshold, val_f1 = search_threshold(val["proba"].to_numpy(), val_actual, np.round(np.arange(0.0, 1.001, 0.01), 3))
        test_actual = tier_fn(test["actual_bikes_60"].to_numpy())
        alert = test["proba"].to_numpy() >= threshold
        metrics = confusion(alert, test_actual)
        metrics["threshold"] = float(threshold)
        metrics["valF1"] = round(val_f1, 3)
        results[tier_name] = metrics
        print(f"  XGBoost [{tier_name}] threshold={threshold:.2f} (val F1={val_f1:.3f}) "
              f"TEST precision={metrics['precision']} recall={metrics['recall']} f1={metrics['f1']}")
    return results


# ---------------------------------------------------------------------------
# N-BEATS: retrain the bikes-only model per station (skip docks -- not needed
# for a bike-shortage-only comparison), pool val/test predictions across all
# 15 stations, then tier-evaluate the pooled arrays.
# ---------------------------------------------------------------------------

def evaluate_nbeats(station_ids: list[str]) -> dict:
    con = duckdb.connect()
    val_pred_all, val_actual_all, test_pred_all, test_actual_all = [], [], [], []
    for station_id in station_ids:
        bikes, docks, valid = nb.build_station_grid(con, station_id)
        Xb, yb, split_b = nb.build_supervised(bikes, valid)
        if len(yb) < 200:
            continue
        parts = {key: (Xb[split_b == key], yb[split_b == key]) for key in ("train", "validation", "test")}
        model, mean, std = nb.train_series_model(*parts["train"], *parts["validation"])
        val_pred_all.append(nb.predict(model, parts["validation"][0], mean, std))
        val_actual_all.append(parts["validation"][1])
        test_pred_all.append(nb.predict(model, parts["test"][0], mean, std))
        test_actual_all.append(parts["test"][1])
        print(f"  N-BEATS trained for {station_id}")

    val_pred = np.concatenate(val_pred_all)
    val_actual = np.concatenate(val_actual_all)
    test_pred = np.concatenate(test_pred_all)
    test_actual = np.concatenate(test_actual_all)

    results = {}
    for tier_name, tier_fn in TIERS.items():
        threshold, val_f1 = search_threshold(val_pred, tier_fn(val_actual), np.round(np.arange(-0.5, 6.05, 0.1), 2))
        alert = test_pred <= threshold
        metrics = confusion(alert, tier_fn(test_actual))
        metrics["threshold"] = float(threshold)
        metrics["valF1"] = round(val_f1, 3)
        results[tier_name] = metrics
        print(f"  N-BEATS [{tier_name}] threshold={threshold} (val F1={val_f1:.3f}) "
              f"TEST precision={metrics['precision']} recall={metrics['recall']} f1={metrics['f1']}")
    return results


# ---------------------------------------------------------------------------
# TFT: retrain the bikes-only global model (skip docks), tier-evaluate the
# pooled val/test predictions.
# ---------------------------------------------------------------------------

def evaluate_tft(station_ids: list[str]) -> dict:
    stations = []
    with STATIONS_FILE.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["stationId"] in station_ids:
                stations.append((row["stationId"], row["name"]))

    con = duckdb.connect()
    weather_fn = tft.weather_lookup(tft.load_weather())
    frames = [tft.build_station_frame(con, sid, name, weather_fn) for sid, name in stations]
    df = pd.concat(frames, ignore_index=True)
    df["station_id"] = df["station_id"].astype("category")

    model = tft.train_target_model(df, "available_bikes")
    val_pred, val_actual, val_valid = tft.predict_for_split(model, df, "available_bikes", "validation")
    test_pred, test_actual, test_valid = tft.predict_for_split(model, df, "available_bikes", "test")
    val_pred, val_actual = val_pred[val_valid], val_actual[val_valid]
    test_pred, test_actual = test_pred[test_valid], test_actual[test_valid]

    results = {}
    for tier_name, tier_fn in TIERS.items():
        threshold, val_f1 = search_threshold(val_pred, tier_fn(val_actual), np.round(np.arange(-0.5, 6.05, 0.1), 2))
        alert = test_pred <= threshold
        metrics = confusion(alert, tier_fn(test_actual))
        metrics["threshold"] = float(threshold)
        metrics["valF1"] = round(val_f1, 3)
        results[tier_name] = metrics
        print(f"  TFT [{tier_name}] threshold={threshold} (val F1={val_f1:.3f}) "
              f"TEST precision={metrics['precision']} recall={metrics['recall']} f1={metrics['f1']}")
    return results


def main():
    station_ids = load_top15_ids()

    print("=== XGBoost ===")
    xgb_results = evaluate_xgboost(station_ids)
    print("\n=== N-BEATS ===")
    nbeats_results = evaluate_nbeats(station_ids)
    print("\n=== TFT ===")
    tft_results = evaluate_tft(station_ids)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps({
        "method": {
            "scope": "lowf1_bikerisk (baseline 60min F1 < 40%, 5 of the top15_bikerisk stations), "
                     "bikes-only (available_bikes), pooled across stations",
            "tiers": {"complete": "available_bikes == 0", "near": "available_bikes <= 2"},
            "note": "Rule baseline intentionally not re-scored under these tiers -- kept as-is.",
        },
        "xgboost": xgb_results,
        "nbeats": nbeats_results,
        "tft": tft_results,
    }, indent=2), encoding="utf-8")
    print(f"\nWrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
