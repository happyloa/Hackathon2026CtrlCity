import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveStatePersistence } from '../scripts/alert-persistence.mjs'

const MINUTE = 60 * 1000

function snapshot(at, currentState) {
  return { at, epoch: Date.parse(at), currentState }
}

test('derives the start and duration from contiguous 30-minute inventory failures', () => {
  const history = [
    snapshot('2026-06-30T08:30:00+08:00', 'normal'),
    snapshot('2026-06-30T09:00:00+08:00', 'empty'),
    snapshot('2026-06-30T09:30:00+08:00', 'empty'),
    snapshot('2026-06-30T10:00:00+08:00', 'empty'),
  ]

  const result = deriveStatePersistence(history, history.at(-1))

  assert.deepEqual(result, {
    condition: 'empty',
    startedAt: '2026-06-30T09:00:00+08:00',
    durationMinutes: 90,
  })
})

test('uses one observed bucket as a non-zero minimum and stops across missing buckets', () => {
  const history = [
    snapshot('2026-06-30T09:30:00+08:00', 'full'),
    snapshot('2026-06-30T10:30:00+08:00', 'full'),
  ]
  const result = deriveStatePersistence(history, history.at(-1))

  assert.equal(result?.startedAt, '2026-06-30T10:30:00+08:00')
  assert.equal(result?.durationMinutes, 30)
  assert.equal(Date.parse(result?.startedAt) + result.durationMinutes * MINUTE, Date.parse('2026-06-30T11:00:00+08:00'))
})

test('does not create persistence metadata for a normal inventory state', () => {
  const current = snapshot('2026-06-30T10:00:00+08:00', 'normal')
  assert.equal(deriveStatePersistence([current], current), null)
})
