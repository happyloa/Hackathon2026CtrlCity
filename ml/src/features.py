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

The historical station x weekday x slot profile the rule baseline uses IS
joined in here (profile_empty_rate_{h}/profile_full_rate_{h}/
profile_observations_{h} per horizon) -- sourced from
ml/output/station-time-profile-train.csv, which is already Jan-Apr only
(same boundary as SPLIT_CASE below), so there is no leakage: every row's
profile lookup only ever sees train-period statistics, regardless of which
split that row itself belongs to. The lookup key is the TARGET slot
(bucket_at + horizon), matching forecastRisk()'s targetSlot in
evaluate-forecast.mjs, not the anchor row's own slot.

Usage:
    python ml/src/features.py   (reads ml/data/clean.parquet)
"""
from __future__ import annotations

from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
INPUT_FILE = REPO_ROOT / "ml" / "data" / "clean.parquet"
OUTPUT_FILE = REPO_ROOT / "ml" / "data" / "features.parquet"
NEIGHBORS_FILE = REPO_ROOT / "ml" / "output" / "neighbors.csv"
PROFILE_FILE = REPO_ROOT / "ml" / "output" / "station-time-profile-train.csv"
PEAK_WINDOWS_FILE = REPO_ROOT / "ml" / "output" / "station_peak_windows.csv"

# Must match the bucket boundaries in build_station_peaks.py exactly.
TIME_BUCKET_CASE = """
    CASE
        WHEN {slot_expr} < 12 THEN 'overnight'
        WHEN {slot_expr} < 18 THEN 'am_commute'
        WHEN {slot_expr} < 24 THEN 'am_offpeak'
        WHEN {slot_expr} < 28 THEN 'midday'
        WHEN {slot_expr} < 34 THEN 'afternoon'
        WHEN {slot_expr} < 40 THEN 'pm_peak'
        ELSE 'evening'
    END
