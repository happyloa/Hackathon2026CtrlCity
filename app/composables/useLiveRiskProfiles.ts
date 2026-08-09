import type { Forecast, HorizonKey, LiveStation } from '~/shared/ops'

type CompactProfile = [number, number, number, number, number, number]

type ProfileStation = {
  id: string
  matchKey: string
}

type ProfileManifest = {
  schemaVersion: string
  modelVersion: string
  timezone: 'Asia/Taipei'
  riskPolicy: {
    version: string
    alertThresholds: Record<HorizonKey, number>
  }
  stations: ProfileStation[]
  slots: Record<string, string>
}

type SlotPayload = {
  slot: number
  profiles: Record<string, CompactProfile>
}

type LiveSnapshot = {
  at: number
  bikes: number
  docks: number
}

const HORIZONS: HorizonKey[] = ['30', '60', '120']
const FALLBACK_THRESHOLDS: Record<HorizonKey, number> = { '30': .45, '60': .45, '120': .4 }
const slotCache = new Map<number, SlotPayload>()
const snapshotsByStation = new Map<string, LiveSnapshot[]>()
let matchIndex: Map<string, string[]> | undefined

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asNumber(value: unknown, fallback = 0): number {
  const candidate = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(candidate) ? candidate : fallback
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeStationName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^YouBike\s*2(?:\.0)?[_\s-]*/i, '')
    .replace(/^YouBike[_\s-]*/i, '')
}

function liveMatchKey(station: LiveStation): string {
  return `${station.district.normalize('NFKC').trim()}|${normalizeStationName(station.name)}`
}

function riskLevel(score: number, threshold: number): Forecast['level'] {
  if (score >= Math.min(1, threshold + .2)) return 'critical'
  if (score >= threshold) return 'high'
  if (score >= threshold * .65) return 'medium'
  return 'normal'
}

function confidence(sampleSize: number): Forecast['confidence'] {
  if (sampleSize >= 12) return 'high'
  if (sampleSize >= 6) return 'medium'
  return 'low'
}

function taipeiSlot(at: string, minutesAhead: number): number {
  const base = Date.parse(at)
  const date = new Date(Number.isFinite(base) ? base + minutesAhead * 60_000 : Date.now() + minutesAhead * 60_000)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value || 0)
  return part('hour') * 2 + Math.floor(part('minute') / 30)
}

function inventoryOnlyForecast(
  station: LiveStation,
  horizon: HorizonKey,
  reason: string,
  baselineStatus: Forecast['baselineStatus'],
): Forecast {
  const suspected = station.serviceStatus !== 'operational'
  return {
    predictedBikes: station.availableBikes,
    predictedDocks: station.availableDocks,
    emptyRisk: 0,
    fullRisk: 0,
    unavailableRisk: suspected ? 1 : 0,
    riskScore: 0,
    level: 'normal',
    confidence: 'low',
    alertThreshold: FALLBACK_THRESHOLDS[horizon],
    baselineStatus,
    method: 'inventory_only',
    sampleSize: 0,
    reasons: [reason],
  }
}

function recentMomentum(station: LiveStation, observedAt: string): { bikes: number; docks: number } | null {
  const epoch = Date.parse(observedAt)
  if (!Number.isFinite(epoch)) return null
  const snapshots = snapshotsByStation.get(station.id) || []
  const target = epoch - 30 * 60_000
  const previous = [...snapshots]
    .filter(snapshot => snapshot.at <= target && snapshot.at >= target - 10 * 60_000)
    .sort((left, right) => right.at - left.at)[0]
  return previous
    ? { bikes: station.availableBikes - previous.bikes, docks: station.availableDocks - previous.docks }
    : null
}

function rememberSnapshot(station: LiveStation, observedAt: string) {
  const epoch = Date.parse(observedAt)
  if (!Number.isFinite(epoch)) return
  const existing = snapshotsByStation.get(station.id) || []
  const next = [...existing.filter(snapshot => snapshot.at !== epoch), {
    at: epoch,
    bikes: station.availableBikes,
    docks: station.availableDocks,
  }]
    .sort((left, right) => left.at - right.at)
    .slice(-8)
  snapshotsByStation.set(station.id, next)
}

