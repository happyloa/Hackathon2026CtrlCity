"""PoC pipeline step 2.5+3: clean.parquet -> features.parquet.

Builds lag features and +30/+60/+120-minute empty/full targets on the 30-min
grid already produced by clean.py. Uses DuckDB window functions (LAG/LEAD)
rather than self-joins for performance, with two correctness guards that are
easy to get wrong:

1. LAG(n)/LEAD(n) walk n *rows* back/forward within each station's timeline,
   not n*30 minutes. If a bucket is missing, row-distance and time-distance
   silently diverge — e.g. LAG(1) would return a reading from 90 minutes ago
   if the previous 30-min bucket has no data. Every lag/lead column is paired
   with its own bucket_at and checked against the exact expected offset;
   anything that doesn't line up is nulled out rather than treated as valid.
2. A target reading that is itself a suspected outage (is_operational=false)
   is not a real empty/full *event* — mirrors excludedUnavailableTarget in
   app/scripts/evaluate-forecast.mjs. This can only be checked once LEAD has
   already walked the full (unfiltered) timeline, so the is_operational
   filter for the *current* anchor row is applied last, after all lag/lead
   columns are computed over every row.

The historical station x weekday x slot profile the rule baseline uses is
deliberately NOT joined in here — that would need a train-period-only
aggregate to avoid leaking test-period data, and belongs with feature
selection/ablation once the model exists, not baked into every row.

Usage:
    python ml/src/features.py   (reads ml/data/clean.parquet)
"""
from __future__ import annotations

from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
INPUT_FILE = REPO_ROOT / "ml" / "data" / "clean.parquet"
OUTPUT_FILE = REPO_ROOT / "ml" / "data" / "features.parquet"

# Same boundaries as the frozen split in app/scripts/evaluate-forecast.mjs:
# Jan-Apr train, May pick the alert threshold, June held-out test.
SPLIT_CASE = """
    CASE
        WHEN bucket_at < TIMESTAMP '2026-05-01' THEN 'train'
        WHEN bucket_at < TIMESTAMP '2026-06-01' THEN 'validation'
        WHEN bucket_at < TIMESTAMP '2026-07-01' THEN 'test'
        ELSE NULL
    END
"""

# (label, rows back/forward, minutes)
LAGS = [("30m", 1, 30), ("60m", 2, 60), ("120m", 4, 120), ("1d", 48, 1440)]
TARGETS = [("30", 1, 30), ("60", 2, 60), ("120", 4, 120)]


def main() -> None:
    if not INPUT_FILE.exists():
        raise SystemExit(f"{INPUT_FILE} not found — run ml/src/clean.py first.")

    lag_columns = ",\n        ".join(
        f"LAG(bucket_at, {rows}) OVER w AS lag_{label}_at, "
        f"LAG(available_bikes, {rows}) OVER w AS lag_{label}_bikes, "
        f"LAG(available_docks, {rows}) OVER w AS lag_{label}_docks"
        for label, rows, _ in LAGS
    )
    lead_columns = ",\n        ".join(
        f"LEAD(bucket_at, {rows}) OVER w AS lead_{label}_at, "
        f"LEAD(available_bikes, {rows}) OVER w AS lead_{label}_bikes, "
        f"LEAD(available_docks, {rows}) OVER w AS lead_{label}_docks, "
        f"LEAD(is_operational, {rows}) OVER w AS lead_{label}_operational"
        for label, rows, _ in TARGETS
    )

    lag_select = ",\n    ".join(
        f"CASE WHEN lag_{label}_at = bucket_at - INTERVAL '{minutes} minutes' "
        f"THEN lag_{label}_bikes END AS lag_{label}_bikes,\n"
        f"    CASE WHEN lag_{label}_at = bucket_at - INTERVAL '{minutes} minutes' "
        f"THEN lag_{label}_docks END AS lag_{label}_docks"
        for label, _, minutes in LAGS
    )

    target_select_parts = []
    for label, _, minutes in TARGETS:
        valid = (
            f"lead_{label}_at = bucket_at + INTERVAL '{minutes} minutes' "
            f"AND lead_{label}_operational"
        )
        target_select_parts.append(
            f"CASE WHEN {valid} THEN (lead_{label}_bikes = 0) END AS target_{label}_empty,\n"
            f"    CASE WHEN {valid} THEN (lead_{label}_docks = 0) END AS target_{label}_full,\n"
            f"    CASE WHEN {valid} THEN (lead_{label}_bikes = 0 OR lead_{label}_docks = 0) "
            f"END AS target_{label}_issue"
        )
    target_select = ",\n    ".join(target_select_parts)

    duckdb.sql(f"""
        CREATE OR REPLACE TEMP TABLE windowed AS
        SELECT
            *,
            {lag_columns},
            {lead_columns}
        FROM read_parquet('{INPUT_FILE.as_posix()}')
        WINDOW w AS (PARTITION BY station_id ORDER BY bucket_at)
    """)

    duckdb.sql(f"""
        COPY (
            SELECT
                station_id, city, district, name,
                bucket_at, slot, weekday,
                {SPLIT_CASE} AS split,
                total_docks, available_bikes, available_docks,
                available_bikes::DOUBLE / NULLIF(total_docks, 0) AS bike_ratio,
                available_docks::DOUBLE / NULLIF(total_docks, 0) AS dock_ratio,
                {lag_select},
                {target_select}
            FROM windowed
            WHERE is_operational
              AND {SPLIT_CASE} IS NOT NULL
        ) TO '{OUTPUT_FILE.as_posix()}' (FORMAT PARQUET)
    """)

    stats = duckdb.sql(f"""
        SELECT split, count(*) AS rows,
               count(*) FILTER (target_60_issue) AS positives_60,
               round(100.0 * count(*) FILTER (target_60_issue) / count(*) FILTER (target_60_issue IS NOT NULL), 2) AS positive_rate_60
        FROM read_parquet('{OUTPUT_FILE.as_posix()}')
        GROUP BY split ORDER BY split
    """).fetchall()

    print(f"Wrote {OUTPUT_FILE}")
    for split, rows, positives, rate in stats:
        print(f"  {split:<12} rows={rows:>10,}  60-min positives={positives:>8,}  base_rate={rate}%")


if __name__ == "__main__":
    main()
