"""Step 5: train XGBoost models on split='train' (Jan-Apr) only.

One binary classifier per horizon (30/60/120 min), predicting target_{h}_issue
(empty OR full at that horizon) to match the rule baseline's combined metric
in evaluate-forecast.mjs. Validation (May) is used only for early stopping
here -- threshold selection on validation happens separately in Step 6.
"""

import json
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[1]
FEATURES_PATH = ROOT / "data" / "features.parquet"
OUTPUT_DIR = ROOT / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

HORIZONS = [30, 60, 120]

NUMERIC_FEATURES = [
    "total_docks",
    "available_bikes",
    "available_docks",
    "bike_ratio",
    "dock_ratio",
    "lag_30m_bikes",
    "lag_30m_docks",
    "lag_60m_bikes",
    "lag_60m_docks",
    "lag_120m_bikes",
    "lag_120m_docks",
    "lag_1d_bikes",
    "lag_1d_docks",
    "momentum_bikes_30m",
    "momentum_docks_30m",
]
CATEGORICAL_FEATURES = ["station_id", "slot", "weekday"]
FEATURE_COLUMNS = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def load_categories(con: duckdb.DuckDBPyConnection) -> dict:
    """Fixed category sets so train/validation/test dataframes share identical
    dtypes -- otherwise a station_id seen only in validation crashes XGBoost's
    categorical encoder (it treats each dataframe's categories independently)."""
    station_ids = con.execute(
        f"SELECT DISTINCT station_id FROM read_parquet('{FEATURES_PATH.as_posix()}') ORDER BY station_id"
    ).df()["station_id"].tolist()
    return {
        "station_id": pd.CategoricalDtype(categories=station_ids),
        "slot": pd.CategoricalDtype(categories=list(range(48))),
        "weekday": pd.CategoricalDtype(categories=list(range(7))),
    }


def load_split(con: duckdb.DuckDBPyConnection, split: str, horizon: int, categories: dict):
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
        WHERE split = '{split}' AND {target_col} IS NOT NULL
    """
    df = con.execute(query).df()
    df["station_id"] = df["station_id"].astype(categories["station_id"])
    df["slot"] = df["slot"].astype(categories["slot"])
    df["weekday"] = df["weekday"].astype(categories["weekday"])
    y = df.pop("target").astype(int)
    return df[FEATURE_COLUMNS], y


def train_horizon(con: duckdb.DuckDBPyConnection, horizon: int, categories: dict) -> None:
    print(f"\n=== horizon {horizon}m ===")
    X_train, y_train = load_split(con, "train", horizon, categories)
    X_val, y_val = load_split(con, "validation", horizon, categories)
    print(f"train rows={len(X_train):,} pos_rate={y_train.mean():.4f}")
    print(f"val   rows={len(X_val):,} pos_rate={y_val.mean():.4f}")

    scale_pos_weight = (1 - y_train.mean()) / y_train.mean()

    model = xgb.XGBClassifier(
        objective="binary:logistic",
        eval_metric="aucpr",
        tree_method="hist",
        enable_categorical=True,
        n_estimators=4000,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        scale_pos_weight=scale_pos_weight,
        early_stopping_rounds=50,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(
        X_train,
        y_train,
        eval_set=[(X_val, y_val)],
        verbose=50,
    )

    best_iteration = model.best_iteration
    val_proba = model.predict_proba(X_val, iteration_range=(0, best_iteration + 1))[:, 1]
    val_aucpr = model.best_score
    print(f"best_iteration={best_iteration} val_aucpr={val_aucpr:.4f}")

    model_path = OUTPUT_DIR / f"model_{horizon}.json"
    model.save_model(model_path)

    importance = model.get_booster().get_score(importance_type="gain")
    importance_sorted = dict(sorted(importance.items(), key=lambda kv: kv[1], reverse=True))
    (OUTPUT_DIR / f"feature_importance_{horizon}.json").write_text(
        json.dumps(importance_sorted, indent=2, ensure_ascii=False)
    )

    np.save(OUTPUT_DIR / f"val_proba_{horizon}.npy", val_proba)
    np.save(OUTPUT_DIR / f"val_target_{horizon}.npy", y_val.to_numpy())

    print(f"saved {model_path.name}, feature_importance_{horizon}.json, val_proba/target_{horizon}.npy")


def main():
    horizons = [int(h) for h in sys.argv[1:]] or HORIZONS
    con = duckdb.connect()
    categories = load_categories(con)
    for horizon in horizons:
        train_horizon(con, horizon, categories)


if __name__ == "__main__":
    main()
