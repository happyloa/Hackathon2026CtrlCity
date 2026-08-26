"""PoC pipeline step 1+2: raw CSV -> clean.parquet with an is_operational flag.

Mirrors the encoding, station-identity and exclusion logic already validated in
the Node.js pipeline (app/scripts/evaluate-forecast.mjs, build-artifacts.mjs)
so station ids and inclusion decisions match exactly across both stacks:

- Encoding: 4 files are UTF-8 (one with no BOM and no leading quote, so
  autodetecting from those markers alone is wrong), 8 are CP950/Big5. DuckDB
  1.5.5 cannot read the Big5 files directly — it misparses CRLF as a bare
  \\r in that code path and leaks a byte into the next record. Every file is
  decoded to UTF-8 on disk first so DuckDB only ever sees one encoding.
- Station identity: st_<sha256(city|district|canonical_name)[:14]>, verified
  byte-for-byte identical between DuckDB's sha256() and Node's crypto hash.
  Text normalization (NFKC, BOM strip, whitespace collapse) runs once per
  DISTINCT (city, district, name) triple — a few thousand rows, cheap in
  Python — then joins back onto the full ~13M-row table in SQL, so the only
  work that touches every row runs inside DuckDB, not a Python loop.
- Timestamps: parsed as naive (no real timezone conversion), matching
  parseLocalTimestamp() in the JS pipeline, so weekday/slot never shift with
  the host machine's time zone. DuckDB's dayofweek() already returns
  0=Sunday, matching JS's getUTCDay().
- is_operational excludes two kinds of rows: a double-zero snapshot
  (bikes=0 AND docks=0, a suspected outage) at that exact reading, and any
  row inside an operator-declared adjustment window
  (operational-adjustments.json) — the 38 long-frozen/suspended stations
  found by app/scripts/detect-frozen-stations.mjs and confirmed against the
  official site. Rows are kept with the flag set to false rather than
  dropped, so downstream steps can still audit them.

Usage:
    CTRL_CITY_DATASET_DIR=<path to the CSV folder> python ml/src/clean.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
APP_DIR = REPO_ROOT / "app"
DATASET_DIR = Path(os.environ.get("CTRL_CITY_DATASET_DIR", APP_DIR / "docs" / "資料集"))
ALIAS_FILE = APP_DIR / "scripts" / "station-aliases.json"
ADJUSTMENTS_FILE = APP_DIR / "data" / "operational-adjustments.json"
OUTPUT_DIR = REPO_ROOT / "ml" / "data"
NORMALIZED_DIR = OUTPUT_DIR / "_normalized_csv"
OUTPUT_FILE = OUTPUT_DIR / "clean.parquet"

TIMESTAMP_FORMATS = ["%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M:%S"]


def normalize_text(value: object) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFKC", text).lstrip("﻿").strip()
    return re.sub(r"\s+", " ", text)


def detect_encoding(path: Path) -> str:
    with path.open("rb") as handle:
        head = handle.read(4096)
    if head[:3] == b"\xef\xbb\xbf":
        return "utf-8-sig"
    line_end = head.find(b"\n")
    sample = head if line_end < 0 else head[: line_end + 1]
    try:
        sample.decode("utf-8", errors="strict")
        return "utf-8"
    except UnicodeDecodeError:
        return "cp950"


def normalize_csv_to_utf8(source: Path, destination_dir: Path) -> tuple[Path, str]:
    encoding = detect_encoding(source)
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{source.stem}.utf8.csv"
    with source.open("r", encoding=encoding, newline="") as reader, \
            destination.open("w", encoding="utf-8", newline="") as writer:
        for line in reader:
            writer.write(line)
    return destination, encoding


def load_aliases() -> dict[str, str]:
    raw = json.loads(ALIAS_FILE.read_text(encoding="utf-8"))
    return {normalize_text(k): normalize_text(v) for k, v in raw.items()}


def load_adjustment_windows() -> list[dict]:
    if not ADJUSTMENTS_FILE.exists():
        return []
    raw = json.loads(ADJUSTMENTS_FILE.read_text(encoding="utf-8"))
    windows = []
    for item in raw.get("adjustments", []):
        station_id, start_at = item.get("stationId"), item.get("startAt")
        if not station_id or not start_at:
            continue
        windows.append({
            "station_id": station_id,
            "start_at": start_at.replace("T", " ") + ":00",
            # A null endAt means "still suspended when the dataset ends";
            # far-future is simpler in SQL than a nullable open-ended BETWEEN.
            "end_at": (item["endAt"].replace("T", " ") + ":00") if item.get("endAt") else "9999-12-31 00:00:00",
        })
    return windows


def main() -> None:
    if not DATASET_DIR.exists():
        raise SystemExit(f"Dataset directory not found: {DATASET_DIR}")
    source_files = sorted(DATASET_DIR.glob("*.csv"))
    if not source_files:
        raise SystemExit(f"No CSV files found in {DATASET_DIR}")

    print(f"Normalizing {len(source_files)} source files to UTF-8...")
    normalized = []
    for source in source_files:
        path, encoding = normalize_csv_to_utf8(source, NORMALIZED_DIR)
        normalized.append((path, source.name, encoding))
        print(f"  {source.name} -> {encoding}")

    # Every column is read as VARCHAR and cast with TRY_CAST further down —
    # forcing BIGINT/DOUBLE at read_csv time would abort the entire load on
    # a single malformed value instead of letting us count and skip it, the
    # way the Node pipeline's parseCount()/parseFiniteNumber() do.
    union_sql = " UNION ALL ".join(
        f"SELECT * EXCLUDE (城市, 行政區, 場站名稱), "
        f"COALESCE(城市, '') AS 城市, COALESCE(行政區, '') AS 行政區, COALESCE(場站名稱, '') AS 場站名稱, "
        f"'{name}' AS source_file, '{encoding}' AS source_encoding "
        f"FROM read_csv('{path.as_posix()}', encoding='utf-8', all_varchar=true)"
        for path, name, encoding in normalized
    )
    duckdb.sql(f"CREATE OR REPLACE TABLE raw AS {union_sql}")
    # A blank field reads as SQL NULL, not '', and csv-parse's JS equivalent
    # gives '' for an empty column — coalescing here keeps the self-join below
    # from silently dropping rows on NULL != NULL, and matches the identity
    # key the Node pipeline would compute for the same row.
    null_identity = duckdb.sql(
        "SELECT count(*) FROM raw WHERE 城市 = '' OR 行政區 = '' OR 場站名稱 = ''"
    ).fetchone()[0]
    if null_identity:
        print(f"  {null_identity:,} row(s) had a blank city/district/name field (coalesced to '').")
    raw_count = duckdb.sql("SELECT count(*) FROM raw").fetchone()[0]
    print(f"\nLoaded {raw_count:,} raw rows across {len(normalized)} files.")

    distinct_stations = duckdb.sql(
        'SELECT DISTINCT 城市 AS city, 行政區 AS district, 場站名稱 AS name FROM raw'
    ).fetchall()
    aliases = load_aliases()
    station_lookup = []
    for city, district, name in distinct_stations:
        norm_city = normalize_text(city)
        norm_district = normalize_text(district)
        raw_name = normalize_text(name)
        canonical_name = aliases.get(raw_name, raw_name)
        identity_key = f"{norm_city}|{norm_district}|{canonical_name}"
        station_id = "st_" + hashlib.sha256(identity_key.encode("utf-8")).hexdigest()[:14]
        station_lookup.append((city, district, name, station_id, norm_district, canonical_name))
    print(f"Resolved {len(station_lookup):,} distinct raw (city, district, name) triples "
          f"-> {len(set(row[3] for row in station_lookup)):,} station ids.")

    duckdb.sql("""
        CREATE OR REPLACE TABLE station_lookup (
            city VARCHAR, district VARCHAR, name VARCHAR,
            station_id VARCHAR, district_norm VARCHAR, canonical_name VARCHAR
        )
    """)
    duckdb.executemany(
        "INSERT INTO station_lookup VALUES (?, ?, ?, ?, ?, ?)", station_lookup,
    )

    windows = load_adjustment_windows()
    print(f"Loaded {len(windows)} operator adjustment window(s).")
    duckdb.sql("CREATE OR REPLACE TABLE adjustments (station_id VARCHAR, start_at TIMESTAMP, end_at TIMESTAMP)")
    if windows:
        duckdb.executemany(
            "INSERT INTO adjustments VALUES (?, ?, ?)",
            [(w["station_id"], w["start_at"], w["end_at"]) for w in windows],
        )

    duckdb.sql(f"""
        CREATE OR REPLACE TABLE parsed AS
        SELECT
            s.station_id,
            r.城市 AS city,
            s.district_norm AS district,
            s.canonical_name AS name,
            ts.bucket_at,
            hour(ts.bucket_at) * 2 + minute(ts.bucket_at) // 30 AS slot,
            dayofweek(ts.bucket_at) AS weekday,
            TRY_CAST(r.總車柱數 AS BIGINT) AS total_docks,
            TRY_CAST(r.可借車數 AS BIGINT) AS available_bikes,
            TRY_CAST(r.可還位數 AS BIGINT) AS available_docks,
            TRY_CAST(r.經度 AS DOUBLE) AS longitude,
            TRY_CAST(r.緯度 AS DOUBLE) AS latitude,
            r.source_file,
            r.source_encoding
        FROM raw r
        JOIN station_lookup s
          ON r.城市 = s.city AND r.行政區 = s.district AND r.場站名稱 = s.name
        CROSS JOIN LATERAL (
            SELECT date_trunc('hour', t) + INTERVAL (minute(t) // 30 * 30) MINUTE AS bucket_at
            FROM (SELECT try_strptime(r.日期, {TIMESTAMP_FORMATS!r}) AS t) _
            WHERE t IS NOT NULL
        ) ts
        WHERE TRY_CAST(r.總車柱數 AS BIGINT) >= 0
          AND TRY_CAST(r.可借車數 AS BIGINT) >= 0
          AND TRY_CAST(r.可還位數 AS BIGINT) >= 0
    """)

    duckdb.sql("""
        CREATE OR REPLACE TABLE clean AS
        SELECT
            p.*,
            NOT (p.available_bikes = 0 AND p.available_docks = 0)
                AND a.station_id IS NULL AS is_operational
        FROM parsed p
        LEFT JOIN adjustments a
          ON a.station_id = p.station_id
         AND p.bucket_at >= a.start_at
         AND p.bucket_at < a.end_at
    """)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    duckdb.sql(f"COPY clean TO '{OUTPUT_FILE.as_posix()}' (FORMAT PARQUET)")

    stats = duckdb.sql("""
        SELECT
            count(*) AS total,
            count(*) FILTER (NOT is_operational) AS excluded,
            count(DISTINCT station_id) AS stations
        FROM clean
    """).fetchone()
    # Mirrors the JS pipeline's precedence: a row with both a bad timestamp
    # and a bad numeric value is counted only under invalid_timestamp, since
    # parseSnapshot() there returns before ever checking the numeric fields.
    invalid_timestamp, invalid_numeric = duckdb.sql(f"""
        SELECT
            count(*) FILTER (t IS NULL) AS invalid_timestamp,
            count(*) FILTER (
                t IS NOT NULL AND (
                    TRY_CAST(總車柱數 AS BIGINT) IS NULL OR TRY_CAST(總車柱數 AS BIGINT) < 0
                    OR TRY_CAST(可借車數 AS BIGINT) IS NULL OR TRY_CAST(可借車數 AS BIGINT) < 0
                    OR TRY_CAST(可還位數 AS BIGINT) IS NULL OR TRY_CAST(可還位數 AS BIGINT) < 0
                )
            ) AS invalid_numeric
        FROM (SELECT *, try_strptime(日期, {TIMESTAMP_FORMATS!r}) AS t FROM raw)
    """).fetchone()

    print(f"\nWrote {OUTPUT_FILE}")
    print(f"rows={stats[0]:,} stations={stats[2]:,} excluded(is_operational=false)={stats[1]:,}")
    print(f"raw={raw_count:,} invalid_timestamp={invalid_timestamp:,} invalid_numeric={invalid_numeric:,}")


if __name__ == "__main__":
    main()
