import { parseLocalDateTime } from './operational-adjustments.mjs'

/**
 * How an event's crowd is expected to move bikes at a station:
 * - borrow_surge: riders take bikes out for the whole window (e.g. a
 *   destination people bike TO all day) -- risk is running out of bikes.
 * - return_surge: riders bring bikes in for the whole window -- risk is
 *   running out of docks.
 * - fills_then_empties: a single gathering (concert, match): the crowd
 *   arrives and returns bikes near startAt (full-dock risk), then leaves in
 *   a rush and borrows near endAt (empty-bike risk).
 * - empties_then_fills: the mirror case -- a crowd borrows to arrive near
 *   startAt, then returns near endAt.
 */
export const DEMAND_EVENT_PATTERNS = Object.freeze(['borrow_surge', 'return_surge', 'fills_then_empties', 'empties_then_fills'])
const DEFAULT_PATTERN = 'borrow_surge'

/** Local Taipei wall-clock windows, kept separate from service suspensions. */
export function parseDemandEventsFile(raw) {
  if (!raw || !Array.isArray(raw.events)) throw new Error('需要 events 陣列')
  const ids = new Set()
  return raw.events.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim()
      || !Array.isArray(entry.stationIds) || !entry.stationIds.length
      || !entry.stationIds.every(id => typeof id === 'string' && id.trim())
      || parseLocalDateTime(entry.startAt) === null || parseLocalDateTime(entry.endAt) === null
      || parseLocalDateTime(entry.endAt) <= parseLocalDateTime(entry.startAt)
      || (entry.note !== undefined && typeof entry.note !== 'string')
      || (entry.pattern !== undefined && !DEMAND_EVENT_PATTERNS.includes(entry.pattern))) throw new Error('活動需要唯一 id、名稱、站點、有效起訖時間及合法的人潮模式')
    ids.add(entry.id)
    return {
      id: entry.id.trim(),
      name: entry.name.trim(),
      stationIds: [...new Set(entry.stationIds)],
      startAt: entry.startAt,
      endAt: entry.endAt,
      pattern: entry.pattern || DEFAULT_PATTERN,
      note: entry.note?.trim() || '',
    }
  })
}
