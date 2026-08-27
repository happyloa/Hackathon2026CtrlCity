import roi from '~/data/operational-roi.json'

export interface RoiCell {
  observations: number
  stations: number
  meanBikes: number
  meanDocks: number
  emptyRate: number
  fullRate: number
  lowBikesRate: number
  lowDocksRate: number
  unavailableCount: number
}

export interface RoiScope {
  label: string
  stationCount: number
  grid: (number[] | null)[][]
}

export interface RoiStation {
  id: string
  district: string
  name: string
  totalDocks: number
  latitude: number
  longitude: number
}

interface RoiArtifact {
  schemaVersion: string
  generatedAt: string
  period: string
  weekdayNames: string[]
  valueFormat: string[]
  definitions: Record<string, string>
  scopes: Record<string, RoiScope>
  stations?: [string, string, string, number, number, number][]
  stationShards?: Record<string, string>
  stationDetailPath?: string
  stationDetailFormat?: {
    recordsPerStation: number
    bytesPerRecord: number
    originDate: string
    days: number
    slotsPerDay: number
  }
  adjustmentsApplied?: number
  rowsExcludedByAdjustment?: number
}

const artifact = roi as unknown as RoiArtifact

const STATIONS: RoiStation[] = (artifact.stations || []).map(([id, district, name, totalDocks, latitude, longitude]) => ({
  id, district, name, totalDocks, latitude, longitude,
}))

export const WEEKDAY_OPTIONS = artifact.weekdayNames.map((label, value) => ({ value: String(value), label }))

export const SLOT_OPTIONS = Array.from({ length: 48 }, (_, slot) => ({
  value: String(slot),
  label: `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`,
}))

function toCell(values: number[] | null): RoiCell | null {
  if (!values) return null
  const [observations, stations, meanBikes, meanDocks, emptyRate, fullRate, lowBikesRate, lowDocksRate, unavailableCount] = values
  return {
    observations: observations ?? 0,
    stations: stations ?? 0,
    meanBikes: meanBikes ?? 0,
    meanDocks: meanDocks ?? 0,
    emptyRate: emptyRate ?? 0,
    fullRate: fullRate ?? 0,
    lowBikesRate: lowBikesRate ?? 0,
    lowDocksRate: lowDocksRate ?? 0,
    unavailableCount: unavailableCount ?? 0,
  }
}

type ShardCell = [number, number, number, number, number] | null

const MISSING_RECORD = 0xffff

interface StationDetail {
  originDate: string
  days: number
  slotsPerDay: number
  view: DataView
}

const STATION_INDEX_BY_ID = new Map(STATIONS.map((station, index) => [station.id, index]))

export interface DetailRecord {
  date: string
  availableBikes: number
  availableDocks: number
}

/**
 * Per-station values are sharded by weekday: switching district or slot never
 * refetches, and switching weekday costs at most one request. Shards are cached
 * for the session.
 */
