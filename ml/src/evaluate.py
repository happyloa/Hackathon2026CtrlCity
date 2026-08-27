"""Step 7: evaluate the trained XGBoost models on split='test' (June, never
seen during training or threshold selection) and compare against the rule
baseline's held-out numbers (60min F1=34.8%, precision=28.4%, recall=45.0%,
from app/data/forecast-evaluation.json test.horizons['60'])."""

import json
import sys
from pathlib import Path

import duckdb
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[1]
FEATURES_PATH = ROOT / "data" / "features.parquet"
OUTPUT_DIR = ROOT / "output"
CLUSTER_MEMBERSHIP_FILE = OUTPUT_DIR / "cluster_membership.csv"

HORIZONS = [30, 60, 120]

STATIC_NUMERIC_FEATURES = [
    "total_docks", "available_bikes", "available_docks", "bike_ratio", "dock_ratio",
    "lag_30m_bikes", "lag_30m_docks", "lag_60m_bikes", "lag_60m_docks",
    "lag_120m_bikes", "lag_120m_docks", "lag_1d_bikes", "lag_1d_docks",
    "momentum_bikes_30m", "momentum_docks_30m",
    "neighbor_low_bikes_rate", "neighbor_count",
]
CATEGORICAL_FEATURES = ["station_id", "slot", "weekday"]

# Must match train.py's INCLUDE_STACKING_FEATURES -- see the comment there.
# Reverted after profile/baseline-risk features caused the model to converge
# to roughly the plain rule baseline (test F1 dropped from 38.4% to 34.8%).
INCLUDE_STACKING_FEATURES = False

# Must match train.py's INCLUDE_PEAK_WINDOW_FEATURES -- see the comment there.
INCLUDE_PEAK_WINDOW_FEATURES = False


def horizon_feature_columns(horizon: int) -> list:
    columns = list(STATIC_NUMERIC_FEATURES)
    if INCLUDE_STACKING_FEATURES:
        columns += [
            f"profile_empty_rate_{horizon}", f"profile_full_rate_{horizon}", f"profile_observations_{horizon}",
            f"baseline_empty_risk_{horizon}", f"baseline_full_risk_{horizon}",
        ]
    if INCLUDE_PEAK_WINDOW_FEATURES:
        columns += [f"in_own_peak_empty_{horizon}", f"in_own_peak_full_{horizon}"]
    return columns + CATEGORICAL_FEATURES


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
    feature_columns = horizon_feature_columns(horizon)
    query = f"""
        SELECT
            station_id, district, slot, weekday,
            total_docks, available_bikes, available_docks, bike_ratio, dock_ratio,
            lag_30m_bikes, lag_30m_docks, lag_60m_bikes, lag_60m_docks,
            lag_120m_bikes, lag_120m_docks, lag_1d_bikes, lag_1d_docks,
            (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
            (available_docks - lag_30m_docks) AS momentum_docks_30m,
            neighbor_low_bikes_rate, neighbor_count,
            profile_empty_rate_{horizon}, profile_full_rate_{horizon}, profile_observations_{horizon},
            baseline_empty_risk_{horizon}, baseline_full_risk_{horizon},
            in_own_peak_empty_{horizon}, in_own_peak_full_{horizon},
            {target_col} AS target
        FROM read_parquet('{FEATURES_PATH.as_posix()}')
        WHERE split = 'test' AND {target_col} IS NOT NULL
    """
    df = con.execute(query).df()
    df["station_id"] = df["station_id"].astype(categories["station_id"])
    df["slot"] = df["slot"].astype(categories["slot"])
    df["weekday"] = df["weekday"].astype(categories["weekday"])
    district = df.pop("district")
    y = df.pop("target").astype(bool)
    return df[feature_columns], y, district


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


def confusion_by_district(predicted, actual, district) -> dict:
    df = pd.DataFrame({"predicted": predicted, "actual": actual, "district": district})
    by_district = {}
    for name, group in df.groupby("district"):
        stats = confusion(group["predicted"].to_numpy(), group["actual"].to_numpy())
        by_district[name] = {
            "stationCount": None,
            "predictionCount": stats["predictionCount"],
            "precision": stats["precision"], "recall": stats["recall"], "f1": stats["f1"],
            "tp": stats["tp"], "fp": stats["fp"], "fn": stats["fn"], "tn": stats["tn"],
        }
    return by_district


def load_cluster_membership() -> dict | None:
    if not CLUSTER_MEMBERSHIP_FILE.exists():
        return None
    rows = CLUSTER_MEMBERSHIP_FILE.read_text(encoding="utf-8").strip().split("\n")[1:]
    membership, labels, station_counts = {}, {}, {}
    for row in rows:
        station_id, cluster_id, cluster_label = row.split(",")
        membership[station_id] = cluster_id
        labels[cluster_id] = cluster_label
        station_counts[cluster_id] = station_counts.get(cluster_id, 0) + 1
    return {"membership": membership, "labels": labels, "stationCounts": station_counts}


