import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  adjustmentCovers,
  adjustmentsOverlap,
  buildExclusionIndex,
  formatLocalDateTime,
  parseAdjustmentsFile,
  parseLocalDateTime,
  sortAdjustments,
  validateAdjustment,
} from '../shared/operational-adjustments.mjs'

function adjustment(overrides = {}) {
  return {
    id: 'adj_1',
    stationId: 'st_abc',
    stationName: '測試站',
    district: '板橋區',
    reason: '道路施工',
    startAt: '2026-03-01T08:00',
    endAt: '2026-03-05T18:00',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

test('parses wall-clock strings without shifting with the host time zone', () => {
  const epoch = parseLocalDateTime('2026-03-01T08:30')
  assert.equal(epoch, Date.UTC(2026, 2, 1, 8, 30, 0))
  assert.equal(formatLocalDateTime(epoch), '2026-03-01T08:30')
})

test('rejects malformed and impossible timestamps', () => {
  assert.equal(parseLocalDateTime('2026-02-30T08:00'), null, 'February 30th is not a date')
  assert.equal(parseLocalDateTime('2026-13-01T08:00'), null)
  assert.equal(parseLocalDateTime('2026-03-01T24:00'), null)
  assert.equal(parseLocalDateTime('2026-03-01 08:00'), null, 'the T separator is required')
  assert.equal(parseLocalDateTime(''), null)
  assert.equal(parseLocalDateTime(null), null)
})

test('an end before or equal to the start is rejected', () => {
  const issues = validateAdjustment({ ...adjustment(), endAt: '2026-03-01T08:00' })
  assert.deepEqual(issues.map(issue => issue.field), ['endAt'])
})

test('a missing station is reported without masking a bad timestamp', () => {
  const issues = validateAdjustment({ stationId: '', startAt: 'nope', endAt: null })
  assert.deepEqual(issues.map(issue => issue.field).sort(), ['startAt', 'stationId'])
})

test('an open-ended window needs no end time', () => {
  assert.deepEqual(validateAdjustment({ ...adjustment(), endAt: null }), [])
  assert.deepEqual(validateAdjustment({ ...adjustment(), endAt: '' }), [])
})

test('windows are half-open so back-to-back entries never double-count', () => {
  const item = adjustment()
  assert.equal(adjustmentCovers(item, parseLocalDateTime('2026-03-01T08:00')), true, 'start is inclusive')
  assert.equal(adjustmentCovers(item, parseLocalDateTime('2026-03-05T17:59')), true)
  assert.equal(adjustmentCovers(item, parseLocalDateTime('2026-03-05T18:00')), false, 'end is exclusive')
  assert.equal(adjustmentCovers(item, parseLocalDateTime('2026-02-28T23:59')), false)
})

test('an open-ended window covers everything after its start', () => {
  const item = adjustment({ endAt: null })
  assert.equal(adjustmentCovers(item, parseLocalDateTime('2026-06-30T23:30')), true)
  assert.equal(adjustmentCovers(item, parseLocalDateTime('2026-02-28T07:59')), false)
})

test('the exclusion index only matches the station it was recorded for', () => {
  const index = buildExclusionIndex([adjustment()])
  assert.equal(index.isEmpty, false)
  assert.equal(index.stationCount, 1)
  assert.equal(index.excludes('st_abc', parseLocalDateTime('2026-03-02T09:00')), true)
  assert.equal(index.excludes('st_other', parseLocalDateTime('2026-03-02T09:00')), false, 'a different station is untouched')
  assert.equal(index.excludes('st_abc', parseLocalDateTime('2026-04-02T09:00')), false)
})

test('multiple windows on one station are all honoured', () => {
  const index = buildExclusionIndex([
    adjustment({ id: 'a', startAt: '2026-03-01T00:00', endAt: '2026-03-02T00:00' }),
    adjustment({ id: 'b', startAt: '2026-05-01T00:00', endAt: null }),
  ])
  assert.equal(index.excludes('st_abc', parseLocalDateTime('2026-03-01T12:00')), true)
  assert.equal(index.excludes('st_abc', parseLocalDateTime('2026-04-01T12:00')), false, 'the gap between windows stays included')
  assert.equal(index.excludes('st_abc', parseLocalDateTime('2026-06-01T12:00')), true)
})

test('an empty index short-circuits without a lookup', () => {
  const index = buildExclusionIndex([])
  assert.equal(index.isEmpty, true)
  assert.equal(index.excludes('st_abc', Date.UTC(2026, 2, 1)), false)
})

test('a window with an unparseable end is treated as open-ended rather than dropped', () => {
  const index = buildExclusionIndex([adjustment({ endAt: 'garbage' })])
  assert.equal(index.excludes('st_abc', parseLocalDateTime('2026-06-30T23:30')), true)
})

test('overlap is detected only within the same station and never against itself', () => {
  const left = adjustment({ id: 'a', startAt: '2026-03-01T00:00', endAt: '2026-03-10T00:00' })
  const right = adjustment({ id: 'b', startAt: '2026-03-05T00:00', endAt: '2026-03-15T00:00' })
  assert.equal(adjustmentsOverlap(left, right), true)
  assert.equal(adjustmentsOverlap(left, left), false, 'an entry cannot conflict with itself')
  assert.equal(adjustmentsOverlap(left, { ...right, stationId: 'st_zzz' }), false)
  assert.equal(adjustmentsOverlap(left, adjustment({ id: 'c', startAt: '2026-03-10T00:00', endAt: '2026-03-12T00:00' })), false, 'touching windows do not overlap')
})

test('the file parser drops entries that could not be applied', () => {
  const parsed = parseAdjustmentsFile({
    adjustments: [
      adjustment(),
      { stationId: '', startAt: '2026-03-01T08:00' },
      { stationId: 'st_x', startAt: 'not-a-date' },
      null,
      'nonsense',
    ],
  })
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].stationId, 'st_abc')
})

test('the file parser accepts a bare array and normalises a bad end time to open-ended', () => {
  const parsed = parseAdjustmentsFile([adjustment({ endAt: 'whenever' })])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].endAt, null)
})

test('unrecognised payloads yield an empty list instead of throwing', () => {
  assert.deepEqual(parseAdjustmentsFile(null), [])
  assert.deepEqual(parseAdjustmentsFile({ nope: true }), [])
})

test('newest windows are listed first', () => {
  const sorted = sortAdjustments([
    adjustment({ id: 'old', startAt: '2026-01-01T00:00' }),
    adjustment({ id: 'new', startAt: '2026-05-01T00:00' }),
  ])
  assert.deepEqual(sorted.map(item => item.id), ['new', 'old'])
})
