import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLiveOperations,
  buildLiveOperationsForHorizon,
  safetyStockFor,
  scoreAlertPriority,
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
  baselineStatus = 'matched',
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
    baselineStatus,
    baselineCoverage: baselineStatus === 'matched' ? 'sufficient' : 'unmatched',
    method: baselineStatus === 'matched' ? 'historical_baseline_live_inventory' : 'inventory_only',
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
  assert.equal(first.alerts[0].riskScore, 0.9)
  assert.equal(first.alerts[0].priorityScore, 83.5)
  assert.deepEqual(first.alerts[0].scoreParts, {
    forecast: 22.5,
    current: 50,
    gap: 7.5,
    quality: 3.5,
  })
  assert.equal(first.alerts[0].dispatchEligible, true)
  assert.ok(first.alerts[0].priorityScore < 100)
  assert.match(first.alerts[0].reasons.join(' '), /安全庫存/)
  assert.match(first.alerts[0].id, /^live-alert:2026-08-09T08%3A00%3A00%2B08%3A00:60:empty-now:empty_now$/)
  assert.deepEqual(first, second)
  assert.notEqual(first.alerts[0].id, buildLiveOperations([empty], '2026-08-09T08:05:00+08:00').alerts[0].id)
})

test('officially inactive stations are surfaced for review but never used for dispatch', () => {
  const empty = station({
    id: 'empty-target',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: .9, level: 'critical' }),
  })
  const officialInactive = station({
    id: 'official-inactive-source',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.001,
    currentState: 'unavailable',
    serviceStatus: 'official_inactive',
    stationForecast: forecast({ unavailableRisk: .9 }),
  })

  const plan = buildLiveOperations([empty, officialInactive], OBSERVED_AT)

  const serviceAlert = plan.alerts.find(alert => alert.stationId === 'official-inactive-source')
  assert.equal(serviceAlert.condition, 'unavailable')
  assert.equal(serviceAlert.priorityScore, 0)
  assert.deepEqual(serviceAlert.scoreParts, { forecast: 0, current: 0, gap: 0, quality: 0 })
  assert.equal(serviceAlert.dispatchEligible, false)
  assert.equal(plan.dispatches.length, 0)
})

test('service anomalies remain visible outside the inventory alert limit', () => {
  const service = station({
    id: 'service-outside-limit',
    availableBikes: 0,
    availableDocks: 0,
    currentState: 'unavailable',
    serviceStatus: 'official_inactive',
  })
  const emptyA = station({
    id: 'limited-empty-a',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    stationForecast: forecast({ emptyRisk: 0.9, predictedBikes: 0, predictedDocks: 20, level: 'critical' }),
  })
  const emptyB = station({
    id: 'limited-empty-b',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    stationForecast: forecast({ emptyRisk: 0.8, predictedBikes: 0, predictedDocks: 20, level: 'critical' }),
  })
  const source = station({
    id: 'alert-limit-source',
    totalDocks: 30,
    availableBikes: 20,
    availableDocks: 10,
  })

  const plan = buildLiveOperations([service, emptyA, emptyB, source], OBSERVED_AT, { maximumAlerts: 1 })

  assert.equal(plan.alerts.filter(alert => alert.condition !== 'unavailable').length, 2)
  assert.ok(plan.alerts.some(alert => alert.stationId === service.id && alert.condition === 'unavailable'))
  assert.equal(plan.dispatches.length, 1)
})