function makeForecast(
  station: LiveStation,
  profile: CompactProfile,
  horizon: HorizonKey,
  threshold: number,
  momentum: { bikes: number; docks: number } | null,
): Forecast {
  const [sampleSize, meanBikes, meanDocks, emptyPermille, fullPermille, servicePermille] = profile
  const minutes = Number(horizon)
  const lowThreshold = Math.max(2, Math.ceil(station.totalDocks * .1))
  const bikeRatio = station.availableBikes / Math.max(1, station.totalDocks)
  const dockRatio = station.availableDocks / Math.max(1, station.totalDocks)
  const blendWeight = Math.min(.55, minutes / 240)
  let emptyRisk = (emptyPermille / 1000) * .7
  let fullRisk = (fullPermille / 1000) * .7

  if (station.currentState === 'empty_now') emptyRisk += .48
  else if (station.availableBikes <= lowThreshold || bikeRatio <= .1) emptyRisk += .25
  if (station.currentState === 'full_now') fullRisk += .48
  else if (station.availableDocks <= lowThreshold || dockRatio <= .1) fullRisk += .25
  if (momentum?.bikes && momentum.bikes < 0) emptyRisk += Math.min(.12, Math.abs(momentum.bikes) / Math.max(1, station.totalDocks))
  if (momentum?.docks && momentum.docks < 0) fullRisk += Math.min(.12, Math.abs(momentum.docks) / Math.max(1, station.totalDocks))

  emptyRisk = clamp(emptyRisk)
  fullRisk = clamp(fullRisk)
  const riskScore = Math.max(emptyRisk, fullRisk)
  const reasons = [`已對照同站、同時段歷史基線（${sampleSize} 筆樣本）。`]
  if (station.availableBikes <= lowThreshold) reasons.push('目前可借車偏低。')
  if (station.availableDocks <= lowThreshold) reasons.push('目前可還位偏低。')
  if (momentum) reasons.push('已納入本頁約 30 分鐘的庫存變化。')
  if (reasons.length === 1) reasons.push('目前庫存與歷史基線型態穩定。')

  return {
    predictedBikes: Math.max(0, Math.min(station.totalDocks, Math.round(station.availableBikes * (1 - blendWeight) + meanBikes * blendWeight))),
    predictedDocks: Math.max(0, Math.min(station.totalDocks, Math.round(station.availableDocks * (1 - blendWeight) + meanDocks * blendWeight))),
    emptyRisk,
    fullRisk,
    unavailableRisk: clamp((servicePermille / 1000) * .5),
    riskScore,
    level: riskLevel(riskScore, threshold),
    confidence: confidence(sampleSize),
    alertThreshold: threshold,
    baselineStatus: 'matched',
    method: 'live_historical_baseline',
    sampleSize,
    reasons: reasons.slice(0, 3),
  }
}

