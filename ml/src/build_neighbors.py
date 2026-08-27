"""Build a 300m station-adjacency table for the neighbor-risk feature.

Reuses app/data/operational-roi.json's station coordinates (already the
canonical lat/lon source for this project -- no need to reparse the raw
CSVs) rather than deriving coordinates from scratch.

Usage: python ml/src/build_neighbors.py
"""
import csv
import json
import math
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ROI_JSON = REPO_ROOT / "app" / "data" / "operational-roi.json"
OUTPUT_CSV = REPO_ROOT / "ml" / "output" / "neighbors.csv"

RADIUS_METERS = 300


def haversine_meters(lat1, lon1, lat2, lon2) -> float:
    earth_radius_m = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2)
    return earth_radius_m * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def main():
    roi = json.loads(ROI_JSON.read_text(encoding="utf-8"))
    stations = [(row[0], row[4], row[5]) for row in roi["stations"]]  # id, lat, lon

    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    pair_count = 0
    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["station_id", "neighbor_id", "distance_m"])
        for i in range(len(stations)):
            id_a, lat_a, lon_a = stations[i]
            for j in range(i + 1, len(stations)):
                id_b, lat_b, lon_b = stations[j]
                distance = haversine_meters(lat_a, lon_a, lat_b, lon_b)
                if distance <= RADIUS_METERS:
                    writer.writerow([id_a, id_b, round(distance, 1)])
                    writer.writerow([id_b, id_a, round(distance, 1)])
                    pair_count += 2

    stations_with_neighbor = len({row[0] for row in stations}) if pair_count else 0
    print(f"stations={len(stations)}  directed pairs within {RADIUS_METERS}m={pair_count}")
    print(f"wrote {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
