"""EDA: does weather (rain/temp/wind) correlate with YouBike shortage/fullness?

Aggregates clean.parquet to a citywide hourly low_bikes_rate / low_docks_rate
series (Jan-Jun 2026, is_operational rows only) and correlates it against the
two CWA hourly weather stations (466881 = New Taipei/Banqiao, 466900 = Danshui).

This is a signal-check only (matching the neighbor-feature methodology used
elsewhere in this PoC: verify real correlation exists before spending time
wiring a feature into ml/src/features.py + retraining).
"""
import csv
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
CLEAN_FILE = REPO_ROOT / "ml" / "data" / "clean.parquet"
WEATHER_FILE = Path(__file__).parent / "weather_hourly.csv"
OUT_FILE = Path(__file__).parent / "weather_feature_analysis.md"

LOW_BIKES_EXPR = "available_bikes <= GREATEST(2, CEIL(total_docks * 0.1))"
LOW_DOCKS_EXPR = "available_docks <= GREATEST(2, CEIL(total_docks * 0.1))"


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return sxy / (sxx ** 0.5 * syy ** 0.5)


def main():
    hourly = duckdb.sql(f"""
        SELECT
            date_trunc('hour', bucket_at) AS hour_ts,
            dayofweek(bucket_at) AS weekday,
            hour(bucket_at) AS hod,
            AVG(CASE WHEN {LOW_BIKES_EXPR} THEN 1 ELSE 0 END) AS low_bikes_rate,
            AVG(CASE WHEN {LOW_DOCKS_EXPR} THEN 1 ELSE 0 END) AS low_docks_rate,
            COUNT(*) AS n
        FROM read_parquet('{CLEAN_FILE.as_posix()}')
        WHERE is_operational
        GROUP BY date_trunc('hour', bucket_at), dayofweek(bucket_at), hour(bucket_at)
        ORDER BY hour_ts
    """).fetchall()
    bike_by_hour = {row[0]: (row[3], row[4]) for row in hourly}
    print(f"citywide hourly rows: {len(bike_by_hour):,}")

    # Diurnal baseline (is_workday x hour-of-day) so we can residualize out
    # the time-of-day demand cycle before correlating with weather -- both
    # temperature and rain intensity naturally co-vary with hour-of-day, so
    # a raw correlation would mostly just be re-discovering rush hour.
    from collections import defaultdict
    baseline_sums = defaultdict(lambda: [0.0, 0.0, 0])
    for _, weekday, hod, lb, ld, n in hourly:
        is_workday = 1 <= weekday <= 5
        key = (is_workday, hod)
        s = baseline_sums[key]
        s[0] += lb
        s[1] += ld
        s[2] += 1
    baseline = {k: (v[0] / v[2], v[1] / v[2]) for k, v in baseline_sums.items()}
    residual_by_hour = {}
    for hour_ts, weekday, hod, lb, ld, n in hourly:
        is_workday = 1 <= weekday <= 5
        base_lb, base_ld = baseline[(is_workday, hod)]
        residual_by_hour[hour_ts] = (lb - base_lb, ld - base_ld)

    weather = {}
    with WEATHER_FILE.open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            weather.setdefault(row["station_code"], []).append(row)

    lines = []
    lines.append("# 天氣資料 x YouBike 缺車/滿車 相關性分析\n")
    lines.append(f"樣本：citywide 每小時聚合（Jan-Jun 2026，is_operational=true），{len(bike_by_hour):,} 小時\n")

    for station_code, rows in weather.items():
        label = {"466881": "新北(板橋)", "466900": "淡水"}.get(station_code, station_code)
        precip, temp, wind = [], [], []
        low_bikes, low_docks = [], []
        precip_lb, temp_lb, wind_lb = [], [], []
        precip_resid, temp_resid, wind_resid = [], [], []
        for r in rows:
            import datetime as dt
            ts = dt.datetime.strptime(r["datetime"], "%Y-%m-%d %H:%M:%S")
            bike = bike_by_hour.get(ts)
            resid = residual_by_hour.get(ts)
            if bike is None or resid is None:
                continue
            lb, ld = bike
            lb_resid, _ld_resid = resid
            if r["precip_mm"] not in ("", None):
                precip.append(float(r["precip_mm"]))
                low_bikes.append(lb)
                low_docks.append(ld)
                precip_lb.append(lb)
                precip_resid.append(lb_resid)
            if r["air_temp_c"] not in ("", None):
                temp.append(float(r["air_temp_c"]))
                temp_lb.append(lb)
                temp_resid.append(lb_resid)
            if r["wind_speed_ms"] not in ("", None):
                wind.append(float(r["wind_speed_ms"]))
                wind_lb.append(lb)
                wind_resid.append(lb_resid)

        lines.append(f"\n## {label} ({station_code})\n")
        lines.append(f"- 對齊小時數：precip={len(precip)}, temp={len(temp)}, wind={len(wind)}\n")
        r_precip_bikes = pearson(precip, precip_lb)
        r_precip_docks = pearson(precip, low_docks)
        r_temp_bikes = pearson(temp, temp_lb)
        r_wind_bikes = pearson(wind, wind_lb)
        lines.append(f"- corr(降水量, 缺車率) = {r_precip_bikes:.4f}\n" if r_precip_bikes is not None else "- corr(降水量, 缺車率) = N/A\n")
        lines.append(f"- corr(降水量, 滿車率) = {r_precip_docks:.4f}\n" if r_precip_docks is not None else "- corr(降水量, 滿車率) = N/A\n")
        lines.append(f"- corr(氣溫, 缺車率) = {r_temp_bikes:.4f}\n" if r_temp_bikes is not None else "- corr(氣溫, 缺車率) = N/A\n")
        lines.append(f"- corr(風速, 缺車率) = {r_wind_bikes:.4f}\n" if r_wind_bikes is not None else "- corr(風速, 缺車率) = N/A\n")

        r_precip_resid = pearson(precip, precip_resid)
        r_temp_resid = pearson(temp, temp_resid)
        r_wind_resid = pearson(wind, wind_resid)
        lines.append("\n**控制時段效應後（扣除 平日/假日 x 小時 的基準缺車率，只看殘差）：**\n")
        lines.append(f"- corr(降水量, 缺車率殘差) = {r_precip_resid:.4f}\n" if r_precip_resid is not None else "- corr(降水量, 缺車率殘差) = N/A\n")
        lines.append(f"- corr(氣溫, 缺車率殘差) = {r_temp_resid:.4f}\n" if r_temp_resid is not None else "- corr(氣溫, 缺車率殘差) = N/A\n")
        lines.append(f"- corr(風速, 缺車率殘差) = {r_wind_resid:.4f}\n" if r_wind_resid is not None else "- corr(風速, 缺車率殘差) = N/A\n")

        # bucket comparison: dry vs light vs moderate vs heavy rain
        buckets = [("無雨 (0mm)", lambda p: p == 0),
                   ("微雨 (0-1mm)", lambda p: 0 < p <= 1),
                   ("小雨 (1-5mm)", lambda p: 1 < p <= 5),
                   ("大雨 (>5mm)", lambda p: p > 5)]
        lines.append("\n| 降水區間 | 小時數 | 平均缺車率 | 平均滿車率 |\n|---|---|---|---|\n")
        for name, cond in buckets:
            idxs = [i for i, p in enumerate(precip) if cond(p)]
            if not idxs:
                lines.append(f"| {name} | 0 | - | - |\n")
                continue
            avg_lb = sum(low_bikes[i] for i in idxs) / len(idxs)
            avg_ld = sum(low_docks[i] for i in idxs) / len(idxs)
            lines.append(f"| {name} | {len(idxs)} | {avg_lb:.4f} | {avg_ld:.4f} |\n")

    OUT_FILE.write_text("".join(lines), encoding="utf-8")
    print(f"Wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