function parseManifest(value: unknown): ProfileManifest | null {
  const source = asRecord(value)
  const riskPolicy = asRecord(source.riskPolicy)
  const thresholds = asRecord(riskPolicy.alertThresholds)
  const stations = Array.isArray(source.stations)
    ? source.stations.map((value) => {
      const station = asRecord(value)
      return {
        id: asText(station.id),
        matchKey: asText(station.matchKey),
      }
    }).filter(station => station.id && station.matchKey)
    : []
  const slots = Object.fromEntries(
    Object.entries(asRecord(source.slots)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  if (!stations.length || !Object.keys(slots).length) return null
  return {
    schemaVersion: asText(source.schemaVersion, '1.0'),
    modelVersion: asText(source.modelVersion, 'historical-profile-heuristic-v1'),
    timezone: 'Asia/Taipei',
    riskPolicy: {
      version: asText(riskPolicy.version, 'event-risk-policy-v1'),
      alertThresholds: {
        '30': clamp(asNumber(thresholds['30'], FALLBACK_THRESHOLDS['30'])),
        '60': clamp(asNumber(thresholds['60'], FALLBACK_THRESHOLDS['60'])),
        '120': clamp(asNumber(thresholds['120'], FALLBACK_THRESHOLDS['120'])),
      },
    },
    stations,
    slots,
  }
}

function parseSlot(value: unknown): SlotPayload | null {
  const source = asRecord(value)
  const slot = asNumber(source.slot, Number.NaN)
  if (!Number.isInteger(slot) || slot < 0 || slot > 47) return null

  const profiles: Record<string, CompactProfile> = {}
  for (const [id, value] of Object.entries(asRecord(source.profiles))) {
    if (!Array.isArray(value) || value.length !== 6) continue
    const compact = value.map(item => Math.max(0, Math.round(asNumber(item)))) as CompactProfile
    if (!compact.slice(3).every(item => item <= 1000)) continue
    profiles[id] = compact
  }
  return Object.keys(profiles).length ? { slot, profiles } : null
}

export function useLiveRiskProfiles() {
  const manifest = useState<ProfileManifest | null>('live-risk-profile-manifest', () => null)
  const error = useState('live-risk-profile-error', () => '')

  async function loadManifest(): Promise<ProfileManifest> {
    if (manifest.value) return manifest.value
    const response = await $fetch<unknown>('/data/live-profile/manifest.json', { cache: 'force-cache' })
    const parsed = parseManifest(response)
    if (!parsed) throw new Error('歷史基線設定檔格式不完整。')
    manifest.value = parsed
    matchIndex = new Map()
    for (const station of parsed.stations) {
      const matches = matchIndex.get(station.matchKey) || []
      matches.push(station.id)
      matchIndex.set(station.matchKey, matches)
    }
    return parsed
  }

  async function loadSlot(slot: number, profileManifest: ProfileManifest): Promise<SlotPayload | null> {
    const cached = slotCache.get(slot)
    if (cached) return cached
    const path = profileManifest.slots[String(slot)]
    if (!path) return null
    const parsed = parseSlot(await $fetch<unknown>(path, { cache: 'force-cache' }))
    if (parsed) slotCache.set(slot, parsed)
    return parsed
  }

  async function forecastsFor(stations: LiveStation[], observedAt: string): Promise<Map<string, Record<HorizonKey, Forecast>>> {
    const results = new Map<string, Record<HorizonKey, Forecast>>()
    try {
      const profileManifest = await loadManifest()
      const slots = Object.fromEntries(await Promise.all(HORIZONS.map(async (horizon) => {
        const slot = taipeiSlot(observedAt, Number(horizon))
        return [horizon, await loadSlot(slot, profileManifest)] as const
      }))) as Record<HorizonKey, SlotPayload | null>

      for (const station of stations) {
        const candidates = matchIndex?.get(liveMatchKey(station)) || []
        const historicalId = candidates.length === 1 ? candidates[0] : null
        const momentum = recentMomentum(station, observedAt)
        const horizons = {} as Record<HorizonKey, Forecast>

        for (const horizon of HORIZONS) {
          if (station.serviceStatus !== 'operational') {
            horizons[horizon] = inventoryOnlyForecast(station, horizon, '來源顯示疑似服務異常，需人工確認；不產生未來庫存風險。', 'not_applicable')
            continue
          }
          const profile = historicalId ? slots[horizon]?.profiles[historicalId] : null
          horizons[horizon] = profile
            ? makeForecast(station, profile, horizon, profileManifest.riskPolicy.alertThresholds[horizon], momentum)
            : inventoryOnlyForecast(station, horizon, '未對照到唯一的歷史站點基線；僅顯示即時庫存。', 'unmatched')
        }
        results.set(station.id, horizons)
        rememberSnapshot(station, observedAt)
      }
      error.value = ''
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '無法載入歷史基線，因此只顯示即時庫存。'
      for (const station of stations) {
        results.set(station.id, {
          '30': inventoryOnlyForecast(station, '30', '歷史基線暫時無法載入；僅顯示即時庫存。', 'unmatched'),
          '60': inventoryOnlyForecast(station, '60', '歷史基線暫時無法載入；僅顯示即時庫存。', 'unmatched'),
          '120': inventoryOnlyForecast(station, '120', '歷史基線暫時無法載入；僅顯示即時庫存。', 'unmatched'),
        })
      }
    }
    return results
  }

  return { manifest, error, forecastsFor }
}
