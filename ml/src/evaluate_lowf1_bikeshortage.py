"""XGBoost (with the neighbor feature), bike-shortage-only (target_60_empty,
NOT the combined empty-or-full target_60_issue), re-thresholded and scored
across every station whose rule-baseline 60min F1 is <= 60% (1,469 of 1,565
stations -- docs/_scratch/lowf1_60_all.csv).

Reuses the already-trained model_60.json as-is (no retraining) -- only the
alert threshold is re-selected on validation, since target_60_empty is a
different label than target_60_issue's original threshold was tuned for.

Usage:
    python ml/src/evaluate_lowf1_bikeshortage.py
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import xgboost as xgb

REPO_ROOT = Path(__file__).resolve().parents[2]
FEATURES_FILE = REPO_ROOT / "ml" / "data" / "features.parquet"
MODEL_FILE = REPO_ROOT / "ml" / "output" / "model_60.json"
STATIONS_FILE = REPO_ROOT / "docs" / "_scratch" / "lowf1_60_all.csv"
OUTPUT_FILE = REPO_ROOT / "ml" / "output" / "lowf1_bikeshortage_evaluation.json"

STATIC_NUMERIC_FEATURES = [
    "total_docks", "available_bikes", "available_docks", "bike_ratio", "dock_ratio",
    "lag_30m_bikes", "lag_30m_docks", "lag_60m_bikes", "lag_60m_docks",
    "lag_120m_bikes", "lag_120m_docks", "lag_1d_bikes", "lag_1d_docks",
    "momentum_bikes_30m", "momentum_docks_30m",
    "neighbor_low_bikes_rate", "neighbor_count",
]
CATEGORICAL_FEATURES = ["station_id", "slot", "weekday"]
FEATURE_COLUMNS = STATIC_NUMERIC_FEATURES + CATEGORICAL_FEATURES


def confusion(alert: np.ndarray, actual: np.ndarray) -> dict:
    tp = int(np.sum(alert & actual))
    fp = int(np.sum(alert & ~actual))
    fn = int(np.sum(~alert & actual))
    tn = int(np.sum(~alert & ~actual))
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3)}


def search_threshold(proba: np.ndarray, actual: np.ndarray) -> tuple[float, float]:
    best_f1, best_t = -1.0, 0.5
    for t in np.round(np.arange(0.0, 1.001, 0.01), 3):
        alert = proba >= t
        tp = int(np.sum(alert & actual))
        fp = int(np.sum(alert & ~actual))
        fn = int(np.sum(~alert & actual))
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        if f1 > best_f1:
            best_f1, best_t = f1, t
    return best_t, best_f1


def main():
    with STATIONS_FILE.open(encoding="utf-8") as fh:
        station_ids = [row["stationId"] for row in csv.DictReader(fh)]
    print(f"{len(station_ids):,} stations (baseline 60min F1 <= 60%)")

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
            station_id, split, slot, weekday,
            total_docks, available_bikes, available_docks, bike_ratio, dock_ratio,
            lag_30m_bikes, lag_30m_docks, lag_60m_bikes, lag_60m_docks,
            lag_120m_bikes, lag_120m_docks, lag_1d_bikes, lag_1d_docks,
            (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
            (available_docks - lag_30m_docks) AS momentum_docks_30m,
            neighbor_low_bikes_rate, neighbor_count,
            target_60_empty AS target
        FROM read_parquet('{FEATURES_FILE.as_posix()}')
        WHERE station_id IN ({ids_sql}) AND split IN ('validation', 'test') AND target_60_empty IS NOT NULL
    """
    df = con.execute(query).df()
    df["station_id"] = df["station_id"].astype(categories["station_id"])
    df["slot"] = df["slot"].astype(categories["slot"])
    df["weekday"] = df["weekday"].astype(categories["weekday"])
    df["target"] = df["target"].astype(bool)
    print(f"{len(df):,} rows (validation+test)")

    model = xgb.XGBClassifier()
    model.load_model(str(MODEL_FILE))
    df["proba"] = model.predict_proba(df[FEATURE_COLUMNS])[:, 1]

    val = df[df.split == "validation"]
    test = df[df.split == "test"]

    threshold, val_f1 = search_threshold(val["proba"].to_numpy(), val["target"].to_numpy())
    print(f"threshold={threshold} (val F1={val_f1:.3f})")

    alert = test["proba"].to_numpy() >= threshold
    metrics = confusion(alert, test["target"].to_numpy())
    metrics["threshold"] = float(threshold)
    metrics["valF1"] = round(val_f1, 3)
    print(f"TEST precision={metrics['precision']} recall={metrics['recall']} f1={metrics['f1']} "
          f"(tp={metrics['tp']} fp={metrics['fp']} fn={metrics['fn']} tn={metrics['tn']})")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps({
        "method": {
            "scope": f"{len(station_ids)} stations with baseline 60min F1 <= 60% (docs/_scratch/lowf1_60_all.csv)",
            "target": "target_60_empty (bike shortage only, does NOT include dock-fullness)",
            "model": "existing model_60.json (with neighbor feature), threshold re-selected on validation for this target",
        },
        "xgboost": metrics,
    }, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
