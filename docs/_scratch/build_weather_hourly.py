"""Parse the CWA hourly weather CSVs (docs/_scratch/Weather/) into one long-format table.

Each source file is a day x hour grid for one station/month/metric:
  466881 = 新北(板橋), 466900 = 淡水
Columns "1".."24" are hourly readings (hour N = the reading taken at N:00,
hour 24 rolls to 00:00 of the next calendar day). Special tokens:
  T = trace precipitation (< 0.1mm) -> treated as 0.05
  X = missing/invalid observation -> NaN
  wind direction "V" = variable/calm -> NaN (no meaningful direction)

Output: docs/_scratch/weather_hourly.csv
  station_code, datetime, air_temp_c, precip_mm, wind_speed_ms, wind_dir_deg
"""
import csv
import glob
import re
from datetime import datetime, timedelta
from pathlib import Path

WEATHER_DIR = Path(__file__).parent / "Weather"
OUT_FILE = Path(__file__).parent / "weather_hourly.csv"


def parse_num(cell: str):
    cell = cell.strip()
    if cell in ("", "X", "/"):
        return None
    if cell == "T":
        return 0.05
    try:
        return float(cell)
    except ValueError:
        return None


def parse_wind(cell: str):
    cell = cell.strip()
    if cell in ("", "X"):
        return None, None
    if "/" not in cell:
        return parse_num(cell), None
    spd_raw, dir_raw = [p.strip() for p in cell.split("/", 1)]
    spd = parse_num(spd_raw)
    dir_raw = dir_raw.strip()
    if dir_raw in ("V", "X", ""):
        return spd, None
    try:
        return spd, float(dir_raw)
    except ValueError:
        return spd, None


def parse_file(path: Path):
    name = path.stem  # e.g. 466881-2026-01-AirTemperature-hour
    station_code, year_month_parts = name.split("-", 1)
    m = re.match(r"(\d{4})-(\d{2})-(.+?)-hour$", name.split("-", 1)[1])
    year, month, metric = int(m.group(1)), int(m.group(2)), m.group(3)

    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        for row in reader:
            day_label = row[0].strip().strip('"')
            if not day_label.isdigit():
                continue
            day = int(day_label)
            for hour_idx in range(1, 25):
                cell = row[hour_idx]
                base_date = datetime(year, month, day)
                ts = base_date + timedelta(hours=hour_idx)  # hour 24 rolls to next day 00:00
                rows.append((station_code, ts, metric, cell))
    return rows


def main():
    files = sorted(glob.glob(str(WEATHER_DIR / "*.csv")))
    if not files:
        raise SystemExit(f"No CSV files found in {WEATHER_DIR}")

    # key: (station_code, ts) -> dict of metric values
    data: dict[tuple[str, datetime], dict] = {}
    for f in files:
        for station_code, ts, metric, cell in parse_file(Path(f)):
            key = (station_code, ts)
            entry = data.setdefault(key, {})
            if metric == "AirTemperature":
                entry["air_temp_c"] = parse_num(cell)
            elif metric == "Precipitation":
                entry["precip_mm"] = parse_num(cell)
            elif metric.startswith("WindSpeed"):
                spd, dir_deg = parse_wind(cell)
                entry["wind_speed_ms"] = spd
                entry["wind_dir_deg"] = dir_deg

    rows = []
    for (station_code, ts), entry in data.items():
        rows.append((
            station_code,
            ts.strftime("%Y-%m-%d %H:%M:%S"),
            entry.get("air_temp_c"),
            entry.get("precip_mm"),
            entry.get("wind_speed_ms"),
            entry.get("wind_dir_deg"),
        ))
    rows.sort(key=lambda r: (r[0], r[1]))

    with OUT_FILE.open("w", encoding="utf-8", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["station_code", "datetime", "air_temp_c", "precip_mm", "wind_speed_ms", "wind_dir_deg"])
        writer.writerows(rows)

    print(f"Wrote {OUT_FILE} ({len(rows):,} rows, stations={sorted(set(r[0] for r in rows))})")
    missing_temp = sum(1 for r in rows if r[2] is None)
    missing_precip = sum(1 for r in rows if r[3] is None)
    print(f"missing air_temp={missing_temp:,} missing_precip={missing_precip:,}")


if __name__ == "__main__":
    main()
