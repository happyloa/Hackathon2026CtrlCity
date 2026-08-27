"""Validate proposal #1 from the hybrid-system discussion: does picking a
separate F1-maximizing threshold per district (instead of one global
threshold) improve the 60-minute XGBoost tier, with zero retraining?

Only touches the "XGBoost tier" districts already decided in PoC交接.md
(station count >= STATION_FLOOR and rule-baseline F1 < F1_CEILING) --
the "baseline tier" districts keep using the rule baseline untouched.

Usage: python ml/src/threshold_by_district.py
"""
import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
FEATURES_PATH = ROOT / "data" / "features.parquet"
OUTPUT_DIR = ROOT / "output"
BASELINE_FILE = REPO_ROOT / "app" / "data" / "forecast-evaluation.json"

HORIZON = 60
STATION_FLOOR = 10
F1_CEILING = 0.40
CANDIDATES = [round(t, 2) for t in np.arange(0.02, 0.91, 0.01)]

NUMERIC_FEATURES = [
    "total_docks", "available_bikes", "available_docks", "bike_ratio", "dock_ratio",
    "lag_30m_bikes", "lag_30m_docks", "lag_60m_bikes", "lag_60m_docks",
    "lag_120m_bikes", "lag_120m_docks", "lag_1d_bikes", "lag_1d_docks",
    "momentum_bikes_30m", "momentum_docks_30m",
    "neighbor_low_bikes_rate", "neighbor_count",
]
CATEGORICAL_FEATURES = ["station_id", "slot", "weekday"]
FEATURE_COLUMNS = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def load_categories(con):
    station_ids = con.execute(
        f"SELECT DISTINCT station_id FROM read_parquet('{FEATURES_PATH.as_posix()}') ORDER BY station_id"
    ).df()["station_id"].tolist()
    return {
        "station_id": pd.CategoricalDtype(categories=station_ids),
        "slot": pd.CategoricalDtype(categories=list(range(48))),
        "weekday": pd.CategoricalDtype(categories=list(range(7))),
    }


def load_split(con, split, categories):
    target_col = f"target_{HORIZON}_issue"
    query = f"""
        SELECT
            station_id, district, slot, weekday,
            total_docks, available_bikes, available_docks, bike_ratio, dock_ratio,
            lag_30m_bikes, lag_30m_docks, lag_60m_bikes, lag_60m_docks,
            lag_120m_bikes, lag_120m_docks, lag_1d_bikes, lag_1d_docks,
            (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
            (available_docks - lag_30m_docks) AS momentum_docks_30m,
            neighbor_low_bikes_rate, neighbor_count,
            {target_col} AS target
        FROM read_parquet('{FEATURES_PATH.as_posix()}')
        WHERE split = '{split}' AND {target_col} IS NOT NULL
    """
    df = con.execute(query).df()
    df["station_id"] = df["station_id"].astype(categories["station_id"])
    df["slot"] = df["slot"].astype(categories["slot"])
    df["weekday"] = df["weekday"].astype(categories["weekday"])
    district = df.pop("district")
    y = df.pop("target").astype(bool)
    return df[FEATURE_COLUMNS], y, district


def confusion_at(proba, actual, threshold):
    predicted = proba >= threshold
    tp = int(np.sum(predicted & actual))
    fp = int(np.sum(predicted & ~actual))
    fn = int(np.sum(~predicted & actual))
    tn = int(np.sum(~predicted & ~actual))
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"threshold": threshold, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3)}


def select_threshold(proba, actual):
    candidates = [confusion_at(proba, actual, t) for t in CANDIDATES]
    candidates.sort(key=lambda c: (c["f1"], c["precision"], c["recall"], c["threshold"]), reverse=True)
    return candidates[0]


def main():
    baseline = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    by_district = baseline["test"]["byDistrict"]
    xgboost_tier = {
        name for name, entry in by_district.items()
        if entry["stationCount"] >= STATION_FLOOR and entry["horizons"]["60"]["f1"] < F1_CEILING
    }
    print(f"XGBoost-tier districts: {len(xgboost_tier)}")

    con = duckdb.connect()
    categories = load_categories(con)
    model = xgb.XGBClassifier()
    model.load_model(OUTPUT_DIR / f"model_{HORIZON}.json")

    X_val, y_val, district_val = load_split(con, "validation", categories)
    val_proba = model.predict_proba(X_val)[:, 1]

    per_district_threshold = {}
    for name in sorted(xgboost_tier):
        mask = (district_val == name).to_numpy()
        if mask.sum() < 100:
            continue
        best = select_threshold(val_proba[mask], y_val.to_numpy()[mask])
        per_district_threshold[name] = best["threshold"]
        print(f"{name}: n={mask.sum():,} threshold={best['threshold']} "
              f"val_f1={best['f1']} val_precision={best['precision']} val_recall={best['recall']}")

    (OUTPUT_DIR / f"selected_thresholds_by_district_{HORIZON}.json").write_text(
        json.dumps(per_district_threshold, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # --- apply on test split, compare against the single global threshold ---
    X_test, y_test, district_test = load_split(con, "test", categories)
    test_proba = model.predict_proba(X_test)[:, 1]
    y_test_arr = y_test.to_numpy()

    global_threshold = json.loads((OUTPUT_DIR / "selected_thresholds.json").read_text(encoding="utf-8"))[str(HORIZON)]["threshold"]

    totals_global = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    totals_per_district = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    print("\n--- per-district test results: global threshold vs per-district threshold ---")
    for name in sorted(xgboost_tier):
        mask = (district_test == name).to_numpy()
        if mask.sum() == 0:
            continue
        g = confusion_at(test_proba[mask], y_test_arr[mask], global_threshold)
        threshold = per_district_threshold.get(name, global_threshold)
        d = confusion_at(test_proba[mask], y_test_arr[mask], threshold)
        for key in totals_global:
            totals_global[key] += g[key]
            totals_per_district[key] += d[key]
        print(f"{name}: global(thr={global_threshold}) F1={g['f1']} P={g['precision']} R={g['recall']} "
              f"  |  per-district(thr={threshold}) F1={d['f1']} P={d['precision']} R={d['recall']}")

    def summarize(totals):
        tp, fp, fn, tn = totals["tp"], totals["fp"], totals["fn"], totals["tn"]
        p = tp / (tp + fp) if (tp + fp) else 0.0
        r = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) else 0.0
        return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f1, 4), "n": tp + fp + fn + tn}

    print("\nXGBoost-tier combined, global threshold:     ", summarize(totals_global))
    print("XGBoost-tier combined, per-district threshold:", summarize(totals_per_district))


if __name__ == "__main__":
    main()
