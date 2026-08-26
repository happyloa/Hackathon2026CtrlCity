"""Step 6: scan validation-set probabilities for the F1-maximizing threshold
per horizon, mirroring evaluate-forecast.mjs's selectThreshold (max F1, tie
broken by higher precision, then higher recall, then higher threshold)."""

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output"

HORIZONS = [30, 60, 120]
CANDIDATES = [round(t, 2) for t in np.arange(0.02, 0.91, 0.01)]


def confusion_at(proba: np.ndarray, target: np.ndarray, threshold: float) -> dict:
    predicted = proba >= threshold
    tp = int(np.sum(predicted & target))
    fp = int(np.sum(predicted & ~target))
    fn = int(np.sum(~predicted & target))
    tn = int(np.sum(~predicted & ~target))
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {"threshold": threshold, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3)}


def select_threshold(proba: np.ndarray, target: np.ndarray) -> dict:
    candidates = [confusion_at(proba, target, t) for t in CANDIDATES]
    candidates.sort(key=lambda c: (c["f1"], c["precision"], c["recall"], c["threshold"]), reverse=True)
    return candidates[0]


def main():
    selected = {}
    for horizon in HORIZONS:
        proba = np.load(OUTPUT_DIR / f"val_proba_{horizon}.npy")
        target = np.load(OUTPUT_DIR / f"val_target_{horizon}.npy").astype(bool)
        best = select_threshold(proba, target)
        selected[horizon] = best
        print(f"horizon={horizon}m threshold={best['threshold']} f1={best['f1']} "
              f"precision={best['precision']} recall={best['recall']} "
              f"(tp={best['tp']} fp={best['fp']} fn={best['fn']})")

    (OUTPUT_DIR / "selected_thresholds.json").write_text(
        json.dumps(selected, indent=2, ensure_ascii=False)
    )
    print(f"saved {OUTPUT_DIR / 'selected_thresholds.json'}")


if __name__ == "__main__":
    main()
