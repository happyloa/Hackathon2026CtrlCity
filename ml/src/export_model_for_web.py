"""Exports model_30.json / model_60.json into a trimmed, web-consumable
format for client-side live inference (app/public/data/xgboost/), plus the
station_id category order the model was trained against -- a station's
integer category CODE (its rank in this sorted list) is what the tree splits
actually compare against, not the string id.

Only the arrays the tree-walker needs are kept (drops loss_changes,
sum_hessian, id, tree_param -- pure bookkeeping xgboost itself doesn't need
for prediction). Cuts model_60.json from ~a few MB to a smaller payload.

Usage:
    python ml/src/export_model_for_web.py
"""
from __future__ import annotations

import json
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
FEATURES_FILE = REPO_ROOT / "ml" / "data" / "features.parquet"
OUTPUT_DIR = REPO_ROOT / "ml" / "output"
WEB_DIR = REPO_ROOT / "app" / "public" / "data" / "xgboost"

HORIZONS = [30, 60]
TREE_KEYS = [
    "left_children", "right_children", "split_indices", "split_conditions",
    "split_type", "default_left", "base_weights",
    "categories", "categories_nodes", "categories_segments", "categories_sizes",
]


def trim_tree(tree: dict) -> dict:
    return {key: tree[key] for key in TREE_KEYS}


def main():
    con = duckdb.connect()
    all_station_ids = con.execute(
        f"SELECT DISTINCT station_id FROM read_parquet('{FEATURES_FILE.as_posix()}') ORDER BY station_id"
    ).df()["station_id"].tolist()

    WEB_DIR.mkdir(parents=True, exist_ok=True)
    (WEB_DIR / "station-categories.json").write_text(
        json.dumps(all_station_ids), encoding="utf-8",
    )
    print(f"Wrote {WEB_DIR / 'station-categories.json'} ({len(all_station_ids)} stations)")

    for horizon in HORIZONS:
        source = json.loads((OUTPUT_DIR / f"model_{horizon}.json").read_text(encoding="utf-8"))
        learner = source["learner"]
        trees_raw = learner["gradient_booster"]["model"]["trees"]

        trimmed = {
            "featureNames": learner["feature_names"],
            "trees": [trim_tree(tree) for tree in trees_raw],
        }
        out_path = WEB_DIR / f"model-{horizon}.json"
        out_path.write_text(json.dumps(trimmed, separators=(",", ":")), encoding="utf-8")
        size_kb = out_path.stat().st_size / 1024
        print(f"Wrote {out_path} ({len(trimmed['trees'])} trees, {size_kb:.0f} KB, "
              f"features={trimmed['featureNames']})")


if __name__ == "__main__":
    main()
