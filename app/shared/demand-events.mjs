import { parseLocalDateTime } from './operational-adjustments.mjs'

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
      || (entry.note !== undefined && typeof entry.note !== 'string')) throw new Error('活動需要唯一 id、名稱、站點及有效起訖時間')
    ids.add(entry.id)
    return { id: entry.id.trim(), name: entry.name.trim(), stationIds: [...new Set(entry.stationIds)], startAt: entry.startAt, endAt: entry.endAt, note: entry.note?.trim() || '' }
  })
}
