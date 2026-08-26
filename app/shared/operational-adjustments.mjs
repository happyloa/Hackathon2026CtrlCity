/**
 * Operator-declared service suspensions.
 *
 * A station switched off for maintenance, roadworks or an event still emits
 * snapshots, and those snapshots look exactly like a chronic shortage. Feeding
 * them to the historical profile or the forecast evaluation teaches the model
 * that the station is "always empty", inflating both its historical risk and
 * the false-positive count. Operators record those windows here so the offline
 * pipeline can drop them.
 *
 * Times are wall-clock strings ("YYYY-MM-DDTHH:mm"). The dataset loaders parse
 * timestamps as UTC components so weekday and half-hour slot never shift with
 * the host time zone; this module follows the same convention, so an operator's
 * "08:00" always lines up with the dataset's "08:00".
 */

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/**
 * Parses a wall-clock string into the same pseudo-UTC epoch space the dataset
 * loaders use. Returns null when malformed or not a real calendar date.
 */
export function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(LOCAL_DATE_TIME)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null

  const epoch = Date.UTC(year, month - 1, day, hour, minute, 0)
  const parsed = new Date(epoch)
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null
  return epoch
}

export function formatLocalDateTime(epoch) {
  const date = new Date(epoch)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

export function validateAdjustment(draft) {
  const issues = []
  if (!String(draft?.stationId ?? '').trim()) issues.push({ field: 'stationId', message: '請選擇站點' })

  const start = parseLocalDateTime(draft?.startAt)
  if (start === null) issues.push({ field: 'startAt', message: '起始時間格式不正確' })

  const rawEnd = draft?.endAt
  if (rawEnd !== null && rawEnd !== undefined && rawEnd !== '') {
    const end = parseLocalDateTime(rawEnd)
    if (end === null) issues.push({ field: 'endAt', message: '結束時間格式不正確' })
    else if (start !== null && end <= start) issues.push({ field: 'endAt', message: '結束時間必須晚於起始時間' })
  }

  return issues
}

/** An open-ended window covers everything from its start onwards. */
export function adjustmentCovers(adjustment, epoch) {
  const start = parseLocalDateTime(adjustment?.startAt)
  if (start === null || epoch < start) return false
  if (adjustment.endAt === null || adjustment.endAt === undefined || adjustment.endAt === '') return true
  const end = parseLocalDateTime(adjustment.endAt)
  return end === null ? true : epoch < end
}

function windowEnd(adjustment) {
  if (adjustment.endAt === null || adjustment.endAt === undefined || adjustment.endAt === '') {
    return Number.POSITIVE_INFINITY
  }
  const end = parseLocalDateTime(adjustment.endAt)
  return end === null ? Number.POSITIVE_INFINITY : end
}

export function adjustmentsOverlap(left, right) {
  if (left.stationId !== right.stationId || left.id === right.id) return false
  const leftStart = parseLocalDateTime(left.startAt)
  const rightStart = parseLocalDateTime(right.startAt)
  if (leftStart === null || rightStart === null) return false
  return leftStart < windowEnd(right) && rightStart < windowEnd(left)
}

/**
 * Groups windows by station so a full-dataset scan costs one map lookup per row
 * instead of a walk over every adjustment.
 */
export function buildExclusionIndex(adjustments) {
  const byStation = new Map()
  for (const adjustment of adjustments ?? []) {
    const start = parseLocalDateTime(adjustment?.startAt)
    if (start === null) continue
    const end = windowEnd(adjustment)
    const windows = byStation.get(adjustment.stationId)
    if (windows) windows.push({ start, end })
    else byStation.set(adjustment.stationId, [{ start, end }])
  }

  return {
    isEmpty: byStation.size === 0,
    stationCount: byStation.size,
    excludes(stationId, epoch) {
      const windows = byStation.get(stationId)
      if (!windows) return false
      for (const window of windows) {
        if (epoch >= window.start && epoch < window.end) return true
      }
      return false
    },
  }
}

export function sortAdjustments(adjustments) {
  return [...adjustments].sort((left, right) =>
    right.startAt.localeCompare(left.startAt) ||
    left.district.localeCompare(right.district, 'zh-Hant') ||
    left.stationName.localeCompare(right.stationName, 'zh-Hant'),
  )
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * Accepts anything shaped like an adjustment list — a pasted file, an older
 * export — and keeps only entries that are actually usable.
 */
export function parseAdjustmentsFile(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.adjustments)
      ? raw.adjustments
      : null
  if (!list) return []

  const parsed = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const stationId = asString(entry.stationId)
    const startAt = asString(entry.startAt)
    if (!stationId || parseLocalDateTime(startAt) === null) continue

    const rawEnd = asString(entry.endAt)
    const endAt = rawEnd && parseLocalDateTime(rawEnd) !== null ? rawEnd : null
    const now = new Date().toISOString()
    parsed.push({
      id: asString(entry.id) || `adj_${stationId}_${startAt}`,
      stationId,
      stationName: asString(entry.stationName) || stationId,
      district: asString(entry.district),
      reason: asString(entry.reason),
      startAt,
      endAt,
      createdAt: asString(entry.createdAt) || now,
      updatedAt: asString(entry.updatedAt) || now,
    })
  }
  return parsed
}
