import {
  DEFAULT_LIVE_OPERATION_POLICY,
  NEAR_EMPTY_BIKES,
  ALERT_PRIORITY_THRESHOLDS,
} from './parameters.mjs'

export { DEFAULT_LIVE_OPERATION_POLICY, ALERT_PRIORITY_THRESHOLDS }

// Single source of truth for "how severe is this station right now". Order is
// priority: each station gets the first level whose condition matches, so the
// six levels stay mutually exclusive by construction.
export const SEVERITY_LEVELS = Object.freeze({
  SERVICE_DISRUPTION: 'service_disruption',
  FULL: 'full',
  EMPTY: 'empty',
  NEAR_EMPTY: 'near_empty',
  LOW: 'low',
  NORMAL: 'normal',
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

/**
 * Classifies a station into one of the six mutually exclusive severity levels,
 * judged purely by available bikes/docks rather than a modelled risk score.
 * Service disruption always wins first: once a station can't be served,
 * its inventory numbers no longer mean anything.
 */
export function stationSeverityFor(station) {
  if (station.serviceStatus !== 'operational') return SEVERITY_LEVELS.SERVICE_DISRUPTION
  const availableBikes = Math.max(0, finite(station.availableBikes))
  const availableDocks = Math.max(0, finite(station.availableDocks))
  const totalDocks = Math.max(0, finite(station.totalDocks))
  if (availableDocks === 0) return SEVERITY_LEVELS.FULL
  if (availableBikes === 0) return SEVERITY_LEVELS.EMPTY
  if (availableBikes < NEAR_EMPTY_BIKES) return SEVERITY_LEVELS.NEAR_EMPTY
  if (availableBikes < totalDocks / 2) return SEVERITY_LEVELS.LOW
  return SEVERITY_LEVELS.NORMAL
}

/**
 * Bikes needed to refill a station up to its safety stock, not merely up to
 * the near-empty threshold. The threshold decides *when* to act; this decides
 * *how much*, so a 60-dock station doesn't get the same 2-bike top-up as a
 * 10-dock one.
 */
export function refillAmountFor(station, inventory, options = {}) {
  const safetyStock = safetyStockFor(station, options)
  const currentInventory = Math.max(0, finite(inventory))
  return Math.max(0, Math.ceil(safetyStock - currentInventory))
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
