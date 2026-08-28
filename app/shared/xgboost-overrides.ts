import roi from '~/data/operational-roi.json'
import type { Forecast, HorizonKey, RiskLevel, StationRisk } from './ops.ts'
import type { XgboostHorizonPrediction, XgboostStationPrediction } from '~/composables/useXgboostPredictions'

const XGBOOST_ALERT_THRESHOLD = 0.5

/**
 * `StationRisk.id` on the live dashboard is NTPC's own numeric `sno` (see
 * mapLiveStation() in useLiveDashboard.ts) -- a completely different
 * identifier from the `st_<hash>` station_id predict-xgboost.mjs keys its
 * output by. Without this match, `predictions[station.id]` never hits and
 * XGBoost mode silently renders as an exact copy of the baseline. Matches
 * the same (district, normalized name) key useLiveRiskProfiles.ts already
 * uses to reconcile live stations against the historical profile.
 */
function normalizeStationName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^YouBike\s*2(?:\.0)?[_\s-]*/i, '')
    .replace(/^YouBike[_\s-]*/i, '')
}

function matchKey(district: string, name: string): string {
  return `${district.normalize('NFKC').trim()}|${normalizeStationName(name)}`
}

const stationIdByMatchKey = new Map<string, string>(
  (roi.stations as [string, string, string, number, number, number][])
    .map(([id, district, name]) => [matchKey(district, name), id]),
)

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function riskLevel(score: number, threshold: number): RiskLevel {
  if (score >= Math.min(1, threshold + .2)) return 'critical'
  if (score >= threshold) return 'high'
  if (score >= threshold * .65) return 'medium'
  return 'normal'
}

function targetAt(observedAt: string, horizon: HorizonKey): string {
  const epoch = Date.parse(observedAt)
  return new Date((Number.isFinite(epoch) ? epoch : Date.now()) + Number(horizon) * 60_000).toISOString()
}

/**
 * Builds a Forecast object shaped exactly like the rule baseline's, so every
 * consumer (RiskMap, StationDetailPanel, TaskQueue, buildLiveOperations) can
 * treat it identically regardless of which model produced it.
 *
 * The trained model predicts one combined "empty or full" event, not
 * separate heads -- `condition` (decided in predict-xgboost.mjs from the
 * live bike/dock ratio) says which direction is straining right now, so
 * that single risk score is assigned to just that side.
 */
function toForecast(
  prediction: XgboostHorizonPrediction,
  horizon: HorizonKey,
  observedAt: string,
  baseline: Forecast,
  generatedAt: string,
): Forecast {
  const riskScore = clamp(prediction.riskScore)
  const emptyRisk = prediction.condition === 'empty' ? riskScore : 0
  const fullRisk = prediction.condition === 'full' ? riskScore : 0
  const gap = prediction.condition === 'empty' ? prediction.gapBikes : prediction.gapDocks
  const gapLabel = prediction.condition === 'empty' ? '可借車' : '可還位'

  return {
    targetAt: targetAt(observedAt, horizon),
    baselineBikes: baseline.baselineBikes,
    baselineDocks: baseline.baselineDocks,
    predictedBikes: prediction.predictedBikes,
    predictedDocks: prediction.predictedDocks,
    emptyRisk,
    fullRisk,
    unavailableRisk: baseline.unavailableRisk,
    riskScore,
    level: riskLevel(riskScore, XGBOOST_ALERT_THRESHOLD),
    confidence: 'medium',
    alertThreshold: XGBOOST_ALERT_THRESHOLD,
    baselineStatus: 'matched',
    baselineCoverage: 'sufficient',
    method: 'historical_baseline_live_inventory',
    sampleSize: 0,
    reasons: [
      `XGBoost（含鄰站特徵）快照，產出於 ${new Date(generatedAt).toLocaleString('zh-TW', { hour12: false })}。`,
      gap > 0 ? `建議${prediction.condition === 'empty' ? '補' : '拉'} ${gap} 台，維持${gapLabel}安全量。` : '目前不需要搬運。',
    ],
  }
}

/**
 * Only stations the hybrid-deployment routing selected (baseline 60min
 * F1 <= 60%, decided when predict-xgboost.mjs ran) get overridden; every
 * other station keeps its rule-baseline forecast unchanged, exactly per the
 * hybrid strategy validated earlier in this PoC. 120min has no XGBoost
 * model in scope here, so it always stays on the baseline too.
 */
export function overrideStationsWithXgboost(
  stations: readonly StationRisk[],
  predictions: Record<string, XgboostStationPrediction>,
  observedAt: string,
  generatedAt: string,
): StationRisk[] {
  return stations.map((station) => {
    const stationId = stationIdByMatchKey.get(matchKey(station.district, station.name))
    const prediction = stationId ? predictions[stationId] : undefined
    if (!prediction) return station

    const horizons = { ...station.forecast.horizons }
    for (const horizon of ['30', '60'] as const) {
      const entry = prediction.horizons[horizon]
      if (entry) horizons[horizon] = toForecast(entry, horizon, observedAt, station.forecast.horizons[horizon], generatedAt)
    }
    return { ...station, forecast: { horizons } }
  })
}
