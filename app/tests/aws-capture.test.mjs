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
