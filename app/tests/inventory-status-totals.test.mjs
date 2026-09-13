import assert from 'node:assert/strict'
import test from 'node:test'
import { inventoryStatusTotals } from '../shared/inventory-status-totals.ts'
import { stationOverviewStatus } from '../shared/station-overview.ts'

const station = (id, overrides = {}) => ({
  id, serviceStatus: 'operational', currentState: 'normal',
  forecast: { horizons: { 60: { baselineStatus: 'matched' } } }, ...overrides,
})
const alert = (stationId, condition) => ({ stationId, condition })

const stations = [
  station('empty-now', { currentState: 'empty_now' }),
  station('empty-soon'),
  station('full-now', { currentState: 'full_now' }),
  station('full-soon'),
  station('fine'),
  // A suspended station is a service anomaly even with an empty alert attached.
  station('suspended', { currentState: 'unavailable', serviceStatus: 'suspected_unavailable' }),
]
const alerts = [
  alert('empty-now', 'empty_now'),
  alert('empty-soon', 'empty_forecast'),
  alert('full-now', 'full_now'),
  alert('full-soon', 'full_forecast'),
  alert('suspended', 'empty_forecast'),
]

test('splits each status into stations at zero now and stations predicted to get there', () => {
  assert.deepEqual(inventoryStatusTotals(stations, alerts), {
    empty: { total: 2, now: 1, forecast: 1 },
    full: { total: 2, now: 1, forecast: 1 },
  })
})

test('totals equal the station overview filter counts for the same stations and alerts', () => {
  // The exact expression pages/stations/index.vue counts its filter chips with.
  const lookup = new Map(alerts.map(item => [item.stationId, item]))
  const overviewCount = status => stations.filter(item => stationOverviewStatus(item, lookup.get(item.id)) === status).length
  const totals = inventoryStatusTotals(stations, alerts)
  assert.equal(totals.empty.total, overviewCount('empty'))
  assert.equal(totals.full.total, overviewCount('full'))
})

test('a station at zero without an alert still counts as current', () => {
  const totals = inventoryStatusTotals([station('a', { currentState: 'empty_now' })], [])
  assert.deepEqual(totals.empty, { total: 1, now: 1, forecast: 0 })
})

test('no stations or no failures is zero everywhere', () => {
  const zero = { total: 0, now: 0, forecast: 0 }
  assert.deepEqual(inventoryStatusTotals([], []), { empty: zero, full: zero })
  assert.deepEqual(inventoryStatusTotals([station('a')], []), { empty: zero, full: zero })
})
