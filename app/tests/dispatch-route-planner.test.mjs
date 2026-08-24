import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDispatchRoutePlans } from '../shared/dispatch-route-planner.ts'

function forecast() {
  return {
    targetAt: '2026-08-24T09:00:00+08:00',
    baselineBikes: 10,
    baselineDocks: 10,
    predictedBikes: 10,
    predictedDocks: 10,
    emptyRisk: 0.05,
    fullRisk: 0.05,
    unavailableRisk: 0,
    riskScore: 0.05,
    level: 'normal',
    confidence: 'high',
    alertThreshold: 0.45,
    baselineStatus: 'matched',
    baselineCoverage: 'sufficient',
    method: 'historical_baseline_live_inventory',
    sampleSize: 30,
    reasons: [],
  }
}

function station({
  id,
  latitude,
  longitude = 121.5,
  availableBikes = 10,
  availableDocks = 10,
  serviceStatus = 'operational',
  currentState = 'normal',
}) {
  const stationForecast = forecast()
  return {
    id,
    name: id,
    city: '新北市',
    district: '板橋區',
    latitude,
    longitude,
    totalDocks: availableBikes + availableDocks,
    availableBikes,
    availableDocks,
    capacityGap: 0,
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

function dispatch({ id, from, to, bikeCount = 4, priorityScore = 90, operation = 'deliver_bikes' }) {
  return {
    id,
    alertId: `alert:${id}`,
    operation,
    fromStationId: from,
    toStationId: to,
    bikeCount,
    distanceKm: 1,
    priorityScore,
    reasons: [],
    status: 'proposed',
    requiresOperatorReview: true,
  }
}

test('groups adjacent recommendations into one capacity-safe multi-stop heuristic route', () => {
  const stations = [
    station({ id: 'shared-source', latitude: 25, availableBikes: 20, availableDocks: 10 }),
    station({ id: 'urgent-target', latitude: 25.005, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'next-target', latitude: 25.007, longitude: 121.502, availableBikes: 0, availableDocks: 20 }),
  ]
  const dispatches = [
    dispatch({ id: 'urgent', from: 'shared-source', to: 'urgent-target', priorityScore: 96 }),
    dispatch({ id: 'next', from: 'shared-source', to: 'next-target', priorityScore: 80 }),
  ]

  const result = buildDispatchRoutePlans(dispatches, stations, {
    vehicleCapacity: 8,
    maximumAdjacentTaskDistanceKm: 2,
  })

  assert.equal(result.routes.length, 1)
  assert.equal(result.unplannedDispatches.length, 0)
  const route = result.routes[0]
  assert.equal(route.taskCount, 2)
  assert.equal(route.totalTransferBikes, 8)
  assert.equal(route.peakVehicleLoad, 8)
  assert.equal(route.vehicleCapacity, 8)
  assert.deepEqual(route.dispatchIds, ['urgent', 'next'])
  assert.deepEqual(route.stops.map(stop => stop.stationId), ['shared-source', 'urgent-target', 'next-target'])
  assert.equal(route.stops[0].pickupBikes, 8)
  assert.equal(route.stops.at(-1).vehicleLoadAfter, 0)
  assert.equal(route.planningMethod, 'priority_adjacent_insertion_heuristic')
  assert.equal(route.distanceBasis, 'station_straight_line')
  assert.match(route.reasons.join(' '), /啟發式建議路線/)
})

test('returns to a source when combined pickup volume would exceed vehicle capacity', () => {
  const stations = [
    station({ id: 'source', latitude: 25, availableBikes: 20, availableDocks: 10 }),
    station({ id: 'target-a', latitude: 25.003, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'target-b', latitude: 25.006, availableBikes: 0, availableDocks: 20 }),
  ]
  const dispatches = [
    dispatch({ id: 'a', from: 'source', to: 'target-a', bikeCount: 5, priorityScore: 95 }),
    dispatch({ id: 'b', from: 'source', to: 'target-b', bikeCount: 5, priorityScore: 80 }),
  ]

  const { routes } = buildDispatchRoutePlans(dispatches, stations, {
    vehicleCapacity: 8,
    maximumStopsPerRoute: 4,
    maximumAdjacentTaskDistanceKm: 2,
  })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].taskCount, 2)
  assert.equal(routes[0].peakVehicleLoad, 5)
  assert.equal(routes[0].stops.filter(stop => stop.stationId === 'source').length, 2)
  assert.equal(routes[0].stops.at(-1).vehicleLoadAfter, 0)
})

