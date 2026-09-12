import type { ApiEnvelope, ApiMeta, CurrentState, LiveStation, LiveStationsPayload, ServiceStatus } from './ops.ts'
export type LiveResponse = ApiEnvelope<LiveStationsPayload>
type NtpRawStation = Record<string, unknown>

function asRecord(value: unknown): NtpRawStation {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as NtpRawStation
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const candidate = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(candidate) ? candidate : fallback
}

export function asCurrentState(active: boolean, bikes: number, docks: number): CurrentState {
  if (!active || (bikes === 0 && docks === 0)) return 'unavailable'
  if (bikes === 0) return 'empty_now'
  if (docks === 0) return 'full_now'
  return 'normal'
}

export function serviceStatusFor(active: boolean, bikes: number, docks: number): ServiceStatus {
  if (!active) return 'official_inactive'
  if (bikes === 0 && docks === 0) return 'suspected_unavailable'
  return 'operational'
}

export function mapLiveStation(value: unknown): LiveStation | null {
  const station = asRecord(value)
  const id = asString(station.sno)
  if (!id) return null

  const totalDocks = Math.max(0, Math.round(asNumber(station.tot_quantity)))
  const availableBikes = Math.max(0, Math.round(asNumber(station.sbi_quantity, asNumber(station.sbi))))
  const availableDocks = Math.max(0, Math.round(asNumber(station.bemp)))
  const active = asString(station.act) === '1' || asNumber(station.act) === 1
  const latitude = asNumber(station.lat, Number.NaN)
  const longitude = asNumber(station.lng, Number.NaN)

  return {
    id,
    name: asString(station.sna, '未命名站點'),
    district: asString(station.sarea, '未分類'),
    totalDocks,
    availableBikes,
    availableDocks,
    capacityGap: totalDocks - availableBikes - availableDocks,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    active,
    currentState: asCurrentState(active, availableBikes, availableDocks),
    serviceStatus: serviceStatusFor(active, availableBikes, availableDocks),
    sourceUpdatedAt: asString(station.mday),
    youbike2Bikes: Math.max(0, Math.round(asNumber(station.yb2_quantity))),
    eBikeBikes: Math.max(0, Math.round(asNumber(station.eyb_quantity))),
    dataMode: 'live',
  }
}

export function asOfFromSourceTime(value: string | undefined): string {
  if (value && /^\d{8}T\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}+08:00`
  }
  return new Date().toISOString()
}

export function createLiveResponse(payload: unknown): LiveResponse {
  const stations = Array.isArray(payload)
    ? payload.map(mapLiveStation).filter((station): station is LiveStation => station !== null)
    : []
  if (!stations.length) throw new Error('官方即時資料沒有可辨識的站點。')
  const sourceUpdatedAt = stations.map(station => station.sourceUpdatedAt).filter(Boolean).sort().at(-1)
  const meta: ApiMeta = {
    asOf: asOfFromSourceTime(sourceUpdatedAt),
    generatedAt: new Date().toISOString(),
    dataMode: 'live',
    forecastModel: 'historical-live-inventory-baseline-v2',
    narrativeProvider: 'template',
  }

  return {
    data: {
      dataMode: 'live',
      source: 'ntpc-open-data',
      district: null,
      stations,
    },
    meta,
  }
}

