import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parse } from 'csv-parse/sync'
import { csvHeaders, snapshotCsvRows, convertSnapshots } from '../scripts/raw-snapshots-to-csv.mjs'
import { HEADER_MAP, toSnapshot } from '../scripts/build-artifacts.mjs'
import { freshPersistence } from '../shared/station-persistence.ts'
import { mergePersistence } from '../aws/capture.ts'
import { syncOperatorSeed } from '../scripts/aws-sync-operator-seed.mjs'
import { historyPeriod } from '../shared/history-period.mjs'

const feed = [{ sno: '1', sna: 'YouBike2.0_市場,公園', sarea: '板橋區', tot_quantity: '20', sbi_quantity: '3', bemp: '17', act: '1', lat: '25.1', lng: '121.4', mday: '20260912T090000' }]
test('captured rows round trip through the existing pipeline parser with Taipei time and coordinates', () => {
  const row = Object.fromEntries(csvHeaders.map((key, index) => [HEADER_MAP.get(key), String(snapshotCsvRows(feed)[0][index])]))
  const result = toSnapshot(row, { fileName: 'captured.csv', sourceRow: 2 }, new Map(), new Map(), { flagCounts: {} }, new Set())
  assert.equal(result.rawObservedAt, '2026-09-12T09:00:00+08:00')
  assert.equal(result.availableBikes, 3)
  assert.equal(result.availableDocks, 17)
  assert.equal(result.totalDocks, 20)
  assert.equal(result.longitude, 121.4)
  assert.equal(result.latitude, 25.1)
  assert.equal(result.district, '板橋區')
  assert.equal(result.name, '市場,公園')
  const organizerRow = { ...row, name: '市場,公園' }
  assert.equal(result.id, toSnapshot(organizerRow, {}, new Map(), new Map(), { flagCounts: {} }, new Set()).id)
})
test('snapshot conversion paginates, keeps only half-hour keys and escapes station names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctrlcity-history-test-'))
  const out = join(dir, 'captured.csv')
  const gets = []
  try {
    const s3 = { send: async command => {
      if (command.constructor.name === 'ListObjectsV2Command') return command.input.ContinuationToken
        ? { Contents: [{ Key: 'raw/2026/09/12/0930.json.gz' }] }
        : { Contents: [{ Key: 'raw/2026/09/12/0900.json.gz' }, { Key: 'raw/2026/09/12/0905.json.gz' }], IsTruncated: true, NextContinuationToken: 'next' }
      gets.push(command.input.Key)
      return { Body: { transformToByteArray: async () => gzipSync(JSON.stringify(feed)) } }
    } }
    assert.equal(await convertSnapshots({ bucket: 'site', out, s3 }), 2)
    assert.equal(gets.length, 2)
    const rows = parse(await readFile(out, 'utf8'), { columns: true })
    assert.equal(rows[0]['場站名稱'], '市場,公園')
    assert.equal(rows[0]['日期'], '2026-09-12 09:00:00')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('persistence rejects stale/malformed/future snapshots and resets on reverse time', () => {
  const now = new Date('2026-09-12T01:00:00Z')
  const station = { id: 'one', currentState: 'empty_now', availableBikes: 0, availableDocks: 20 }
  const state = mergePersistence(null, [station], now)
  assert.ok(freshPersistence(state, now.getTime() + 60000))
  assert.equal(freshPersistence(state, now.getTime() + 15 * 60000), null)
  assert.equal(freshPersistence(state, now.getTime() - 5 * 60000), null)
  assert.equal(freshPersistence({ ...state, stations: { one: {} } }, now.getTime()), null)
  const reverse = mergePersistence(state, [station], new Date(now.getTime() - 300000))
  assert.equal(reverse.stations.one.stateMinutes, 0)
})
test('operator seed does not silently fall back on access/network errors', async () => {
  await assert.rejects(syncOperatorSeed('site', { s3: { send: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }) } } }), /denied/)
})

test('AWS descriptive history includes new months while local period remains frozen', () => {
  const now = new Date('2026-09-12T17:05:00Z')
  const local = historyPeriod(false, now)
  const cloud = historyPeriod(true, now)
  assert.equal(local.days, 181)
  assert.equal(local.end, Date.UTC(2026, 6, 1))
  assert.equal(cloud.end, Date.UTC(2026, 8, 14))
  assert.equal(cloud.days, 256)
  assert.ok(cloud.detailShardCount > local.detailShardCount)
})
