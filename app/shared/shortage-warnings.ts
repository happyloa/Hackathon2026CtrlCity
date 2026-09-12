import { buildLiveOperations } from './live-operations.ts'
import type { HorizonKey, StationRisk } from './ops.ts'

// Forecast shortages exclude stations that are already empty or unavailable.
export function shortageWarningsFor(stations: StationRisk[], asOf: string, horizon: HorizonKey) {
  return buildLiveOperations(stations, asOf, { horizon }).alerts
    .filter(alert => alert.condition === 'empty_forecast')
}