test('alert priority is additive, monotonic, bounded, and only saturates when every component does', () => {
  const base = {
    riskScore: 0,
    currentFailure: false,
    gap: 0,
    quality: 0,
  }

  assert.equal(scoreAlertPriority(base).priorityScore, 0)
  assert.equal(scoreAlertPriority({ ...base, riskScore: 1 }).priorityScore, 25)
  assert.equal(scoreAlertPriority({ ...base, currentFailure: true }).priorityScore, 50)
  assert.equal(scoreAlertPriority({ ...base, gap: 8 }).priorityScore, 20)
  assert.equal(scoreAlertPriority({ ...base, quality: 1 }).priorityScore, 5)
  assert.equal(scoreAlertPriority({ ...base, riskScore: 1, currentFailure: true, gap: 8, quality: 1 }).priorityScore, 100)

  const ordinary = scoreAlertPriority({ ...base, riskScore: 0.7, currentFailure: true, gap: 3, quality: 0.7 })
  const higherRisk = scoreAlertPriority({ ...base, riskScore: 0.8, currentFailure: true, gap: 3, quality: 0.7 })
  const largerGap = scoreAlertPriority({ ...base, riskScore: 0.7, currentFailure: true, gap: 4, quality: 0.7 })
  assert.ok(ordinary.priorityScore < 100)
  assert.ok(higherRisk.priorityScore > ordinary.priorityScore)
  assert.ok(largerGap.priorityScore > ordinary.priorityScore)
  assert.equal(scoreAlertPriority({ ...base, gap: 80, quality: 5 }).priorityScore, 25)
})

test('any current empty or full failure outranks the strongest forecast-only alert', () => {
  const currentFailure = scoreAlertPriority({
    riskScore: 0,
    currentFailure: true,
    gap: 2,
    quality: 0,
  })
  const forecastOnlyMaximum = scoreAlertPriority({
    riskScore: 1,
    currentFailure: false,
    gap: 8,
    quality: 1,
  })

  assert.equal(currentFailure.priorityScore, 55)
  assert.equal(forecastOnlyMaximum.priorityScore, 50)
  assert.ok(currentFailure.priorityScore > forecastOnlyMaximum.priorityScore)
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

test('uses separate nearby supply when complementary risks are outside the pairing radius', () => {
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

  const plan = buildLiveOperations(stations, OBSERVED_AT, { maximumDistanceKm: 0.5 })
  const reversed = buildLiveOperations([...stations].reverse(), OBSERVED_AT, { maximumDistanceKm: 0.5 })

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

test('directly pairs complementary full and empty risks without duplicate reverse dispatches', () => {
  const empty = station({
    id: 'direct-empty',
    availableBikes: 0,
    availableDocks: 20,
    latitude: 25,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const full = station({
    id: 'direct-full',
    availableBikes: 20,
    availableDocks: 0,
    latitude: 25.001,
    currentState: 'full_now',
    stationForecast: forecast({ predictedBikes: 20, predictedDocks: 0, fullRisk: 0.9, level: 'critical' }),
  })

  const plan = buildLiveOperations([empty, full], OBSERVED_AT)

  assert.equal(plan.dispatches.length, 1)
  assert.equal(plan.dispatches[0].fromStationId, full.id)
  assert.equal(plan.dispatches[0].toStationId, empty.id)
  assert.equal(plan.dispatches[0].bikeCount, 3)
  assert.match(plan.dispatches[0].reasons.join(' '), /相反庫存壓力/)
  assert.ok(full.availableBikes - plan.dispatches[0].bikeCount >= safetyStockFor(full))
  assert.ok(empty.availableDocks - plan.dispatches[0].bikeCount >= safetyStockFor(empty))
})

test('accounts for both gaps after a partial complementary transfer before using fallback supply', () => {
  const empty = station({
    id: 'partial-empty',
    totalDocks: 40,
    availableBikes: 0,
    availableDocks: 40,
    latitude: 25,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 40, emptyRisk: 0.9, level: 'critical' }),
  })
  const full = station({
    id: 'partial-full',
    availableBikes: 20,
    availableDocks: 0,
    latitude: 25.001,
    currentState: 'full_now',
    stationForecast: forecast({ predictedBikes: 20, predictedDocks: 0, fullRisk: 0.9, level: 'critical' }),
  })
  const fallback = station({
    id: 'partial-fallback',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.002,
  })

  const plan = buildLiveOperations([empty, full, fallback], OBSERVED_AT)
  const deliveries = plan.dispatches.filter(item => item.toStationId === empty.id)

  assert.equal(deliveries.length, 2)
  assert.equal(deliveries.reduce((total, item) => total + item.bikeCount, 0), 6)
  assert.equal(deliveries.filter(item => item.fromStationId === full.id).length, 1)
  assert.equal(plan.dispatches.filter(item => item.fromStationId === empty.id && item.toStationId === full.id).length, 0)
})

test('nearer feasible supply produces a higher dispatch priority than farther supply', () => {
  const target = station({
    id: 'distance-target',
    availableBikes: 0,
    availableDocks: 20,
    latitude: 25,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.7, level: 'critical' }),
  })
  const near = station({
    id: 'near-source',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.001,
  })
  const far = station({
    id: 'far-source',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.02,
  })

  const combined = buildLiveOperations([target, far, near], OBSERVED_AT, { maximumDistanceKm: 5 })
  const nearOnly = buildLiveOperations([target, near], OBSERVED_AT, { maximumDistanceKm: 5 }).dispatches[0]
  const farOnly = buildLiveOperations([target, far], OBSERVED_AT, { maximumDistanceKm: 5 }).dispatches[0]

  assert.equal(combined.dispatches[0].fromStationId, 'near-source')
  assert.ok(nearOnly.distanceKm < farOnly.distanceKm)
  assert.ok(nearOnly.priorityScore > farOnly.priorityScore)
})

test('prefers a slightly farther source when it covers the whole gap instead of one bike', () => {
  const target = station({
    id: 'coverage-target',
    availableBikes: 0,
    availableDocks: 20,
    latitude: 25,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.8, level: 'critical' }),
  })
  const nearPartial = station({
    id: 'near-partial-source',
    availableBikes: 4,
    availableDocks: 16,
    latitude: 25.0005,
  })
  const fartherComplete = station({
    id: 'farther-complete-source',
    availableBikes: 10,
    availableDocks: 10,
    latitude: 25.002,
  })

  const plan = buildLiveOperations([target, nearPartial, fartherComplete], OBSERVED_AT)

  assert.equal(plan.dispatches[0].fromStationId, fartherComplete.id)
  assert.equal(plan.dispatches[0].bikeCount, 3)
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

test('keeps a current inventory alert but does not use an unmatched station as forecast-safe supply', () => {
  const empty = station({
    id: 'empty-with-unmatched-source',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: .9, level: 'critical' }),
  })
  const inventoryOnlySource = station({
    id: 'inventory-only-source',
    availableBikes: 15,
    availableDocks: 5,
    latitude: 25.001,
    stationForecast: forecast({ predictedBikes: 15, predictedDocks: 5, baselineStatus: 'unmatched' }),
  })

  const plan = buildLiveOperations([empty, inventoryOnlySource], OBSERVED_AT)

  assert.equal(plan.alerts.length, 1)
  assert.equal(plan.dispatches.length, 0)
})

