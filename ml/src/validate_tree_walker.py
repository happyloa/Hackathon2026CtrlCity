"""Validates a from-scratch tree-walking prediction (the algorithm about to
be ported to JS for client-side live inference) against xgboost's own
predict_proba, on real rows from the test split. This nails down exactly how
numeric splits, categorical splits, and missing-value routing work in the
raw JSON model dump BEFORE writing the JS port -- getting this wrong client
side would silently produce wrong live risk scores with no way to notice.

Usage:
    python ml/src/validate_tree_walker.py [horizon]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import xgboost as xgb

REPO_ROOT = Path(__file__).resolve().parents[2]
FEATURES_FILE = REPO_ROOT / "ml" / "data" / "features.parquet"
OUTPUT_DIR = REPO_ROOT / "ml" / "output"

MISSING = float("nan")


def load_model_dict(horizon: int) -> dict:
    return json.loads((OUTPUT_DIR / f"model_{horizon}.json").read_text(encoding="utf-8"))


def predict_one(trees: list[dict], feature_row: list[float]) -> float:
    """feature_row is positional, matching learner.feature_names order.
    Categorical features (station_id/slot/weekday) must already be encoded
    as their integer category CODE (0-indexed rank within the training-time
    category list), matching what pandas Categorical.cat.codes produced."""
    margin = 0.0
    for tree in trees:
        node = 0
        while True:
            left = tree["left_children"][node]
            right = tree["right_children"][node]
            if left == -1:  # leaf
                margin += tree["base_weights"][node]
                break

            feature_index = tree["split_indices"][node]
            value = feature_row[feature_index]
            split_type = tree["split_type"][node]

            if value is None or (isinstance(value, float) and math.isnan(value)):
                node = left if tree["default_left"][node] else right
                continue

            if split_type == 0:  # numeric: go left if value < condition
                condition = tree["split_conditions"][node]
                node = left if value < condition else right
            else:  # categorical: go left if value's category code is in this node's category list
                cat_index = tree["categories_nodes"].index(node) if node in tree["categories_nodes"] else None
                if cat_index is None:
                    node = right  # no category list recorded -> treat as no match
                    continue
                start = tree["categories_segments"][cat_index]
                size = tree["categories_sizes"][cat_index]
                cats = tree["categories"][start:start + size]
                node = right if int(value) in cats else left
    return 1.0 / (1.0 + math.exp(-margin))


def main():
    horizon = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    model_dict = load_model_dict(horizon)
    learner = model_dict["learner"]
    feature_names = learner["feature_names"]
    trees_raw = learner["gradient_booster"]["model"]["trees"]

    # Pre-index each tree's category-node list into a plain list once, so
    # predict_one's `.index(...)` calls above aren't O(n) per lookup in the
    # real port -- fine for this one-off validation script's small sample.
    trees = trees_raw

    con = duckdb.connect()
    all_station_ids = con.execute(
        f"SELECT DISTINCT station_id FROM read_parquet('{FEATURES_FILE.as_posix()}') ORDER BY station_id"
    ).df()["station_id"].tolist()
    station_code = {sid: i for i, sid in enumerate(all_station_ids)}

    sample = con.execute(f"""
        SELECT station_id, slot, weekday,
            total_docks, available_bikes, available_docks, bike_ratio, dock_ratio,
            lag_30m_bikes, lag_30m_docks, lag_60m_bikes, lag_60m_docks,
            lag_120m_bikes, lag_120m_docks, lag_1d_bikes, lag_1d_docks,
            (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
            (available_docks - lag_30m_docks) AS momentum_docks_30m,
            neighbor_low_bikes_rate, neighbor_count
        FROM read_parquet('{FEATURES_FILE.as_posix()}')
        WHERE split = 'test' AND target_{horizon}_issue IS NOT NULL
        USING SAMPLE 500
    """).df()

    categories = {
        "station_id": pd.CategoricalDtype(categories=all_station_ids),
        "slot": pd.CategoricalDtype(categories=list(range(48))),
        "weekday": pd.CategoricalDtype(categories=list(range(7))),
    }
    xgb_input = sample.copy()
    xgb_input["station_id"] = xgb_input["station_id"].astype(categories["station_id"])
    xgb_input["slot"] = xgb_input["slot"].astype(categories["slot"])
    xgb_input["weekday"] = xgb_input["weekday"].astype(categories["weekday"])
    xgb_input = xgb_input[feature_names]

    model = xgb.XGBClassifier()
    model.load_model(str(OUTPUT_DIR / f"model_{horizon}.json"))
    official = model.predict_proba(xgb_input)[:, 1]

    manual = []
    for _, row in sample.iterrows():
        feature_row = []
        for name in feature_names:
            if name == "station_id":
                feature_row.append(float(station_code[row["station_id"]]))
            elif name in ("slot", "weekday"):
                feature_row.append(float(row[name]))
            else:
                value = row[name]
                feature_row.append(MISSING if pd.isna(value) else float(value))
        manual.append(predict_one(trees, feature_row))
    manual = np.array(manual)

    diff = np.abs(manual - official)
    print(f"horizon={horizon} n={len(sample)} max_diff={diff.max():.8f} mean_diff={diff.mean():.8f}")
    print(f"manual[:5]  = {manual[:5]}")
    print(f"official[:5]= {official[:5]}")
    if diff.max() < 1e-6:
        print("MATCH: tree-walking algorithm is correct, safe to port to JS.")
    else:
        print("MISMATCH: algorithm needs fixing before porting to JS.")


if __name__ == "__main__":
    main()
