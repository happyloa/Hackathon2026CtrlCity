import { createError } from 'h3'
import type { CurrentState, LiveStation } from '~/shared/ops'

const DEFAULT_NTPC_LIVE_STATIONS_URL = 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'
const FETCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 120_000

type UnknownRecord = Record<string, unknown>

let cachedSnapshot: { expiresAt: number; stations: LiveStation[] } | null = null

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function liveFeedUrl(): string {
  return asString(useRuntimeConfig().liveFeedUrl, DEFAULT_NTPC_LIVE_STATIONS_URL)
}

function currentState(active: boolean, bikes: number, docks: number): CurrentState {
  if (!active || (bikes === 0 && docks === 0)) return 'unavailable'
  if (bikes === 0) return 'empty_now'
  if (docks === 0) return 'full_now'
  return 'normal'
}

function mapLiveStation(value: unknown): LiveStation | null {
  const record = asRecord(value)
  const id = asString(record.sno)
  if (!id) return null

  const totalDocks = Math.max(0, Math.round(asNumber(record.tot_quantity)))
  const availableBikes = Math.max(0, Math.round(asNumber(record.sbi_quantity, asNumber(record.sbi))))
  const availableDocks = Math.max(0, Math.round(asNumber(record.bemp)))
  const active = asString(record.act) === '1' || asNumber(record.act) === 1
  const latitude = asNumber(record.lat, Number.NaN)
  const longitude = asNumber(record.lng, Number.NaN)

  return {
    id,
    name: asString(record.sna, '未命名站點'),
    district: asString(record.sarea, '未分類'),
    totalDocks,
    availableBikes,
    availableDocks,
    capacityGap: totalDocks - availableBikes - availableDocks,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    active,
    currentState: currentState(active, availableBikes, availableDocks),
    sourceUpdatedAt: asString(record.mday),
    youbike2Bikes: Math.max(0, Math.round(asNumber(record.yb2_quantity))),
    eBikeBikes: Math.max(0, Math.round(asNumber(record.eyb_quantity))),
    dataMode: 'live',
  }
}

async function fetchLiveSnapshot(forceRefresh = false): Promise<LiveStation[]> {
  if (!forceRefresh && cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) return cachedSnapshot.stations

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(liveFeedUrl(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw createError({ statusCode: 502, statusMessage: `NTPC live feed returned HTTP ${response.status}` })
    }

    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) {
      throw createError({ statusCode: 502, statusMessage: 'NTPC live feed returned an unexpected payload.' })
    }

    const stations = payload.map(mapLiveStation).filter((station): station is LiveStation => station !== null)
    cachedSnapshot = { expiresAt: Date.now() + CACHE_TTL_MS, stations }
    return stations
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createError({ statusCode: 504, statusMessage: 'NTPC live feed timed out.' })
    }
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({ statusCode: 502, statusMessage: 'Unable to retrieve NTPC live station data.' })
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchLiveStations(district?: string, options: { forceRefresh?: boolean } = {}): Promise<LiveStation[]> {
  const stations = await fetchLiveSnapshot(options.forceRefresh)
  return district ? stations.filter(station => station.district === district) : stations
}
