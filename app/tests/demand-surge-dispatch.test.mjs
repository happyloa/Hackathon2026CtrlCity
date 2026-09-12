import assert from 'node:assert/strict'
import test from 'node:test'

import { eventDrivenOperations } from '../shared/demand-surge-dispatch.ts'

const NOW = Date.parse('2026-09-12T20:00:00Z')
const OBSERVED_AT = '2026-09-12T20:00:00+08:00'

function station({
  id,
  name = id,
  district = '板橋區',
  totalDocks = 20,
  availableBikes = 10,
  latitude = 25,
  longitude = 121.5,
  serviceStatus = 'operational',
}) {
  return {
    id,
    name,
    city: '新北市',
    district,
    latitude,
    longitude,
    totalDocks,
    availableBikes,
    availableDocks: totalDocks - availableBikes,
    capacityGap: 0,
    currentState: 'normal',
    serviceStatus,
    qualityFlags: [],
    forecast: { horizons: {} },
  }
}

function event({ id = 'evt_1', name = '測試活動', stationIds, startAt, endAt = '2026-09-12T23:00', pattern = 'borrow_surge' }) {
  return { id, name, stationIds, startAt, endAt, pattern, note: '' }
}

test('a borrow_surge with one well-stocked neighbour produces a deliver_bikes dispatch from the neighbour', () => {
  const target = station({ id: 'A', totalDocks: 14, availableBikes: 5 })
  const neighbour = station({ id: 'B', totalDocks: 30, availableBikes: 28, latitude: 25.0005, longitude: 121.5005 })
  const { alerts, dispatches } = eventDrivenOperations(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45' })],
    [target, neighbour],
    OBSERVED_AT,
    NOW,
    '60',
  )

  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].condition, 'empty_forecast')
  assert.equal(alerts[0].stationId, 'A')
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].operation, 'deliver_bikes')
  assert.equal(dispatches[0].fromStationId, 'B')
  assert.equal(dispatches[0].toStationId, 'A')
  assert.equal(dispatches[0].bikeCount, 14)
})

test('a return_surge produces a remove_bikes dispatch out of the surging station into the neighbour', () => {
  const target = station({ id: 'A', totalDocks: 14, availableBikes: 10 })
  const neighbour = station({ id: 'B', totalDocks: 30, availableBikes: 2, latitude: 25.0005, longitude: 121.5005 })
  const { dispatches } = eventDrivenOperations(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45', pattern: 'return_surge' })],
    [target, neighbour],
    OBSERVED_AT,
    NOW,
    '60',
  )

  assert.equal(dispatches[0].operation, 'remove_bikes')
  assert.equal(dispatches[0].fromStationId, 'A')
  assert.equal(dispatches[0].toStationId, 'B')
})

test('demand exceeding one vehicle load splits across neighbours, each leg capped at vehicle capacity', () => {
  const target = station({ id: 'A', totalDocks: 30, availableBikes: 5 }) // needs 30
  const neighbourOne = station({ id: 'B', totalDocks: 40, availableBikes: 38, latitude: 25.0005, longitude: 121.5005 })
  const neighbourTwo = station({ id: 'C', totalDocks: 40, availableBikes: 38, latitude: 25.0006, longitude: 121.5004 })
  const neighbourThree = station({ id: 'D', totalDocks: 20, availableBikes: 10, latitude: 25.0004, longitude: 121.5006 })
  const { dispatches } = eventDrivenOperations(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45' })],
    [target, neighbourOne, neighbourTwo, neighbourThree],
    OBSERVED_AT,
    NOW,
    '60',
    { vehicleCapacity: 14 },
  )

  assert.ok(dispatches.every(dispatch => dispatch.bikeCount <= 14))
  assert.equal(dispatches.reduce((sum, dispatch) => sum + dispatch.bikeCount, 0), 30)
  assert.ok(dispatches.length >= 3)
})

test('a shortfall that cannot be fully covered marks the alert critical and reports the remaining gap', () => {
  const target = station({ id: 'A', totalDocks: 20, availableBikes: 10 })
  const neighbour = station({ id: 'B', totalDocks: 20, availableBikes: 5, latitude: 25.0005, longitude: 121.5005 })
  const { alerts, dispatches } = eventDrivenOperations(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45' })],
    [target, neighbour],
    OBSERVED_AT,
    NOW,
    '60',
  )

  assert.equal(alerts[0].severity, 'critical')
  assert.match(alerts[0].reasons.join(' '), /短少/)
  assert.ok(dispatches.length > 0) // partial allocation still proposed
})

test('horizon 30 only includes the 30-minute tier; horizon 60 includes both', () => {
  const target = station({ id: 'A', totalDocks: 14, availableBikes: 5 })
  const neighbour = station({ id: 'B', totalDocks: 30, availableBikes: 28, latitude: 25.0005, longitude: 121.5005 })
  const events = [event({ stationIds: ['A'], startAt: '2026-09-12T20:45' })] // 45 min out -> 60min tier

  const at30 = eventDrivenOperations(events, [target, neighbour], OBSERVED_AT, NOW, '30')
  const at60 = eventDrivenOperations(events, [target, neighbour], OBSERVED_AT, NOW, '60')

  assert.equal(at30.alerts.length, 0)
  assert.equal(at60.alerts.length, 1)
})