test('never recommends moving more than the one bike or dock available above safety stock', () => {
  const futureFullWithOneSurplusBike = station({
    id: 'future-full-one-surplus-bike',
    totalDocks: 10,
    availableBikes: 4, // safety stock is max(3, ceil(10 * 0.15)) = 3, so this is exactly one bike above it
    availableDocks: 6,
    latitude: 25,
    stationForecast: forecast({ predictedBikes: 10, predictedDocks: 0, fullRisk: 0.9, level: 'critical' }),
  })
  const dockReceiver = station({
    id: 'dock-receiver',
    availableBikes: 5,
    availableDocks: 15,
    latitude: 25.001,
  })
  const futureEmptyWithOneSurplusDock = station({
    id: 'future-empty-one-surplus-dock',
    availableBikes: 16,
    availableDocks: 4,
    latitude: 25.01,
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const bikeSource = station({
    id: 'bike-source-for-one-dock',
    availableBikes: 12,
    availableDocks: 8,
    latitude: 25.011,
  })

  const removal = buildLiveOperations([futureFullWithOneSurplusBike, dockReceiver], OBSERVED_AT).dispatches[0]
  const delivery = buildLiveOperations([futureEmptyWithOneSurplusDock, bikeSource], OBSERVED_AT).dispatches[0]

  assert.equal(removal.operation, 'remove_bikes')
  assert.equal(removal.bikeCount, 1)
  assert.equal(delivery.operation, 'deliver_bikes')
  assert.equal(delivery.bikeCount, 1)
})

test('"now" only surfaces stations already empty or full, leaving forecast-only risk for the wider horizons', () => {
  const currentlyEmpty = station({
    id: 'currently-empty',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
  })
  const forecastOnly = station({
    id: 'forecast-only',
    availableBikes: 5,
    availableDocks: 15,
    latitude: 25.001,
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const source = station({
    id: 'ample-source',
    totalDocks: 40,
    availableBikes: 35,
    availableDocks: 5,
    latitude: 25.002,
  })

  const now = buildLiveOperationsForHorizon([currentlyEmpty, forecastOnly, source], OBSERVED_AT, 'now')

  assert.deepEqual(now.dispatches.map(dispatch => dispatch.toStationId), [currentlyEmpty.id])
  assert.ok(
    !now.alerts.some(alert => alert.stationId === forecastOnly.id),
    '"now" must not surface a station that has not failed yet, only predicted to',
  )
})

test('"30" widens "now" to also cover stations forecast to fail within 30 minutes', () => {
  const currentlyEmpty = station({
    id: 'currently-empty-30',
    availableBikes: 0,
    availableDocks: 20,
    currentState: 'empty_now',
  })
  const forecastOnly = station({
    id: 'forecast-only-30',
    availableBikes: 5,
    availableDocks: 15,
    latitude: 25.001,
    stationForecast: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
  })
  const source = station({
    id: 'ample-source-30',
    totalDocks: 40,
    availableBikes: 35,
    availableDocks: 5,
    latitude: 25.002,
  })
  const stations = [currentlyEmpty, forecastOnly, source]

  const now = buildLiveOperationsForHorizon(stations, OBSERVED_AT, 'now')
  const thirty = buildLiveOperationsForHorizon(stations, OBSERVED_AT, '30')

  const nowStationIds = new Set(now.dispatches.map(dispatch => dispatch.toStationId))
  const thirtyStationIds = new Set(thirty.dispatches.map(dispatch => dispatch.toStationId))
  assert.ok([...nowStationIds].every(id => thirtyStationIds.has(id)), '30-minute view must retain every "now" station')
  assert.ok(thirtyStationIds.has(forecastOnly.id), '30-minute view must add the forecast-only station')
})

test('"60" keeps every station already picked up at "30", even if that station\'s own 60-minute forecast has recovered', () => {
  const recovering = {
    id: 'recovering-at-60',
    name: 'recovering-at-60',
    city: '新北市',
    district: '板橋區',
    latitude: 25.001,
    longitude: 121.5,
    totalDocks: 20,
    availableBikes: 1,
    availableDocks: 19,
    capacityGap: 0,
    currentState: 'normal',
    serviceStatus: 'operational',
    qualityFlags: [],
    forecast: {
      horizons: {
        30: forecast({ predictedBikes: 0, predictedDocks: 20, emptyRisk: 0.9, level: 'critical' }),
        60: forecast({ predictedBikes: 15, predictedDocks: 5, emptyRisk: 0.05, level: 'normal' }),
      },
    },
  }
  const source = station({
    id: 'source-for-recovering',
    totalDocks: 20,
    availableBikes: 15,
    availableDocks: 5,
    latitude: 25,
  })
  const stations = [recovering, source]

  const naiveSixtyOnly = buildLiveOperations(stations, OBSERVED_AT, { horizon: '60' })
  assert.equal(naiveSixtyOnly.dispatches.length, 0, 'a bare 60-minute call would miss the recovering station')

  const sixty = buildLiveOperationsForHorizon(stations, OBSERVED_AT, '60')
  assert.deepEqual(sixty.dispatches.map(dispatch => dispatch.toStationId), [recovering.id])
})
