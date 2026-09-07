export const RISK_POLICY_VERSION = 'event-risk-policy-v1'

// These values are frozen from the chronological validation split documented
// in docs/03_實作與驗證/歷史風險基線評估.md. They are deliberately shared by artifact
// generation and static export so the visible alert state matches evaluation.
export const ALERT_THRESHOLDS = Object.freeze({
  '30': 0.45,
  '60': 0.4,
})

const MEDIUM_FACTOR = 0.65
const CRITICAL_MARGIN = 0.2

export const HORIZON_MINUTES = Object.freeze([30, 60])

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

export function alertThresholdFor(horizon) {
  const key = String(horizon)
  return ALERT_THRESHOLDS[key] ?? ALERT_THRESHOLDS['60']
}

export function riskLevelFor(score, horizon) {
  const safeScore = clamp(Number(score) || 0)
  const threshold = alertThresholdFor(horizon)

  if (safeScore >= Math.min(1, threshold + CRITICAL_MARGIN)) return 'critical'
  if (safeScore >= threshold) return 'high'
  if (safeScore >= threshold * MEDIUM_FACTOR) return 'medium'
  return 'normal'
}

export function alertSeverityFor(score, horizon, { currentFailure = false } = {}) {
  if (currentFailure) return 'critical'
  return riskLevelFor(score, horizon) === 'critical'
    ? 'critical'
    : riskLevelFor(score, horizon) === 'high'
      ? 'warning'
      : 'normal'
}
