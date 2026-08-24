import type { Alert, StationRisk } from './ops.ts'

export type StationOverviewStatus = 'empty' | 'full' | 'stable' | 'unknown' | 'service'

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
