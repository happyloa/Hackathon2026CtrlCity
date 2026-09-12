import {
  DEFAULT_LIVE_OPERATION_POLICY,
  NEAR_EMPTY_BIKES,
  ALERT_PRIORITY_THRESHOLDS,
  SUSTAINED_SHORTAGE_TIERS,
} from './parameters.mjs'

export { DEFAULT_LIVE_OPERATION_POLICY, ALERT_PRIORITY_THRESHOLDS, SUSTAINED_SHORTAGE_TIERS }

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

/**
 * The band floor a sustained shortage earns, from `SUSTAINED_SHORTAGE_TIERS`.
 * 0 once the run is shorter than the smallest tier.
 */
export function durationPriorityBonus(minutes) {
  const run = finite(minutes)
  for (const tier of SUSTAINED_SHORTAGE_TIERS) if (run >= tier.minutes) return tier.score
  return 0
}

/**
 * Ordering is banded, not weighted.
 *
 *   duration  0 | 50 | 75   how long the station has actually been short
 *   current   0 | 25        short right now, but for less than the first tier
 *   forecast  0..12         model risk, only ever a tie-breaker
 *   gap       0..8          how many bikes short
 *   quality   0..4          how trustworthy the baseline is
 *
 * The three tie-breakers total at most 24, so they can never lift an alert
 * into the band above: a predicted shortage (<=24) cannot outrank a station
 * that has already run out (>=25), and neither can outrank one that has been
 * short for half an hour (>=50) or a full hour (>=75). That was the point of
 * the change -- the old weights let a confident forecast (25) plus a large gap
 * (20) reach 45 while a station sitting at zero bikes for an hour topped out
 * at 10 points of duration bonus.
 *
 * 排序來自分層，不是權重。三個微調項加總最多 24 分，永遠無法把一筆告警抬進上一層：
 * 預測（≤24）壓不過已經沒車（≥25），兩者都壓不過已缺車半小時（≥50）或一小時（≥75）。
 */
export function scoreAlertPriority(input) {
  const duration = durationPriorityBonus(input.shortageMinutes ?? input.durationMinutes)
  const scoreParts = {
    duration,
    // Only the floor for a station that is short right now but has not been
    // short long enough to earn a band of its own. Once a run qualifies, how
    // long it has lasted is the band -- being at exactly zero rather than one
    // or two bikes is then a tie-breaker inside it, not a separate tier.
    current: duration === 0 && input.currentFailure ? 25 : 0,
    forecast: rounded(clamp(finite(input.riskScore), 0, 1) * 12),
    gap: rounded(clamp(finite(input.gap) / 8, 0, 1) * 8),
    quality: rounded(clamp(finite(input.quality), 0, 1) * 4),
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
