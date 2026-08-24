export const DEFAULT_LIVE_OPERATION_POLICY = Object.freeze({
  horizon: '60',
  safetyStockRatio: 0.15,
  minimumSafetyStock: 2,
  minimumTransferBikes: 1,
  maximumTransferBikes: 8,
  maximumDistanceKm: 8,
  maximumAlerts: 80,
  maximumDispatches: 16,
})

export const ALERT_PRIORITY_THRESHOLDS = Object.freeze({
  immediate: 55,
  high: 30,
})

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function rounded(value, digits = 1) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function safetyStockFor(station, options = {}) {
  const ratio = clamp(finite(
    options.safetyStockRatio ?? DEFAULT_LIVE_OPERATION_POLICY.safetyStockRatio,
    DEFAULT_LIVE_OPERATION_POLICY.safetyStockRatio,
  ), 0, 0.5)
  const minimum = Math.max(0, Math.round(finite(
    options.minimumSafetyStock ?? DEFAULT_LIVE_OPERATION_POLICY.minimumSafetyStock,
    DEFAULT_LIVE_OPERATION_POLICY.minimumSafetyStock,
  )))
  const capacity = Math.max(0, Math.round(finite(station.totalDocks)))
  return Math.min(capacity, Math.max(minimum, Math.ceil(capacity * ratio)))
}

export function scoreAlertPriority(input) {
  const scoreParts = {
    forecast: rounded(clamp(finite(input.riskScore), 0, 1) * 25),
    current: input.currentFailure ? 50 : 0,
    gap: rounded(clamp(finite(input.gap) / 8, 0, 1) * 20),
    quality: rounded(clamp(finite(input.quality), 0, 1) * 5),
  }
  return {
    priorityScore: rounded(Object.values(scoreParts).reduce((sum, value) => sum + value, 0)),
    scoreParts,
  }
}

export function alertDataQuality(station, forecast) {
  const confidence = forecast.confidence === 'high' ? 1 : forecast.confidence === 'medium' ? 0.7 : 0.4
  const baseline = forecast.baselineStatus === 'matched' ? 1 : 0.4
  const capacityPenalty = station.capacityGap === 0 ? 0 : 0.2
  return clamp(Math.min(confidence, baseline) - capacityPenalty, 0, 1)
}
