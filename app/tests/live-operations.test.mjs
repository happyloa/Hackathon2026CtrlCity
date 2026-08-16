import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLiveOperations,
  safetyStockFor,
} from '../shared/live-operations.ts'

const OBSERVED_AT = '2026-08-09T08:00:00+08:00'

function forecast({
  predictedBikes = 10,
  predictedDocks = 10,
  emptyRisk = 0.05,
  fullRisk = 0.05,
  unavailableRisk = 0,
  level = 'normal',
  alertThreshold = 0.45,
} = {}) {
  return {
    targetAt: '2026-08-09T09:00:00+08:00',
    baselineBikes: 10,
    baselineDocks: 10,
    predictedBikes,
    predictedDocks,
    emptyRisk,
    fullRisk,
    unavailableRisk,
    riskScore: Math.max(emptyRisk, fullRisk),
    level,
    confidence: 'medium',
    alertThreshold,
    baselineStatus: 'matched',
    baselineCoverage: 'sufficient',
    method: 'historical_baseline_live_inventory',
    sampleSize: 12,
    reasons: ['已對照同站、同時段歷史基線。'],
  }
}

function station({
  id,
  name = id,
  totalDocks = 20,
  availableBikes = 10,
  availableDocks = totalDocks - availableBikes,
  latitude = 25,
  longitude = 121.5,
  currentState = 'normal',
  serviceStatus = 'operational',
  stationForecast = forecast(),
}) {
  return {
    id,
    name,
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
    forecast: {
      horizons: {
        30: { ...stationForecast },
        60: { ...stationForecast },
        120: { ...stationForecast },
      },
    },
  }
}

test('current empty station creates a stable critical alert with an explicit safety-stock reason', () => {
  const empty = station({
    id: 'empty-now',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })

  const first = buildLiveOperations([empty], OBSERVED_AT)
  const second = buildLiveOperations([empty], OBSERVED_AT)

  assert.equal(first.alerts.length, 1)
  assert.equal(first.alerts[0].condition, 'empty_now')
  assert.equal(first.alerts[0].severity, 'critical')
  assert.match(first.alerts[0].reasons.join(' '), /安全庫存/)
  assert.match(first.alerts[0].id, /^live-alert:2026-08-09T08%3A00%3A00%2B08%3A00:60:empty-now:empty_now$/)
  assert.deepEqual(first, second)
  assert.notEqual(first.alerts[0].id, buildLiveOperations([empty], '2026-08-09T08:05:00+08:00').alerts[0].id)
})

test('forecast full risk creates a full-station alert before the station is physically full', () => {
  const fullRisk = station({
    id: 'full-risk',
    availableBikes: 17,
    availableDocks: 3,
    stationForecast: forecast({ predictedBikes: 20, predictedDocks: 0, fullRisk: 0.8, level: 'critical' }),
  })

  const plan = buildLiveOperations([fullRisk], OBSERVED_AT)

  assert.equal(plan.alerts.length, 1)
  assert.equal(plan.alerts[0].condition, 'full_forecast')
  assert.equal(plan.alerts[0].riskScore, 0.8)
  assert.match(plan.alerts[0].reasons.join(' '), /60 分鐘預測可還位為 0/)
})

test('forecast empty risk creates an early alert without pretending the station is already empty', () => {
  const emptyRisk = station({
    id: 'empty-risk',
    availableBikes: 5,
    availableDocks: 15,
    stationForecast: forecast({ predictedBikes: 1, predictedDocks: 19, emptyRisk: 0.7, level: 'critical' }),
  })

  const plan = buildLiveOperations([emptyRisk], OBSERVED_AT)

  assert.equal(plan.alerts.length, 1)
  assert.equal(plan.alerts[0].condition, 'empty_forecast')
  assert.equal(plan.alerts[0].severity, 'critical')
  assert.match(plan.alerts[0].reasons.join(' '), /60 分鐘預測可借車為 1/)
})

