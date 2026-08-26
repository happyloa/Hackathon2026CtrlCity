import {
  stationPopularityMatchKey,
  type StationPopularityHour,
} from '~/shared/station-popularity'
import type { StationRisk } from '~/shared/ops'

type PopularityManifest = {
  stationIds: string[]
  matchKeys: string[]
  popularity: Record<string, string>
}

type PopularityPayload = {
  weekday: number
  profiles: unknown[]
}

let manifestPromise: Promise<PopularityManifest> | null = null
const weekdayCache = new Map<number, Promise<PopularityPayload>>()

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseManifest(value: unknown): PopularityManifest | null {
  const source = asRecord(value)
  const stationIds = Array.isArray(source.stationIds)
    ? source.stationIds.filter((item): item is string => typeof item === 'string')
    : []
  const matchKeys = Array.isArray(source.matchKeys)
    ? source.matchKeys.filter((item): item is string => typeof item === 'string')
    : []
  const popularity = Object.fromEntries(
    Object.entries(asRecord(source.popularity)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return matchKeys.length && Object.keys(popularity).length
    ? { stationIds, matchKeys, popularity }
    : null
}

function parsePayload(value: unknown, weekday: number): PopularityPayload | null {
  const source = asRecord(value)
  return Number(source.weekday) === weekday && Array.isArray(source.profiles)
    ? { weekday, profiles: source.profiles }
    : null
}

function parseHours(value: unknown): StationPopularityHour[] {
  const rawHours = Array.isArray(value) ? value : []
  return Array.from({ length: 24 }, (_, hour) => {
    const raw = Array.isArray(rawHours[hour]) ? rawHours[hour] as unknown[] : []
    return {
      hour,
      sampleDays: Math.max(0, Math.round(Number(raw[0]) || 0)),
      meanAvailableBikes: Math.max(0, Number(raw[1]) || 0),
      meanAvailableDocks: Math.max(0, Number(raw[2]) || 0),
    }
  })
}

async function loadManifest(): Promise<PopularityManifest> {
  manifestPromise ||= $fetch<unknown>('/data/live-profile/manifest.json', { cache: 'no-store' })
    .then((value) => {
      const parsed = parseManifest(value)
      if (!parsed) throw new Error('熱門度資料索引格式不完整。')
      return parsed
    })
    .catch((error) => {
      manifestPromise = null
      throw error
    })
  return manifestPromise
}

async function loadWeekday(manifest: PopularityManifest, weekday: number): Promise<PopularityPayload> {
  const cached = weekdayCache.get(weekday)
  if (cached) return cached
  const path = manifest.popularity[String(weekday)]
  if (!path) throw new Error('找不到指定星期的熱門度資料。')
  const request = $fetch<unknown>(path, { cache: 'force-cache' }).then((value) => {
    const parsed = parsePayload(value, weekday)
    if (!parsed) throw new Error('熱門度資料格式不正確。')
    return parsed
  }).catch((error) => {
    weekdayCache.delete(weekday)
    throw error
  })
  weekdayCache.set(weekday, request)
  return request
}

export async function stationPopularityFor(station: StationRisk, weekday: number): Promise<StationPopularityHour[]> {
  const manifest = await loadManifest()
  const idIndex = manifest.stationIds.indexOf(station.id)
  const matchKey = stationPopularityMatchKey(station)
  const matchingIndices = manifest.matchKeys.flatMap((key, index) => key === matchKey ? [index] : [])
  const stationIndex = idIndex >= 0 ? idIndex : matchingIndices.length === 1 ? matchingIndices[0]! : -1
  if (stationIndex < 0) return []
  const payload = await loadWeekday(manifest, weekday)
  return parseHours(payload.profiles[stationIndex])
}
