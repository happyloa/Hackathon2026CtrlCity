import assert from 'node:assert/strict'
import test from 'node:test'

import { nextUpcomingSurgePhase, upcomingDemandSurgeImpacts } from '../shared/demand-surge-impact.ts'

const NOW = Date.parse('2026-09-12T20:00:00Z') // pseudo-UTC wall clock, matches parseLocalDateTime

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

function event({ id = 'evt_1', name = '測試活動', stationIds, startAt, endAt = '2026-09-12T23:00', pattern = 'borrow_surge', note = '' }) {
  return { id, name, stationIds, startAt, endAt, pattern, note }
}

test('a single-phase borrow_surge event 45 minutes out is tagged 60min tier, and neighbours with enough spare bikes can cover it', () => {
  const target = station({ id: 'A', totalDocks: 20, availableBikes: 10 })
  const neighbour = station({ id: 'B', totalDocks: 30, availableBikes: 28, latitude: 25.0005, longitude: 121.5005 })
  const impacts = upcomingDemandSurgeImpacts(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45' })],
    [target, neighbour],
    NOW,
  )

  assert.equal(impacts.length, 1)
  assert.equal(impacts[0].effect, 'borrow_surge')
  assert.equal(impacts[0].tier, '60min')
  assert.equal(impacts[0].leadMinutes, 45)
  assert.equal(impacts[0].estimatedDemand, 20)
  assert.deepEqual(impacts[0].neighbourStationIds, ['B'])
  assert.equal(impacts[0].canAbsorb, true)
  assert.equal(impacts[0].shortfall, 0)
})

test('a return_surge event checks neighbour dock headroom, not bike headroom', () => {
  const target = station({ id: 'A', totalDocks: 20, availableBikes: 10 }) // 10 available docks
  const neighbourWithDocks = station({ id: 'B', totalDocks: 30, availableBikes: 2, latitude: 25.0005, longitude: 121.5005 }) // 28 available docks, few bikes
  const impacts = upcomingDemandSurgeImpacts(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45', pattern: 'return_surge' })],
    [target, neighbourWithDocks],
    NOW,
  )

  assert.equal(impacts[0].effect, 'return_surge')
  assert.equal(impacts[0].canAbsorb, true) // plenty of dock headroom despite few bikes
})

test('fills_then_empties produces a return_surge phase at startAt and a borrow_surge phase at endAt', () => {
  const target = station({ id: 'A', totalDocks: 20, availableBikes: 10 })
  const neighbour = station({ id: 'B', totalDocks: 30, availableBikes: 28, latitude: 25.0005, longitude: 121.5005 })
  const impacts = upcomingDemandSurgeImpacts(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45', endAt: '2026-09-12T20:20', pattern: 'fills_then_empties' })],
    [target, neighbour],
    NOW,
  )

  const byEffect = Object.fromEntries(impacts.map(item => [item.effect, item]))
  assert.equal(byEffect.return_surge.tier, '60min')
  assert.equal(byEffect.borrow_surge.tier, '30min')
})

test('a shortfall is reported when neighbours are thin', () => {
  const target = station({ id: 'A', totalDocks: 20, availableBikes: 10 })
  const neighbour = station({ id: 'B', totalDocks: 20, availableBikes: 5, latitude: 25.0005, longitude: 121.5005 })
  const impacts = upcomingDemandSurgeImpacts(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:20' })],
    [target, neighbour],
    NOW,
  )

  assert.equal(impacts[0].tier, '30min')
  assert.equal(impacts[0].canAbsorb, false)
  assert.ok(impacts[0].shortfall > 0)
  assert.match(impacts[0].reasons[0], /短少/)
})

test('an event covering multiple stations produces one impact per station', () => {
  const a = station({ id: 'A' })
  const b = station({ id: 'B', latitude: 25.01, longitude: 121.51 })
  const impacts = upcomingDemandSurgeImpacts(
    [event({ stationIds: ['A', 'B'], startAt: '2026-09-12T20:45' })],
    [a, b],
    NOW,
  )

  assert.deepEqual(impacts.map(item => item.stationId).sort(), ['A', 'B'])
})

test('a station with no operational neighbour within 500m reports it cannot be assessed', () => {
  const target = station({ id: 'A', totalDocks: 20, availableBikes: 10 })
  const far = station({ id: 'B', totalDocks: 20, availableBikes: 20, latitude: 26, longitude: 122 })
  const impacts = upcomingDemandSurgeImpacts(
    [event({ stationIds: ['A'], startAt: '2026-09-12T20:45' })],
    [target, far],
    NOW,
  )

  assert.equal(impacts[0].neighbourStationIds.length, 0)
  assert.equal(impacts[0].canAbsorb, false)
  assert.match(impacts[0].reasons[0], /無法評估/)
})

test('nextUpcomingSurgePhase finds the nearest future phase even when it is outside the 60-minute window', () => {
  const farEvent = event({ id: 'far', stationIds: ['A'], startAt: '2026-09-12T23:30', endAt: '2026-09-13T01:00', pattern: 'empties_then_fills' })
  assert.equal(upcomingDemandSurgeImpacts([farEvent], [station({ id: 'A' })], NOW).length, 0)

  const next = nextUpcomingSurgePhase([farEvent], NOW)
  assert.equal(next.eventName, '測試活動')
  assert.equal(next.phaseLabel, '開場借車潮')
  assert.equal(next.leadMinutes, 210)
})

test('nextUpcomingSurgePhase returns null once every phase of every event is in the past', () => {
  const pastEvent = event({ id: 'past', stationIds: ['A'], startAt: '2026-09-12T18:00', endAt: '2026-09-12T19:00' })
  assert.equal(nextUpcomingSurgePhase([pastEvent], NOW), null)
})

test('events outside the 60-minute lead window, already started, or for unknown stations are ignored', () => {
  const target = station({ id: 'A' })
  const impacts = upcomingDemandSurgeImpacts(
    [
      event({ id: 'too_far', stationIds: ['A'], startAt: '2026-09-12T22:00' }),
      event({ id: 'already_started', stationIds: ['A'], startAt: '2026-09-12T19:00' }),
      event({ id: 'unknown_station', stationIds: ['Z'], startAt: '2026-09-12T20:45' }),
    ],
    [target],
    NOW,
  )

  assert.deepEqual(impacts, [])
})