test('orders mixed tasks by the station where each risk is actually relieved', () => {
  const stations = [
    station({ id: 'high-bike-source', latitude: 25, availableBikes: 20, availableDocks: 10 }),
    station({ id: 'high-empty-target', latitude: 25.001, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'mid-full-source', latitude: 25.002, availableBikes: 17, availableDocks: 3 }),
    station({ id: 'low-bike-source', latitude: 25.003, availableBikes: 15, availableDocks: 5 }),
    station({ id: 'low-empty-target', latitude: 25.004, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'mid-dock-target', latitude: 25.005, availableBikes: 5, availableDocks: 15 }),
  ]
  const dispatches = [
    dispatch({ id: 'high-delivery', from: 'high-bike-source', to: 'high-empty-target', bikeCount: 3, priorityScore: 96 }),
    dispatch({ id: 'mid-removal', from: 'mid-full-source', to: 'mid-dock-target', bikeCount: 3, priorityScore: 90, operation: 'remove_bikes' }),
    dispatch({ id: 'low-delivery', from: 'low-bike-source', to: 'low-empty-target', bikeCount: 3, priorityScore: 70 }),
  ]

  const result = buildDispatchRoutePlans(dispatches, stations, {
    vehicleCapacity: 6,
    maximumAdjacentTaskDistanceKm: 2,
    priorityOrderTolerance: 0,
  })

  assert.equal(result.routes.length, 1)
  const priorityById = new Map(dispatches.map(item => [item.id, item.priorityScore]))
  const servicedPriorities = result.routes[0].stops.flatMap(stop => stop.allocations
    .filter(allocation => allocation.operation === 'deliver_bikes'
      ? allocation.action === 'dropoff'
      : allocation.action === 'pickup')
    .map(allocation => priorityById.get(allocation.dispatchId)))
  assert.deepEqual(servicedPriorities, [96, 90, 70])
  assert.ok(result.routes[0].stops.findIndex(stop => stop.stationId === 'mid-full-source')
    < result.routes[0].stops.findIndex(stop => stop.stationId === 'low-empty-target'))
})

test('reserves source bikes and destination docks across all selected recommendations', () => {
  const stations = [
    station({ id: 'limited-source', latitude: 25, availableBikes: 7, availableDocks: 13 }),
    station({ id: 'target-a', latitude: 25.002, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'target-b', latitude: 25.004, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'dock-source', latitude: 25.005, availableBikes: 15, availableDocks: 5 }),
    station({ id: 'dock-limited', latitude: 25.006, availableBikes: 16, availableDocks: 4 }),
  ]
  const dispatches = [
    dispatch({ id: 'source-high', from: 'limited-source', to: 'target-a', bikeCount: 3, priorityScore: 95 }),
    dispatch({ id: 'source-low', from: 'limited-source', to: 'target-b', bikeCount: 3, priorityScore: 70 }),
    dispatch({ id: 'dock-risk', from: 'dock-source', to: 'dock-limited', bikeCount: 2, priorityScore: 60 }),
  ]

  const result = buildDispatchRoutePlans(dispatches, stations)

  assert.deepEqual(result.routes.flatMap(route => route.dispatchIds), ['source-high'])
  assert.deepEqual(result.unplannedDispatches.map(item => [item.dispatchId, item.code]), [
    ['dock-risk', 'destination_safety_stock'],
    ['source-low', 'source_safety_stock'],
  ])
})

test('separates distant recommendations and remains deterministic for reversed input', () => {
  const stations = [
    station({ id: 'west-source', latitude: 25, longitude: 121.45, availableBikes: 15, availableDocks: 5 }),
    station({ id: 'west-target', latitude: 25.002, longitude: 121.45, availableBikes: 0, availableDocks: 20 }),
    station({ id: 'east-source', latitude: 25, longitude: 121.55, availableBikes: 15, availableDocks: 5 }),
    station({ id: 'east-target', latitude: 25.002, longitude: 121.55, availableBikes: 0, availableDocks: 20 }),
  ]
  const dispatches = [
    dispatch({ id: 'west', from: 'west-source', to: 'west-target', priorityScore: 91 }),
    dispatch({ id: 'east', from: 'east-source', to: 'east-target', priorityScore: 89 }),
  ]
  const options = { maximumAdjacentTaskDistanceKm: 1 }

  const first = buildDispatchRoutePlans(dispatches, stations, options)
  const reversed = buildDispatchRoutePlans([...dispatches].reverse(), [...stations].reverse(), options)

  assert.equal(first.routes.length, 2)
  assert.deepEqual(first, reversed)
})

test('excludes unavailable stations and tasks larger than the configured vehicle', () => {
  const stations = [
    station({ id: 'source', latitude: 25, availableBikes: 20, availableDocks: 10 }),
    station({
      id: 'inactive-target',
      latitude: 25.002,
      availableBikes: 0,
      availableDocks: 20,
      serviceStatus: 'official_inactive',
      currentState: 'unavailable',
    }),
    station({ id: 'active-target', latitude: 25.004, availableBikes: 0, availableDocks: 20 }),
  ]
  const dispatches = [
    dispatch({ id: 'inactive', from: 'source', to: 'inactive-target', bikeCount: 4 }),
    dispatch({ id: 'too-large', from: 'source', to: 'active-target', bikeCount: 9 }),
  ]

  const result = buildDispatchRoutePlans(dispatches, stations, { vehicleCapacity: 8 })

  assert.equal(result.routes.length, 0)
  assert.deepEqual(result.unplannedDispatches.map(item => item.code).sort(), [
    'station_unavailable',
    'vehicle_capacity_exceeded',
  ])
})