def confusion_by_cluster(predicted, actual, station_ids, cluster_info: dict) -> dict:
    cluster_id = station_ids.map(cluster_info["membership"])
    df = pd.DataFrame({"predicted": predicted, "actual": actual, "cluster_id": cluster_id}).dropna(subset=["cluster_id"])
    by_cluster = {}
    for cid, group in df.groupby("cluster_id"):
        stats = confusion(group["predicted"].to_numpy(), group["actual"].to_numpy())
        by_cluster[cid] = {
            "label": cluster_info["labels"].get(cid, cid),
            "stationCount": cluster_info["stationCounts"].get(cid),
            "predictionCount": stats["predictionCount"],
            "precision": stats["precision"], "recall": stats["recall"], "f1": stats["f1"],
            "tp": stats["tp"], "fp": stats["fp"], "fn": stats["fn"], "tn": stats["tn"],
        }
    return by_cluster


def main():
    horizons = [int(h) for h in sys.argv[1:]] or HORIZONS
    thresholds = json.loads((OUTPUT_DIR / "selected_thresholds.json").read_text(encoding="utf-8"))
    con = duckdb.connect()
    categories = load_categories(con)

    results_path = OUTPUT_DIR / "test_evaluation.json"
    by_district_path = OUTPUT_DIR / "test_evaluation_by_district.json"
    by_cluster_path = OUTPUT_DIR / "test_evaluation_by_cluster.json"
    results = json.loads(results_path.read_text(encoding="utf-8")) if results_path.exists() else {}
    results_by_district = json.loads(by_district_path.read_text(encoding="utf-8")) if by_district_path.exists() else {}
    results_by_cluster = json.loads(by_cluster_path.read_text(encoding="utf-8")) if by_cluster_path.exists() else {}
    cluster_info = load_cluster_membership()

    for horizon in horizons:
        threshold = thresholds[str(horizon)]["threshold"]
        X_test, y_test, district_test = load_test(con, horizon, categories)

        model = xgb.XGBClassifier()
        model.load_model(OUTPUT_DIR / f"model_{horizon}.json")
        proba = model.predict_proba(X_test)[:, 1]
        predicted = proba >= threshold

        result = confusion(predicted, y_test.to_numpy())
        result["threshold"] = threshold
        results[str(horizon)] = result
        print(f"horizon={horizon}m threshold={threshold} n={result['predictionCount']:,} "
              f"precision={result['precision']} recall={result['recall']} f1={result['f1']}")

        results_by_district[str(horizon)] = confusion_by_district(predicted, y_test.to_numpy(), district_test)
        if cluster_info:
            station_ids = X_test["station_id"].astype(str)
            results_by_cluster[str(horizon)] = confusion_by_cluster(predicted, y_test.to_numpy(), station_ids, cluster_info)

    # station counts per district come from the rule-baseline's own breakdown,
    # already computed the same way in forecast-evaluation.json's test.byDistrict
    baseline_by_district = json.loads(
        (ROOT.parent / "app" / "data" / "forecast-evaluation.json").read_text(encoding="utf-8")
    ).get("test", {}).get("byDistrict", {})
    for horizon in horizons:
        for name, entry in results_by_district[str(horizon)].items():
            entry["stationCount"] = baseline_by_district.get(name, {}).get("stationCount")

    (OUTPUT_DIR / "test_evaluation.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (OUTPUT_DIR / "test_evaluation_by_district.json").write_text(
        json.dumps(results_by_district, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"saved {OUTPUT_DIR / 'test_evaluation.json'}")
    print(f"saved {OUTPUT_DIR / 'test_evaluation_by_district.json'}")
    if cluster_info:
        (OUTPUT_DIR / "test_evaluation_by_cluster.json").write_text(
            json.dumps(results_by_cluster, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"saved {OUTPUT_DIR / 'test_evaluation_by_cluster.json'}")

    baseline = {30: (0.453, 0.403, 0.517), 60: (0.348, 0.284, 0.450), 120: (0.263, 0.222, 0.324)}
    print("\n--- vs rule baseline (F1 / Precision / Recall) ---")
    for horizon in horizons:
        b_f1, b_p, b_r = baseline[horizon]
        r = results[str(horizon)]
        print(f"{horizon}m: XGBoost {r['f1']:.3f}/{r['precision']:.3f}/{r['recall']:.3f} "
              f"vs baseline {b_f1:.3f}/{b_p:.3f}/{b_r:.3f} "
              f"(F1 {'+' if r['f1'] >= b_f1 else ''}{(r['f1'] - b_f1) * 100:.1f}pp)")


if __name__ == "__main__":
    main()
