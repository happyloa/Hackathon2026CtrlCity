import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
const { alignToBucket, createCaptureHandler, mergePersistence, rawKeyFor } = await import('../aws/capture.ts')

const at = (iso) => new Date(iso)
const station = (id, bikes, docks, state = 'normal') => ({ id, availableBikes: bikes, availableDocks: docks, currentState: state })

test('carries stateSince while the state persists and resets when it changes', () => {
  const first = mergePersistence(null, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:00:00Z'))
  let second = first
  for (let minutes = 5; minutes <= 65; minutes += 5) second = mergePersistence(second, [station('a', 0, 20, 'empty_now')], new Date(Date.parse('2026-09-12T01:00:00Z') + minutes * 60000))
  assert.equal(second.stations.a.stateSince, '2026-09-12T01:00:00.000Z')
  assert.equal(second.stations.a.stateMinutes, 65)
  assert.equal(second.stations.a.unchangedMinutes, 65)
  const third = mergePersistence(second, [station('a', 3, 17, 'normal')], at('2026-09-12T02:10:00Z'))
  assert.equal(third.stations.a.stateMinutes, 0)
  assert.equal(third.stations.a.unchangedMinutes, 0)
})

test('resets everything after a gap longer than 15 minutes', () => {
  const first = mergePersistence(null, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:00:00Z'))
  const late = mergePersistence(first, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:20:00Z'))
  assert.equal(late.stations.a.stateMinutes, 0)
})

test('aligns to 5-minute buckets and partitions raw keys by Taipei date', () => {
  assert.equal(alignToBucket(at('2026-09-12T01:04:59Z')).toISOString(), '2026-09-12T01:00:00.000Z')
  assert.equal(rawKeyFor(at('2026-09-12T17:05:00Z')), 'raw/2026/09/13/0105.json.gz')
})

test('handler writes raw, latest and state objects', async () => {
  process.env.SITE_BUCKET = 'site'
  process.env.HISTORY_BUCKET = 'history'
  const feed = [{ sno: '500201001', sna: 'YouBike2.0_下庄市場', sarea: '八里區', tot_quantity: '20', sbi_quantity: '0', bemp: '20', act: '1', lat: '25.1', lng: '121.4', mday: '20260912T090000' }]
  const puts = []
  const s3 = { send: async (command) => {
    if (command.constructor.name === 'GetObjectCommand') throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
    puts.push(command.input); return {}
  } }
  const handler = createCaptureHandler({ s3, fetchImpl: async () => new Response(JSON.stringify(feed)), now: () => at('2026-09-12T01:02:00Z') })
  const result = await handler()
  assert.equal(result.stations, 1)
  assert.deepEqual(puts.map(p => p.Key).sort(), ['raw/2026/09/12/0900.json.gz', 'snapshots/latest.json', 'state/persistence.json'])
  const raw = puts.find(p => p.Key.startsWith('raw/'))
  assert.equal(raw.Bucket, 'history')
  assert.ok(puts.filter(p => !p.Key.startsWith('raw/')).every(p => p.Bucket === 'site'))
  assert.deepEqual(JSON.parse(gunzipSync(raw.Body).toString()), feed)
  const state = JSON.parse(puts.find(p => p.Key === 'state/persistence.json').Body)
  assert.equal(state.stations['500201001'].currentState, 'empty_now')
})

const {
  freshPersistence, hasServerRuns, lowBikesIdsFromPersistence, frozenStationsFromPersistence,
} = await import('../shared/station-persistence.ts')

/** Replays one capture every 5 minutes, the way the scheduler actually runs. */
function replay(readings, fromIso, count) {
  let state = null
  let epoch = Date.parse(fromIso)
  for (let i = 0; i < count; i += 1, epoch += 5 * 60_000) {
    state = mergePersistence(state, readings, new Date(epoch))
  }
  return state
}

test('tracks how long available bikes stayed below the low threshold', () => {
  // 3 bikes is at the threshold, not below it: no run is recorded.
  const atThreshold = mergePersistence(null, [station('a', 3, 17)], at('2026-09-12T01:00:00Z'))
  assert.equal(atThreshold.stations.a.lowBikesSince, undefined)
  assert.equal(atThreshold.stations.a.lowBikesMinutes, undefined)

  // 01:00 -> 01:35 at 2 bikes is 8 captures, so 35 minutes of an unbroken run.
  const low = replay([station('a', 2, 18)], '2026-09-12T01:00:00Z', 8)
  assert.equal(low.stations.a.lowBikesSince, '2026-09-12T01:00:00.000Z')
  assert.equal(low.stations.a.lowBikesMinutes, 35)

  // Refilling clears the run rather than pausing it.
  const refilled = mergePersistence(low, [station('a', 9, 11)], at('2026-09-12T01:40:00Z'))
  assert.equal(refilled.stations.a.lowBikesSince, undefined)
  const lowAgain = mergePersistence(refilled, [station('a', 1, 19)], at('2026-09-12T01:45:00Z'))
  assert.equal(lowAgain.stations.a.lowBikesMinutes, 0)
})

test('tracks a metric stuck at one low reading while the other keeps moving', () => {
  // Bikes pinned at 2 for 2 hours while docks stay positive.
  const stuck = replay([station('a', 2, 18)], '2026-09-12T01:00:00Z', 25)
  assert.equal(stuck.stations.a.frozenMetric, 'bikes')
  assert.equal(stuck.stations.a.frozenValue, 2)
  assert.equal(stuck.stations.a.frozenMinutes, 120)

  // A different reading starts a new run even though it is still low.
  const moved = mergePersistence(stuck, [station('a', 1, 19)], at('2026-09-12T03:05:00Z'))
  assert.equal(moved.stations.a.frozenValue, 1)
  assert.equal(moved.stations.a.frozenMinutes, 0)

  // Nothing is a candidate once the other metric hits zero: a station with no
  // bikes and no docks is a suspended station, not a stuck sensor.
  const bothZero = mergePersistence(stuck, [station('a', 0, 0, 'unavailable')], at('2026-09-12T03:05:00Z'))
  assert.equal(bothZero.stations.a.frozenMetric, undefined)
})

test('derives both dashboard lists from the published document', () => {
  const state = replay([station('a', 0, 20, 'empty_now'), station('b', 9, 11)], '2026-09-12T01:00:00Z', 13)
  assert.equal(state.updatedAt, '2026-09-12T02:00:00.000Z')
  assert.ok(hasServerRuns(state))

  assert.deepEqual(lowBikesIdsFromPersistence(state, 30), ['a'])
  assert.deepEqual(lowBikesIdsFromPersistence(state, 60), ['a'])
  assert.deepEqual(lowBikesIdsFromPersistence(state, 90), [])
  assert.deepEqual(frozenStationsFromPersistence(state, 60), [{ stationId: 'a', metric: 'bikes', stuckValue: 0 }])
  assert.deepEqual(frozenStationsFromPersistence(state, 120), [])

  // A document from a Lambda that predates these fields must not be mistaken
  // for "no station qualifies"; the browser keeps using its own buffer.
  const legacy = { ...state, stations: Object.fromEntries(Object.entries(state.stations).map(([id, item]) => {
    const { lowBikesSince, lowBikesMinutes, frozenMetric, frozenValue, frozenSince, frozenMinutes, ...rest } = item
    return [id, rest]
  })) }
  assert.equal(hasServerRuns(legacy), false)
  assert.ok(freshPersistence(legacy, Date.parse('2026-09-12T02:01:00Z')), '舊格式仍須通過驗證')
})

test('freshPersistence rejects a malformed run but tolerates an absent one', () => {
  const base = mergePersistence(null, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:00:00Z'))
  const now = Date.parse('2026-09-12T01:01:00Z')
  assert.ok(freshPersistence(base, now))
  assert.equal(freshPersistence({ ...base, stations: { a: { ...base.stations.a, lowBikesMinutes: -1 } } }, now), null)
  assert.equal(freshPersistence({ ...base, stations: { a: { ...base.stations.a, frozenMetric: 'wheels' } } }, now), null)
})