"""

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
    if not NEIGHBORS_FILE.exists():
        raise SystemExit(f"{NEIGHBORS_FILE} not found — run ml/src/build_neighbors.py first.")
    if not PROFILE_FILE.exists():
        raise SystemExit(f"{PROFILE_FILE} not found — run `npm run data:profile` (or the underlying "
                          f"station-time-profile.mjs) in app/ first.")
    if not PEAK_WINDOWS_FILE.exists():
        raise SystemExit(f"{PEAK_WINDOWS_FILE} not found — run ml/src/build_station_peaks.py first.")

    # Per-station characteristic peak window (discrete, one of 7 time-of-day
    # buckets, train-period only, separate for workday vs weekend) -- see
    # build_station_peaks.py's module docstring for why this is a different,
    # deliberately weaker signal than the reverted profile_empty_rate.
    duckdb.sql(f"""
        CREATE OR REPLACE TEMP TABLE station_peaks AS
        SELECT * FROM read_csv('{PEAK_WINDOWS_FILE.as_posix()}', ALL_VARCHAR=TRUE)
    """)

    # Train-period station x weekday x slot profile, keyed by the TARGET
    # time for each horizon (not the anchor row's own time) -- this is
    # exactly what the rule baseline's forecastRisk() looks up. Read as
    # VARCHAR + TRY_CAST like clean.py, since a stray malformed row in the
    # upstream CSV should not abort the whole load.
    duckdb.sql(f"""
        CREATE OR REPLACE TEMP TABLE profile AS
        SELECT
            stationId AS station_id,
            TRY_CAST(weekday AS INTEGER) AS weekday,
            TRY_CAST(slot AS INTEGER) AS slot,
            TRY_CAST(observations AS INTEGER) AS observations,
            TRY_CAST(emptyRate AS DOUBLE) AS empty_rate,
            TRY_CAST(fullRate AS DOUBLE) AS full_rate
        FROM read_csv('{PROFILE_FILE.as_posix()}', ALL_VARCHAR=TRUE)
    """)

    # Neighbor bike-shortage feature: what fraction of a station's 300m
    # neighbors are ALSO low on bikes at the same bucket_at. Contemporaneous,
    # not future info, so this carries no leakage risk despite being an
    # aggregate over other stations' readings. Threshold matches the
    # low_bikes definition already used elsewhere (station-time-profile.mjs,
    # evaluate-forecast.mjs's forecastRisk): max(2, ceil(total_docks*0.1)).
    # Dock-fullness has no such feature -- the per-district XGBoost breakdown
    # already showed bike shortage is spatially correlated (within-cluster
    # pairwise match 51.5% vs 22.6% random) while dock fullness is not
    # (14.8% vs 15.7%, i.e. no signal), so adding a neighbor-dock-full
    # feature would likely just be noise.
    duckdb.sql(f"""
        CREATE OR REPLACE TEMP TABLE neighbors AS
        SELECT * FROM read_csv('{NEIGHBORS_FILE.as_posix()}')
    """)
    duckdb.sql(f"""
        CREATE OR REPLACE TEMP TABLE low_flag AS
        SELECT station_id, bucket_at, is_operational,
               (available_bikes <= GREATEST(2, CEIL(total_docks * 0.1)))::INT AS is_low_bikes
        FROM read_parquet('{INPUT_FILE.as_posix()}')
    """)
    duckdb.sql("""
        CREATE OR REPLACE TEMP TABLE neighbor_agg AS
        SELECT n.station_id, lf.bucket_at,
               AVG(lf.is_low_bikes) AS neighbor_low_bikes_rate,
               COUNT(*) AS neighbor_count
        FROM neighbors n
        JOIN low_flag lf ON lf.station_id = n.neighbor_id AND lf.is_operational
        GROUP BY n.station_id, lf.bucket_at
    """)

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
        f"CASE WHEN lag_{label}_at = feat.bucket_at - INTERVAL '{minutes} minutes' "
        f"THEN lag_{label}_bikes END AS lag_{label}_bikes,\n"
        f"    CASE WHEN lag_{label}_at = feat.bucket_at - INTERVAL '{minutes} minutes' "
        f"THEN lag_{label}_docks END AS lag_{label}_docks"
        for label, _, minutes in LAGS
    )

    target_select_parts = []
    for label, _, minutes in TARGETS:
        valid = (
            f"lead_{label}_at = feat.bucket_at + INTERVAL '{minutes} minutes' "
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

    # Per-horizon profile lookup: the profile at the TARGET slot (bucket_at +
    # horizon), same key forecastRisk() uses for targetSlot in
    # evaluate-forecast.mjs -- not the anchor row's own weekday/slot.
    profile_joins = "\n            ".join(
        f"LEFT JOIN profile p{label} ON p{label}.station_id = feat.station_id "
        f"AND p{label}.weekday = dayofweek(feat.bucket_at + INTERVAL '{minutes} minutes') "
        f"AND p{label}.slot = hour(feat.bucket_at + INTERVAL '{minutes} minutes') * 2 "
        f"+ (minute(feat.bucket_at + INTERVAL '{minutes} minutes') // 30)"
        for label, _, minutes in TARGETS
    )
    profile_select = ",\n                ".join(
        f"p{label}.empty_rate AS profile_empty_rate_{label}, "
        f"p{label}.full_rate AS profile_full_rate_{label}, "
        f"p{label}.observations AS profile_observations_{label}"
        for label, _, _ in TARGETS
    )

    def peak_columns_for(label: str, minutes: int) -> str:
        target_expr = f"(feat.bucket_at + INTERVAL '{minutes} minutes')"
        is_workday_expr = f"(dayofweek({target_expr}) BETWEEN 1 AND 5)"
        slot_expr = f"(hour({target_expr}) * 2 + (minute({target_expr}) // 30))"
        bucket_expr = TIME_BUCKET_CASE.format(slot_expr=slot_expr)
        return (
            f"CASE WHEN {is_workday_expr} THEN ({bucket_expr} = sp.workday_peak_empty) "
            f"ELSE ({bucket_expr} = sp.weekend_peak_empty) END AS in_own_peak_empty_{label},\n"
            f"                CASE WHEN {is_workday_expr} THEN ({bucket_expr} = sp.workday_peak_full) "
            f"ELSE ({bucket_expr} = sp.weekend_peak_full) END AS in_own_peak_full_{label}"
        )

    peak_select = ",\n                ".join(peak_columns_for(label, minutes) for label, _, minutes in TARGETS)

    duckdb.sql(f"""
        COPY (
            WITH feat_rows AS (
                SELECT
                    feat.station_id, feat.city, feat.district, feat.name,
                    feat.bucket_at, feat.slot, feat.weekday,
                    {SPLIT_CASE.replace('bucket_at', 'feat.bucket_at')} AS split,
                    feat.total_docks, feat.available_bikes, feat.available_docks,
                    feat.available_bikes::DOUBLE / NULLIF(feat.total_docks, 0) AS bike_ratio,
                    feat.available_docks::DOUBLE / NULLIF(feat.total_docks, 0) AS dock_ratio,
                    na.neighbor_low_bikes_rate, na.neighbor_count,
                    {profile_select},
                    {peak_select},
                    {lag_select},
                    {target_select}
                FROM windowed feat
                LEFT JOIN neighbor_agg na ON na.station_id = feat.station_id AND na.bucket_at = feat.bucket_at
                LEFT JOIN station_peaks sp ON sp.station_id = feat.station_id
                {profile_joins}
                WHERE feat.is_operational
                  AND {SPLIT_CASE.replace('bucket_at', 'feat.bucket_at')} IS NOT NULL
            )
            -- Stacking feature: the rule baseline's own composite risk score
            -- (forecastRisk() in evaluate-forecast.mjs), reconstructed from
            -- the profile + current-state + momentum columns above. Lets the
            -- model learn "when is the baseline trustworthy" as a correction
            -- on top of an existing signal, rather than re-deriving the same
            -- historical pattern from scratch via lag/momentum alone.
            SELECT *,
                (available_bikes - lag_30m_bikes) AS momentum_bikes_30m,
                (available_docks - lag_30m_docks) AS momentum_docks_30m,
                LEAST(1, GREATEST(0,
                    COALESCE(profile_empty_rate_30, 0) * 0.7
                    + CASE WHEN available_bikes = 0 THEN 0.48
                           WHEN available_bikes <= GREATEST(2, CEIL(total_docks * 0.1)) OR bike_ratio <= 0.1 THEN 0.25
                           ELSE 0 END
                    + CASE WHEN COALESCE(available_bikes - lag_30m_bikes, 0) < 0
                           THEN LEAST(0.12, ABS(available_bikes - lag_30m_bikes)::DOUBLE / GREATEST(1, total_docks))
                           ELSE 0 END
                )) AS baseline_empty_risk_30,
                LEAST(1, GREATEST(0,
                    COALESCE(profile_full_rate_30, 0) * 0.7
                    + CASE WHEN available_docks = 0 THEN 0.48
                           WHEN available_docks <= GREATEST(2, CEIL(total_docks * 0.1)) OR dock_ratio <= 0.1 THEN 0.25
                           ELSE 0 END
                    + CASE WHEN COALESCE(available_docks - lag_30m_docks, 0) < 0
                           THEN LEAST(0.12, ABS(available_docks - lag_30m_docks)::DOUBLE / GREATEST(1, total_docks))
                           ELSE 0 END
                )) AS baseline_full_risk_30,
                LEAST(1, GREATEST(0,
                    COALESCE(profile_empty_rate_60, 0) * 0.7
                    + CASE WHEN available_bikes = 0 THEN 0.48
                           WHEN available_bikes <= GREATEST(2, CEIL(total_docks * 0.1)) OR bike_ratio <= 0.1 THEN 0.25
                           ELSE 0 END
                    + CASE WHEN COALESCE(available_bikes - lag_30m_bikes, 0) < 0
                           THEN LEAST(0.12, ABS(available_bikes - lag_30m_bikes)::DOUBLE / GREATEST(1, total_docks))
                           ELSE 0 END
                )) AS baseline_empty_risk_60,
                LEAST(1, GREATEST(0,
                    COALESCE(profile_full_rate_60, 0) * 0.7
                    + CASE WHEN available_docks = 0 THEN 0.48
                           WHEN available_docks <= GREATEST(2, CEIL(total_docks * 0.1)) OR dock_ratio <= 0.1 THEN 0.25
                           ELSE 0 END
                    + CASE WHEN COALESCE(available_docks - lag_30m_docks, 0) < 0
                           THEN LEAST(0.12, ABS(available_docks - lag_30m_docks)::DOUBLE / GREATEST(1, total_docks))
                           ELSE 0 END
                )) AS baseline_full_risk_60,
                LEAST(1, GREATEST(0,
                    COALESCE(profile_empty_rate_120, 0) * 0.7
                    + CASE WHEN available_bikes = 0 THEN 0.48
                           WHEN available_bikes <= GREATEST(2, CEIL(total_docks * 0.1)) OR bike_ratio <= 0.1 THEN 0.25
                           ELSE 0 END
                    + CASE WHEN COALESCE(available_bikes - lag_30m_bikes, 0) < 0
                           THEN LEAST(0.12, ABS(available_bikes - lag_30m_bikes)::DOUBLE / GREATEST(1, total_docks))
                           ELSE 0 END
                )) AS baseline_empty_risk_120,
                LEAST(1, GREATEST(0,
                    COALESCE(profile_full_rate_120, 0) * 0.7
                    + CASE WHEN available_docks = 0 THEN 0.48
                           WHEN available_docks <= GREATEST(2, CEIL(total_docks * 0.1)) OR dock_ratio <= 0.1 THEN 0.25
                           ELSE 0 END
                    + CASE WHEN COALESCE(available_docks - lag_30m_docks, 0) < 0
                           THEN LEAST(0.12, ABS(available_docks - lag_30m_docks)::DOUBLE / GREATEST(1, total_docks))
                           ELSE 0 END
                )) AS baseline_full_risk_120
            FROM feat_rows
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
