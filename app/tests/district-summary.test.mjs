import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeStationDistricts, districtAttentionTone } from '../shared/district-summary.ts'

function station(id, district, overrides = {}) {
  return { id, name: id, district, serviceStatus: 'operational', currentState: 'normal', availableBikes: 10, availableDocks: 20,
    forecast: { horizons: { 60: { baselineStatus: 'matched', riskScore: .2, level: 'normal' } } }, ...overrides }
}

test('district totals partition station statuses and separate current failures from forecasts', () => {
  const stations = [station('a', '板橋區', { currentState: 'empty_now' }), station('b', '板橋區'), station('c', '板橋區'), station('d', '三重區', { currentState: 'full_now' })]
  const results = summarizeStationDistricts(stations, [{ stationId: 'b', condition: 'full_forecast' }])
  assert.equal(results[0].district, '板橋區')
  assert.deepEqual(results[0].counts, { empty: 1, full: 1, stable: 1, unknown: 0, service: 0 })
  assert.equal(results[0].emptyNow, 1)
  assert.equal(results[0].fullNow, 0)
  assert.equal(results[0].attentionRate, 2 / 3)
  assert.equal(results.reduce((sum, item) => sum + item.total, 0), stations.length)
  assert.deepEqual(summarizeStationDistricts([...stations].reverse(), [{ stationId: 'b', condition: 'full_forecast' }]), results)
})

test('risk averages exclude unavailable and unmatched predictions rather than treating them as zero', () => {
  const forecast = (riskScore, baselineStatus, level = 'high') => ({ horizons: { 60: { riskScore, baselineStatus, level } } })
  const [summary] = summarizeStationDistricts([
    station('a', '板橋區', { forecast: forecast(.8, 'matched') }),
    station('b', '板橋區', { forecast: forecast(.2, 'matched', 'normal') }),
    station('c', '板橋區', { forecast: forecast(0, 'unmatched') }),
    station('d', '板橋區', { currentState: 'empty_now', serviceStatus: 'official_inactive', forecast: forecast(1, 'matched') }),
  ], [])
  assert.equal(summary.averageRisk, 50)
  assert.equal(summary.forecastStations, 2)
  assert.equal(summary.highRiskStations, 1)
  assert.equal(summary.counts.service, 1)
  assert.equal(summary.emptyNow, 0)
  assert.equal(summary.availableBikes, 30)
})

test('districts without forecast coverage remain explicit and the map uses attention share', () => {
  assert.deepEqual(summarizeStationDistricts([], []), [])
  const [unknown] = summarizeStationDistricts([station('a', '偏遠區', { forecast: { horizons: { 60: { baselineStatus: 'unmatched', riskScore: 0 } } } })], [])
  assert.equal(unknown.averageRisk, null)
  assert.equal(districtAttentionTone(unknown), 'none')
  assert.equal(districtAttentionTone(), 'none')
  for (const [count, tone] of [[0, 'quiet'], [1, 'low'], [2, 'medium'], [3, 'high']]) {
    const stations = Array.from({ length: 10 }, (_, i) => station(String(i), '板橋區', { currentState: i < count ? 'empty_now' : 'normal' }))
    assert.equal(districtAttentionTone(summarizeStationDistricts(stations, [])[0]), tone)
  }
})
