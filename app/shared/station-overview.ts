import type { Alert, StationRisk } from './ops.ts'

export type StationOverviewStatus = 'empty' | 'full' | 'stable' | 'unknown' | 'service'

/** Observed continuous inventory shortage; snapshots use five-minute slots. */
export function stationStatusDurationMinutes(
  station: StationRisk,
  snapshots: readonly { at: number; bikes: number; docks: number }[],
  now: number,
): number | null {
  if (station.serviceStatus !== 'operational' || !Number.isFinite(now)) return null
  const metric = station.currentState === 'empty_now' && station.availableBikes === 0 ? 'bikes'
    : station.currentState === 'full_now' && station.availableDocks === 0 ? 'docks' : null
  if (!metric) return null
  const slot = 5 * 60_000
  // Nearest-slot timestamps may be up to half a slot ahead of the clock.
  const history = snapshots.filter(s => Number.isFinite(s.at) && s.at <= now + slot / 2)
    .slice().sort((a, b) => a.at - b.at)
  const latest = history.at(-1)
  if (!latest || latest[metric] !== 0 || now - latest.at > slot * 2) return null
  let start = latest.at
  for (let i = history.length - 2; i >= 0; i--) {
    const previous = history[i]!
    if (previous[metric] !== 0 || start - previous.at > slot) break
    start = previous.at
  }
  return Math.max(0, Math.floor((now - start) / 60_000))
}

export function stationOverviewStatus(station: StationRisk, alert?: Alert): StationOverviewStatus {
  if (station.serviceStatus !== 'operational'
    || station.currentState === 'unavailable'
    || alert?.condition === 'unavailable') return 'service'
  if (station.currentState === 'empty_now'
    || alert?.condition === 'empty_now'
    || alert?.condition === 'empty_forecast') return 'empty'
  if (station.currentState === 'full_now'
    || alert?.condition === 'full_now'
    || alert?.condition === 'full_forecast') return 'full'
  if (station.forecast.horizons['60'].baselineStatus !== 'matched') return 'unknown'
  return 'stable'
}

/** Missing values remain last in either direction. */
export function compareStationValues(left: number | string | null, right: number | string | null, direction: 'asc' | 'desc'): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  const comparison = typeof left === 'number' && typeof right === 'number'
    ? left - right : String(left).localeCompare(String(right), 'zh-Hant')
  return direction === 'asc' ? comparison : -comparison
}
