import type { Alert, StationRisk } from './ops.ts'
import { stationOverviewStatus } from './station-overview.ts'

export interface StatusTotal {
  /** Everything the station overview files under this status: its filter count. */
  total: number
  /** Of those, stations already at zero bikes (or zero docks) right now. */
  now: number
  /** The rest: stations the alert horizon predicts will get there. */
  forecast: number
}

export interface InventoryStatusTotals {
  empty: StatusTotal
  full: StatusTotal
}

/**
 * The station overview's 缺車／缺位 counts, split into stations already at zero
 * and stations predicted to reach it within the alert horizon.
 *
 * Classifies with the same `stationOverviewStatus` over the same alerts the
 * /stations page counts with, so a figure shown elsewhere equals that page's
 * filter count by construction rather than by a parallel definition that could
 * drift from it. Display only: nothing here changes how stations are judged.
 */
export function inventoryStatusTotals(
  stations: readonly StationRisk[],
  alerts: readonly Alert[],
): InventoryStatusTotals {
  const alertByStation = new Map(alerts.map(alert => [alert.stationId, alert]))
  const totals: InventoryStatusTotals = {
    empty: { total: 0, now: 0, forecast: 0 },
    full: { total: 0, now: 0, forecast: 0 },
  }
  for (const station of stations) {
    const status = stationOverviewStatus(station, alertByStation.get(station.id))
    if (status !== 'empty' && status !== 'full') continue
    const bucket = totals[status]
    bucket.total += 1
    const atZero = status === 'empty' ? station.currentState === 'empty_now' : station.currentState === 'full_now'
    if (atZero) bucket.now += 1
    else bucket.forecast += 1
  }
  return totals
}
