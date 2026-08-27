"""Per-station characteristic peak windows -- a discrete, per-station feature
in the same spirit as app/scripts/analyze-high-risk-stations.mjs's peakOf(),
but for every station and split by workday/weekend rather than by exact
weekday, and expressed as bucket *membership* (7 time-of-day buckets) instead
of a single slot.

This is deliberately NOT the continuous profile_empty_rate/baseline_risk
features tried in features.py before (see train.py's INCLUDE_STACKING_FEATURES
comment) -- those dominated gain so strongly the model just copied the
baseline. A per-station boolean "is this slot inside MY OWN historical peak
window" is a much weaker, more discrete signal: station A might peak
20:00-24:00 for fullness, station B might peak 07:30-09:00 for emptiness --
the model still has to combine this with momentum/current state to decide
anything, rather than being handed the answer directly.

Usage: python ml/src/build_station_peaks.py (reads ml/output/station-time-profile-train.csv)
"""
import csv
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PROFILE_FILE = REPO_ROOT / "ml" / "output" / "station-time-profile-train.csv"
OUTPUT_FILE = REPO_ROOT / "ml" / "output" / "station_peak_windows.csv"

WORKDAYS = {1, 2, 3, 4, 5}
BUCKETS = [
    (0, 12, "overnight"),      # 00:00-06:00 (slots 0-11)
    (12, 18, "am_commute"),    # 06:00-09:00 (slots 12-17)
    (18, 24, "am_offpeak"),    # 09:00-12:00 (slots 18-23)
    (24, 28, "midday"),        # 12:00-14:00 (slots 24-27)
    (28, 34, "afternoon"),     # 14:00-17:00 (slots 28-33)
    (34, 40, "pm_peak"),       # 17:00-20:00 (slots 34-39)
    (40, 48, "evening"),       # 20:00-24:00 (slots 40-47)
]
BUCKET_NAMES = [name for _, _, name in BUCKETS]


def bucket_of(slot: int) -> int:
    for index, (start, end, _) in enumerate(BUCKETS):
        if start <= slot < end:
            return index
    raise ValueError(f"slot {slot} out of range")


def main():
    # station_id -> is_workday -> bucket_index -> {obs_sum, empty_weighted, full_weighted}
    agg = {}
    with PROFILE_FILE.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            weekday = int(row["weekday"])
            slot = int(row["slot"])
            observations = int(row["observations"])
            if observations <= 0:
                continue
            station_id = row["stationId"]
            is_workday = weekday in WORKDAYS
            bucket = bucket_of(slot)
            key = (station_id, is_workday)
            cell = agg.setdefault(key, [[0, 0.0, 0.0] for _ in BUCKETS])
            cell[bucket][0] += observations
            cell[bucket][1] += float(row["emptyRate"]) * observations
            cell[bucket][2] += float(row["fullRate"]) * observations

    # station_id -> {workday_peak_empty, workday_peak_full, weekend_peak_empty, weekend_peak_full}
    peaks = {}
    for (station_id, is_workday), cells in agg.items():
        rates_empty = [(w[1] / w[0] if w[0] else 0.0) for w in cells]
        rates_full = [(w[2] / w[0] if w[0] else 0.0) for w in cells]
        best_empty = max(range(len(BUCKETS)), key=lambda i: rates_empty[i])
        best_full = max(range(len(BUCKETS)), key=lambda i: rates_full[i])
        entry = peaks.setdefault(station_id, {})
        prefix = "workday" if is_workday else "weekend"
        entry[f"{prefix}_peak_empty"] = BUCKET_NAMES[best_empty] if rates_empty[best_empty] > 0 else ""
        entry[f"{prefix}_peak_full"] = BUCKET_NAMES[best_full] if rates_full[best_full] > 0 else ""

    with OUTPUT_FILE.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["station_id", "workday_peak_empty", "workday_peak_full",
                          "weekend_peak_empty", "weekend_peak_full"])
        for station_id, entry in sorted(peaks.items()):
            writer.writerow([
                station_id,
                entry.get("workday_peak_empty", ""), entry.get("workday_peak_full", ""),
                entry.get("weekend_peak_empty", ""), entry.get("weekend_peak_full", ""),
            ])

    print(f"stations={len(peaks)}")
    print(f"wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
