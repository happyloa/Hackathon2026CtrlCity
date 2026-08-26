"""Step 7: evaluate the trained XGBoost models on split='test' (June, never
seen during training or threshold selection) and compare against the rule
baseline's held-out numbers (60min F1=34.8%, precision=28.4%, recall=45.0%,
from app/data/forecast-evaluation.json test.horizons['60'])."""

import json
from pathlib import Path

import duckdb
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[1]
FEATURES_PATH = ROOT / "data" / "features.parquet"
OUTPUT_DIR = ROOT / "output"

HORIZONS = [30, 60, 120]

NUMERIC_FEATURES = [
    "total_docks", "available_bikes", "available_docks", "bike_ratio", "dock_ratio",
    "lag_30m_bikes", "lag_30m_docks", "lag_60m_bikes", "lag_60m_docks",
    "lag_120m_bikes", "lag_120m_docks", "lag_1d_bikes", "lag_1d_docks",
    "momentum_bikes_30m", "momentum_docks_30m",
]
CATEGORICAL_FEATURES = ["station_id", "slot", "weekday"]
FEATURE_COLUMNS = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def load_categories(con: duckdb.DuckDBPyConnection) -> dict:
    station_ids = con.execute(
        f"SELECT DISTINCT station_id FROM read_parquet('{FEATURES_PATH.as_posix()}') ORDER BY station_id"
    ).df()["station_id"].tolist()
    return {
        "station_id": pd.CategoricalDtype(categories=station_ids),
        "slot": pd.CategoricalDtype(categories=list(range(48))),
        "weekday": pd.CategoricalDtype(categories=list(range(7))),
    }


def load_test(con: duckdb.DuckDBPyConnection, horizon: int, categories: dict):
    target_col = f"target_{horizon}_issue"
    query = f"""
        SELECT
            station_id, slot, weekday,
            total_docks, available_bikes, available_docks, bike_ratio, dock_ratio,
            lag_30m_bikes, lag_30m_docks, lag_60m_bikes, lag_60m_docks,
            lag_120m_bikes, lag_120m_docks, lag_1d_bikes, lag_1d_docks,
            (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
            (available_docks - lag_30m_docks) AS momentum_docks_30m,
            {target_col} AS target
        FROM read_parquet('{FEATURES_PATH.as_posix()}')
        WHERE split = 'test' AND {target_col} IS NOT NULL
    """
    df = con.execute(query).df()
    df["station_id"] = df["station_id"].astype(categories["station_id"])
    df["slot"] = df["slot"].astype(categories["slot"])
    df["weekday"] = df["weekday"].astype(categories["weekday"])
    y = df.pop("target").astype(bool)
    return df[FEATURE_COLUMNS], y


def confusion(predicted, actual) -> dict:
    tp = int((predicted & actual).sum())
    fp = int((predicted & ~actual).sum())
    fn = int((~predicted & actual).sum())
    tn = int((~predicted & ~actual).sum())
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "predictionCount": tp + fp + fn + tn,
            "precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3)}


def main():
    thresholds = json.loads((OUTPUT_DIR / "selected_thresholds.json").read_text())
    con = duckdb.connect()
    categories = load_categories(con)

    results = {}
    for horizon in HORIZONS:
        threshold = thresholds[str(horizon)]["threshold"]
        X_test, y_test = load_test(con, horizon, categories)

        model = xgb.XGBClassifier()
        model.load_model(OUTPUT_DIR / f"model_{horizon}.json")
        proba = model.predict_proba(X_test)[:, 1]
        predicted = proba >= threshold

        result = confusion(predicted, y_test.to_numpy())
        result["threshold"] = threshold
        results[horizon] = result
        print(f"horizon={horizon}m threshold={threshold} n={result['predictionCount']:,} "
              f"precision={result['precision']} recall={result['recall']} f1={result['f1']}")

    (OUTPUT_DIR / "test_evaluation.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"saved {OUTPUT_DIR / 'test_evaluation.json'}")

    baseline = {30: (0.453, 0.403, 0.517), 60: (0.348, 0.284, 0.450), 120: (0.263, 0.222, 0.324)}
    print("\n--- vs rule baseline (F1 / Precision / Recall) ---")
    for horizon in HORIZONS:
        b_f1, b_p, b_r = baseline[horizon]
        r = results[horizon]
        print(f"{horizon}m: XGBoost {r['f1']:.3f}/{r['precision']:.3f}/{r['recall']:.3f} "
              f"vs baseline {b_f1:.3f}/{b_p:.3f}/{b_r:.3f} "
              f"(F1 {'+' if r['f1'] >= b_f1 else ''}{(r['f1'] - b_f1) * 100:.1f}pp)")


if __name__ == "__main__":
    main()