test('pairs empty and full demand with separate nearby supply while preserving safety stock', () => {
  const empty = station({
    id: 'empty-target',
    availableBikes: 0,
    availableDocks: 20,
    latitude: 25,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const bikeSource = station({
    id: 'bike-source',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.001,
  })
  const full = station({
    id: 'full-target',
    availableBikes: 20,
    availableDocks: 0,
    latitude: 25.01,
    currentState: 'full_now',
    stationForecast: forecast({ predictedBikes: 20, predictedDocks: 0, fullRisk: 0.9, level: 'critical' }),
  })
  const dockSource = station({
    id: 'dock-source',
    availableBikes: 5,
    availableDocks: 15,
    latitude: 25.011,
  })
  const stations = [empty, bikeSource, full, dockSource]

  const plan = buildLiveOperations(stations, OBSERVED_AT, { maximumDistanceKm: 5 })
  const reversed = buildLiveOperations([...stations].reverse(), OBSERVED_AT, { maximumDistanceKm: 5 })

  assert.equal(plan.dispatches.length, 2)
  const delivery = plan.dispatches.find(item => item.operation === 'deliver_bikes')
  const removal = plan.dispatches.find(item => item.operation === 'remove_bikes')
  assert.ok(delivery)
  assert.ok(removal)
  assert.equal(delivery.fromStationId, 'bike-source')
  assert.equal(delivery.toStationId, 'empty-target')
  assert.equal(removal.fromStationId, 'full-target')
  assert.equal(removal.toStationId, 'dock-source')
  assert.ok(delivery.distanceKm > 0)
  assert.ok(removal.distanceKm > 0)
  assert.ok(bikeSource.availableBikes - delivery.bikeCount >= safetyStockFor(bikeSource))
  assert.ok(dockSource.availableDocks - removal.bikeCount >= safetyStockFor(dockSource))
  assert.ok(plan.dispatches.every(item => item.reasons.length >= 3 && item.requiresOperatorReview))

  const stationAssignments = plan.dispatches.flatMap(item => [item.fromStationId, item.toStationId])
  assert.equal(new Set(stationAssignments).size, stationAssignments.length)
  assert.deepEqual(plan.dispatches.map(item => item.id), reversed.dispatches.map(item => item.id))
})

test('allocates one stable source across multiple urgent stations before it is exhausted', () => {
  const firstEmpty = station({
    id: 'empty-a',
    availableBikes: 0,
    availableDocks: 20,
    latitude: 25,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const secondEmpty = station({
    id: 'empty-b',
    availableBikes: 0,
    availableDocks: 20,
    latitude: 25.002,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const sharedSource = station({
    id: 'shared-source',
    availableBikes: 15,
    availableDocks: 5,
    latitude: 25.001,
  })

  const plan = buildLiveOperations([firstEmpty, secondEmpty, sharedSource], OBSERVED_AT, { maximumDistanceKm: 5 })
  const deliveries = plan.dispatches.filter(item => item.operation === 'deliver_bikes')
  const bikesMoved = deliveries.reduce((total, item) => total + item.bikeCount, 0)

  assert.equal(deliveries.length, 2)
  assert.ok(deliveries.every(item => item.fromStationId === 'shared-source'))
  assert.equal(bikesMoved, 6)
  assert.ok(sharedSource.availableBikes - bikesMoved >= safetyStockFor(sharedSource))
  assert.equal(new Set(deliveries.map(item => item.toStationId)).size, 2)
})

test('keeps the alert but creates no dispatch when no source can preserve safety stock', () => {
  const empty = station({
    id: 'isolated-empty',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const noSurplus = station({
    id: 'no-surplus',
    availableBikes: 3,
    availableDocks: 17,
    latitude: 25.001,
  })

  const plan = buildLiveOperations([empty, noSurplus], OBSERVED_AT)

  assert.equal(plan.alerts.length, 1)
  assert.equal(plan.dispatches.length, 0)
  assert.match(plan.alerts[0].reasons.at(-1), /未找到 8 公里內.*可供車輛/)
})

test('never recommends moving more bikes than the physical source or destination can support', () => {
  const futureFullWithOneBike = station({
    id: 'future-full-one-bike',
    availableBikes: 1,
    availableDocks: 19,
    latitude: 25,
    stationForecast: forecast({ predictedBikes: 20, predictedDocks: 0, fullRisk: 0.9, level: 'critical' }),
  })
  const dockReceiver = station({
    id: 'dock-receiver',
    availableBikes: 5,
    availableDocks: 15,
    latitude: 25.001,
  })
  const futureEmptyWithOneDock = station({
    id: 'future-empty-one-dock',
    availableBikes: 19,
    availableDocks: 1,
    latitude: 25.01,
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const bikeSource = station({
    id: 'bike-source-for-one-dock',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.011,
  })

  const removal = buildLiveOperations([futureFullWithOneBike, dockReceiver], OBSERVED_AT).dispatches[0]
  const delivery = buildLiveOperations([futureEmptyWithOneDock, bikeSource], OBSERVED_AT).dispatches[0]

  assert.equal(removal.operation, 'remove_bikes')
  assert.equal(removal.bikeCount, 1)
  assert.equal(delivery.operation, 'deliver_bikes')
  assert.equal(delivery.bikeCount, 1)
})
