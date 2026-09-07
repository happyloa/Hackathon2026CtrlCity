import assert from 'node:assert/strict'
import test from 'node:test'

import { nearbyBorrowStations, nearbyReturnStations } from '../shared/nearby-stations.ts'

function station({
  id,
  latitude,
  longitude = 121.5,
  availableBikes = 10,
  availableDocks = 10,
  totalDocks = 20,
  currentState = 'normal',
  serviceStatus = 'operational',
  fullRisk = 0.05,
  emptyRisk = 0.05,
  predictedBikes = availableBikes,
  predictedDocks = availableDocks,
  baselineStatus = 'matched',
}) {
  const forecast = {
    targetAt: '2026-08-09T09:00:00+08:00',
    baselineBikes: availableBikes,
    baselineDocks: availableDocks,
    predictedBikes,
    predictedDocks,
    emptyRisk,
    fullRisk,
    unavailableRisk: 0,
    riskScore: Math.max(.05, fullRisk, emptyRisk),
    level: Math.max(fullRisk, emptyRisk) >= .45 ? 'high' : 'normal',
    confidence: 'medium',
    alertThreshold: .45,
    baselineStatus,
    baselineCoverage: baselineStatus === 'matched' ? 'sufficient' : 'unmatched',
    method: baselineStatus === 'matched' ? 'historical_replay' : 'inventory_only',
    sampleSize: 12,
    reasons: [],
  }

  return {
    id,
    name: `YouBike 2.0_${id}`,
    city: '新北市',
    district: '板橋區',
    latitude,
    longitude,
    totalDocks,
    availableBikes,
    availableDocks,
    capacityGap: totalDocks - availableBikes - availableDocks,
    currentState,
    serviceStatus,
    qualityFlags: [],
    forecast: { horizons: { 30: { ...forecast }, 60: { ...forecast }, 120: { ...forecast } } },
  }
}

test('offers only nearby operational stations that retain a safe return capacity', () => {
  const fullTarget = station({
    id: 'full-target',
    latitude: 25,
    availableBikes: 20,
    availableDocks: 0,
    currentState: 'full_now',
    fullRisk: .9,
    predictedDocks: 0,
  })
  const safeNearby = station({ id: 'safe-nearby', latitude: 25.003, availableBikes: 12, availableDocks: 8 })
  const riskyNearby = station({ id: 'risky-nearby', latitude: 25.002, fullRisk: .8, predictedDocks: 0 })
  const farAway = station({ id: 'far-away', latitude: 25.01, availableBikes: 12, availableDocks: 8 })
  const unavailable = station({ id: 'unavailable', latitude: 25.001, serviceStatus: 'official_inactive' })
  const inventoryOnly = station({ id: 'inventory-only', latitude: 25.0005, availableDocks: 12, baselineStatus: 'unmatched' })

  const choices = nearbyReturnStations(fullTarget, [fullTarget, safeNearby, riskyNearby, farAway, unavailable, inventoryOnly], '60')

  assert.deepEqual(choices.map(choice => choice.stationId), ['safe-nearby'])
  assert.equal(choices[0].name, 'safe-nearby')
  assert.ok(choices[0].distanceMeters <= 600)
})

test('offers only nearby operational stations that retain a safe borrow supply', () => {
  const emptyTarget = station({
    id: 'empty-target',
    latitude: 25,
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    emptyRisk: .9,
    predictedBikes: 0,
  })
  const safeNearby = station({ id: 'safe-nearby', latitude: 25.003, availableBikes: 8, availableDocks: 12 })
  const riskyNearby = station({ id: 'risky-nearby', latitude: 25.002, emptyRisk: .8, predictedBikes: 0 })
  const farAway = station({ id: 'far-away', latitude: 25.01, availableBikes: 8, availableDocks: 12 })
  const unavailable = station({ id: 'unavailable', latitude: 25.001, serviceStatus: 'official_inactive' })
  const inventoryOnly = station({ id: 'inventory-only', latitude: 25.0005, availableBikes: 12, baselineStatus: 'unmatched' })

  const choices = nearbyBorrowStations(emptyTarget, [emptyTarget, safeNearby, riskyNearby, farAway, unavailable, inventoryOnly], '60')

  assert.deepEqual(choices.map(choice => choice.stationId), ['safe-nearby'])
  assert.equal(choices[0].name, 'safe-nearby')
  assert.ok(choices[0].distanceMeters <= 600)
})