export function useOperationalRoi() {
  const shards = useState<Record<string, ShardCell[][]>>('roi-shards:v1', () => ({}))
  const shardLoading = useState<boolean>('roi-shards-loading:v1', () => false)
  const shardError = useState<string>('roi-shards-error:v1', () => '')
  const details = useState<Record<string, StationDetail>>('roi-detail:v1', () => ({}))
  const detailLoading = useState<boolean>('roi-detail-loading:v1', () => false)
  const detailMissing = useState<boolean>('roi-detail-missing:v1', () => false)

  async function loadWeekday(weekday: number): Promise<void> {
    const key = String(weekday)
    if (shards.value[key] || !import.meta.client) return
    const path = artifact.stationShards?.[key]
    if (!path) return

    shardLoading.value = true
    shardError.value = ''
    try {
      const payload = await $fetch<{ cells: ShardCell[][] }>(path, { cache: 'no-store' })
      if (!Array.isArray(payload?.cells)) throw new Error('shard payload is not an array')
      shards.value = { ...shards.value, [key]: payload.cells }
    } catch {
      shardError.value = '無法載入站點層級資料，改以行政區彙總顯示'
    } finally {
      shardLoading.value = false
    }
  }

  /**
   * The per-station week comparison needs every weekday at once. Loading them
   * sequentially keeps the selected weekday first so the map paints before the
   * remaining shards arrive.
   */
  async function loadAllWeekdays(): Promise<void> {
    for (let weekday = 0; weekday < 7; weekday += 1) await loadWeekday(weekday)
  }

  function stationCell(stationIndex: number, weekday: number, slot: number): RoiCell | null {
    const shard = shards.value[String(weekday)]
    const values = shard?.[stationIndex]?.[slot]
    if (!values) return null
    const [emptyPermille, fullPermille, bikesX10, docksX10, observations] = values
    return {
      observations,
      stations: 1,
      meanBikes: bikesX10 / 10,
      meanDocks: docksX10 / 10,
      emptyRate: emptyPermille / 1000,
      fullRate: fullPermille / 1000,
      lowBikesRate: 0,
      lowDocksRate: 0,
      unavailableCount: 0,
    }
  }

  /** One station's 48 half-hour cells for the given weekday. */
  function stationDaySeries(stationIndex: number, weekday: number): (RoiCell | null)[] {
    return Array.from({ length: 48 }, (_, slot) => stationCell(stationIndex, weekday, slot))
  }

  function stationWeekSeries(stationIndex: number, slot: number): (RoiCell | null)[] {
    return Array.from({ length: 7 }, (_, weekday) => stationCell(stationIndex, weekday, slot))
  }

  const districtOptions = computed(() => {
    const entries = Object.entries(artifact.scopes)
      .filter(([key]) => key !== '')
      .sort((left, right) => left[0].localeCompare(right[0], 'zh-Hant'))
      .map(([key, scope]) => ({ value: key, label: `${scope.label}（${scope.stationCount} 站）` }))
    return [{ value: '', label: `全部行政區（${artifact.scopes['']?.stationCount ?? 0} 站）` }, ...entries]
  })

  function scope(district: string): RoiScope | null {
    return artifact.scopes[district] ?? null
  }

  function cell(district: string, weekday: number, slot: number): RoiCell | null {
    return toCell(scope(district)?.grid?.[weekday]?.[slot] ?? null)
  }

  /** One weekday's 48 half-hour cells, for the day-shape chart. */
  function daySeries(district: string, weekday: number): (RoiCell | null)[] {
    const grid = scope(district)?.grid?.[weekday]
    if (!grid) return Array.from({ length: 48 }, () => null)
    return grid.map(toCell)
  }

  /** The same half-hour slot across all seven weekdays. */
  function weekSeries(district: string, slot: number): (RoiCell | null)[] {
    const grid = scope(district)?.grid
    if (!grid) return Array.from({ length: 7 }, () => null)
    return grid.map(day => toCell(day?.[slot] ?? null))
  }

  /**
   * Every individual reading behind one station × weekday × slot aggregate.
   * All 1,568 stations' readings live in one binary file (station-details.bin),
   * packed at a fixed per-station stride — a station's array index doubles as
   * its byte offset, so only that station's ~17 KB slice is fetched via an
   * HTTP Range request rather than downloading the whole ~27 MB file. A range
   * fetch that fails, or a server that ignores Range and returns the whole
   * file, both still resolve correctly below.
   */
  async function loadStationDetail(stationId: string): Promise<void> {
    if (!stationId || details.value[stationId] || !import.meta.client) return
    const base = artifact.stationDetailPath
    const format = artifact.stationDetailFormat
    const index = STATION_INDEX_BY_ID.get(stationId)
    if (!base || !format || index === undefined) return

    detailLoading.value = true
    detailMissing.value = false
    try {
      const stride = format.recordsPerStation * format.bytesPerRecord
      const start = index * stride
      const end = start + stride - 1
      const response = await fetch(base, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' })
      if (!response.ok && response.status !== 206) throw new Error(`detail fetch failed: ${response.status}`)
      const buffer = await response.arrayBuffer()
      const byteOffset = response.status === 206 ? 0 : start
      if (buffer.byteLength < byteOffset + stride) throw new Error('detail payload shorter than expected')
      const view = new DataView(buffer, byteOffset, stride)
      details.value = {
        ...details.value,
        [stationId]: { originDate: format.originDate, days: format.days, slotsPerDay: format.slotsPerDay, view },
      }
    } catch {
      detailMissing.value = true
    } finally {
      detailLoading.value = false
    }
  }

  function stationDetailRecords(stationId: string, weekday: number, slot: number): DetailRecord[] {
    const detail = details.value[stationId]
    if (!detail) return []

    const origin = Date.parse(`${detail.originDate}T00:00:00Z`)
    const records: DetailRecord[] = []
    for (let dayOrdinal = 0; dayOrdinal < detail.days; dayOrdinal += 1) {
      const date = new Date(origin + dayOrdinal * 86_400_000)
      if (date.getUTCDay() !== weekday) continue
      const recordIndex = dayOrdinal * detail.slotsPerDay + slot
      const byteOffset = recordIndex * 2
      if (byteOffset + 2 > detail.view.byteLength) continue
      const packed = detail.view.getUint16(byteOffset, true)
      if (packed === MISSING_RECORD) continue
      const pad = (value: number) => String(value).padStart(2, '0')
      records.push({
        date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
        availableBikes: Math.floor(packed / 256),
        availableDocks: packed % 256,
      })
    }
    return records
  }

  function stationsForDistrict(district: string): { station: RoiStation; index: number }[] {
    return STATIONS
      .map((station, index) => ({ station, index }))
      .filter(entry => !district || entry.station.district === district)
  }

  return {
    meta: artifact,
    weekdayNames: artifact.weekdayNames,
    districtOptions,
    stations: STATIONS,
    stationsForDistrict,
    scope,
    cell,
    daySeries,
    weekSeries,
    loadWeekday,
    loadAllWeekdays,
    stationCell,
    stationDaySeries,
    stationWeekSeries,
    shardLoading,
    shardError,
    loadStationDetail,
    stationDetailRecords,
    detailLoading,
    detailMissing,
  }
}
