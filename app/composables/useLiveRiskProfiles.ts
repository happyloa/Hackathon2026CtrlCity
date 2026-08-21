import type {
  Forecast,
  HorizonKey,
  LiveStation,
  PredictionCoverage,
  PredictionMetadata,
} from '~/shared/ops'

type CompactProfile = [number, number, number, number, number, number]

type ProfileManifest = {
  schemaVersion: string
  modelVersion: string
  timezone: 'Asia/Taipei'
  riskPolicy: {
    version: string
    alertThresholds: Record<HorizonKey, number>
  }
  prediction: PredictionMetadata
  matchKeys: string[]
  legacyStationIds: string[]
  slots: Record<string, string>
}

type SlotPayload = {
  slot: number
  profiles: Array<CompactProfile | null>
}

type LiveSnapshot = {
  at: number
  bikes: number
  docks: number
}

const HORIZONS: HorizonKey[] = ['30', '60', '120']
const FALLBACK_THRESHOLDS: Record<HorizonKey, number> = { '30': .45, '60': .45, '120': .4 }
const PRIMARY_HORIZON: HorizonKey = '60'
const SUFFICIENT_BASELINE_MIN_SAMPLES = 6
const HIGH_CONFIDENCE_MIN_SAMPLES = 12
const slotCache = new Map<number, SlotPayload>()
const snapshotsByStation = new Map<string, LiveSnapshot[]>()
let matchIndex: Map<string, number[]> | undefined

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
  if (sampleSize >= HIGH_CONFIDENCE_MIN_SAMPLES) return 'high'
  if (sampleSize >= SUFFICIENT_BASELINE_MIN_SAMPLES) return 'medium'
  return 'low'
}

function baselineCoverage(sampleSize: number, status: Forecast['baselineStatus']): Forecast['baselineCoverage'] {
  if (status !== 'matched') return status
  return sampleSize >= SUFFICIENT_BASELINE_MIN_SAMPLES ? 'sufficient' : 'limited'
}

function targetAt(observedAt: string, horizon: HorizonKey): string {
  const epoch = Date.parse(observedAt)
  return new Date((Number.isFinite(epoch) ? epoch : Date.now()) + Number(horizon) * 60_000).toISOString()
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
  observedAt: string,
): Forecast {
  const suspected = station.serviceStatus !== 'operational'
  return {
    targetAt: targetAt(observedAt, horizon),
    baselineBikes: null,
    baselineDocks: null,
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
    baselineCoverage: baselineCoverage(0, baselineStatus),
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
  observedAt: string,
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
  const reasons = [`已將官方即時庫存與同站、同時段歷史基線比對（${sampleSize} 筆樣本）。`]
  if (station.availableBikes <= lowThreshold) reasons.push('目前可借車偏低。')
  if (station.availableDocks <= lowThreshold) reasons.push('目前可還位偏低。')
  if (momentum) reasons.push('已納入本頁約 30 分鐘的庫存變化。')
  if (reasons.length === 1) reasons.push('目前庫存與歷史基線型態穩定。')

  return {
    targetAt: targetAt(observedAt, horizon),
    baselineBikes: Math.max(0, Math.min(station.totalDocks, Math.round(meanBikes))),
    baselineDocks: Math.max(0, Math.min(station.totalDocks, Math.round(meanDocks))),
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
    baselineCoverage: baselineCoverage(sampleSize, 'matched'),
    method: 'historical_baseline_live_inventory',
    sampleSize,
    reasons: reasons.slice(0, 3),
  }
}

function parsePredictionMetadata(value: unknown, historicalProfileStations: number): PredictionMetadata {
  const source = asRecord(value)
  const confidencePolicy = asRecord(source.confidencePolicy)
  const coverage = asRecord(source.coverage)
  const sufficientMinSampleSize = Math.max(
    1,
    Math.round(asNumber(confidencePolicy.sufficientMinSampleSize, SUFFICIENT_BASELINE_MIN_SAMPLES)),
  )
  const highConfidenceMinSampleSize = Math.max(
    sufficientMinSampleSize,
    Math.round(asNumber(confidencePolicy.highConfidenceMinSampleSize, HIGH_CONFIDENCE_MIN_SAMPLES)),
  )

  return {
    schemaVersion: '1.0',
    primaryHorizonMinutes: 60,
    objective: 'station_empty_or_full_inventory_risk',
    method: 'historical_station_slot_baseline_plus_live_inventory',
    inputPolicy: ['historical_station_slot_profile', 'current_live_inventory', 'page_session_momentum_optional'],
    confidencePolicy: {
      limitedMaxSampleSize: Math.max(0, Math.min(
        sufficientMinSampleSize - 1,
        Math.round(asNumber(confidencePolicy.limitedMaxSampleSize, sufficientMinSampleSize - 1)),
      )),
      sufficientMinSampleSize,
      highConfidenceMinSampleSize,
    },
    coverage: {
      historicalProfileStations: Math.max(
        0,
        Math.round(asNumber(coverage.historicalProfileStations, historicalProfileStations)),
      ),
      populatedStationSlots: Math.max(0, Math.round(asNumber(coverage.populatedStationSlots, 0))),
    },
  }
}

function parseManifest(value: unknown): ProfileManifest | null {
  const source = asRecord(value)
  const riskPolicy = asRecord(source.riskPolicy)
  const thresholds = asRecord(riskPolicy.alertThresholds)
  const legacyStations = Array.isArray(source.stations)
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

  const matchKeys = Array.isArray(source.matchKeys)
    ? source.matchKeys.map((value) => asText(value))
    : legacyStations.map((station) => station.matchKey)

  if (!matchKeys.length || matchKeys.some((matchKey) => !matchKey) || !Object.keys(slots).length) return null
  return {
    schemaVersion: asText(source.schemaVersion, '1.0'),
    modelVersion: asText(source.modelVersion, 'historical-live-inventory-baseline-v2'),
    timezone: 'Asia/Taipei',
    riskPolicy: {
      version: asText(riskPolicy.version, 'event-risk-policy-v1'),
      alertThresholds: {
        '30': clamp(asNumber(thresholds['30'], FALLBACK_THRESHOLDS['30'])),
        '60': clamp(asNumber(thresholds['60'], FALLBACK_THRESHOLDS['60'])),
        '120': clamp(asNumber(thresholds['120'], FALLBACK_THRESHOLDS['120'])),
      },
    },
    prediction: parsePredictionMetadata(source.prediction, matchKeys.length),
    matchKeys,
    legacyStationIds: legacyStations.length === matchKeys.length
      ? legacyStations.map((station) => station.id)
      : [],
    slots,
  }
}

function compactProfile(value: unknown): CompactProfile | null {
  if (!Array.isArray(value) || value.length !== 6) return null
  const compact = value.map(item => Math.max(0, Math.round(asNumber(item)))) as CompactProfile
  return compact.slice(3).every(item => item <= 1000) ? compact : null
}

function parseSlot(value: unknown, legacyStationIds: string[] = []): SlotPayload | null {
  const source = asRecord(value)
  const slot = asNumber(source.slot, Number.NaN)
  if (!Number.isInteger(slot) || slot < 0 || slot > 47) return null

  const profiles = Array.isArray(source.profiles)
    ? source.profiles.map(compactProfile)
    : legacyStationIds.map((id) => compactProfile(asRecord(source.profiles)[id]))
  return profiles.some(Boolean) ? { slot, profiles } : null
}

export function useLiveRiskProfiles() {
  const manifest = useState<ProfileManifest | null>('live-risk-profile-manifest', () => null)
  const error = useState('live-risk-profile-error', () => '')
  const coverage = useState<PredictionCoverage | null>('live-risk-profile-coverage', () => null)

  function clearProfileCache() {
    manifest.value = null
    matchIndex = undefined
    slotCache.clear()
  }

  async function loadManifest(): Promise<ProfileManifest> {
    if (manifest.value) return manifest.value
    const response = await $fetch<unknown>('/data/live-profile/manifest.json', { cache: 'no-store' })
    const parsed = parseManifest(response)
    if (!parsed) throw new Error('歷史基線設定檔格式不完整。')
    manifest.value = parsed
    matchIndex = new Map()
    for (const [index, matchKey] of parsed.matchKeys.entries()) {
      const matches = matchIndex.get(matchKey) || []
      matches.push(index)
      matchIndex.set(matchKey, matches)
    }
    return parsed
  }

  async function loadSlot(slot: number, profileManifest: ProfileManifest): Promise<SlotPayload | null> {
    const cached = slotCache.get(slot)
    if (cached) return cached
    const path = profileManifest.slots[String(slot)]
    if (!path) return null
    const parsed = parseSlot(await $fetch<unknown>(path, { cache: 'no-store' }), profileManifest.legacyStationIds)
    if (parsed) slotCache.set(slot, parsed)
    return parsed
  }

  async function forecastsFor(
    stations: LiveStation[],
    observedAt: string,
    options: { refreshProfiles?: boolean } = {},
  ): Promise<Map<string, Record<HorizonKey, Forecast>>> {
    if (options.refreshProfiles) clearProfileCache()
    const results = new Map<string, Record<HorizonKey, Forecast>>()
    try {
      const profileManifest = await loadManifest()
      const slots = Object.fromEntries(await Promise.all(HORIZONS.map(async (horizon) => {
        const slot = taipeiSlot(observedAt, Number(horizon))
        return [horizon, await loadSlot(slot, profileManifest)] as const
      }))) as Record<HorizonKey, SlotPayload | null>
      let matchedStations = 0
      let unmatchedStations = 0
      let ambiguousStationMatches = 0
      let notApplicableStations = 0

      for (const station of stations) {
        const candidates = matchIndex?.get(liveMatchKey(station)) || []
        const historicalIndex = candidates.length === 1 ? candidates[0] ?? null : null
        const momentum = recentMomentum(station, observedAt)
        const horizons = {} as Record<HorizonKey, Forecast>
        const primaryProfile = historicalIndex === null ? null : slots[PRIMARY_HORIZON]?.profiles[historicalIndex] || null

        if (station.serviceStatus !== 'operational') notApplicableStations += 1
        else if (candidates.length > 1) {
          ambiguousStationMatches += 1
          unmatchedStations += 1
        } else if (primaryProfile) matchedStations += 1
        else unmatchedStations += 1

        for (const horizon of HORIZONS) {
          if (station.serviceStatus !== 'operational') {
            horizons[horizon] = inventoryOnlyForecast(station, horizon, '來源顯示疑似服務異常，需人工確認；不產生未來庫存風險。', 'not_applicable', observedAt)
            continue
          }
          const profile = historicalIndex === null ? null : slots[horizon]?.profiles[historicalIndex] || null
          horizons[horizon] = profile
            ? makeForecast(station, profile, horizon, profileManifest.riskPolicy.alertThresholds[horizon], momentum, observedAt)
            : inventoryOnlyForecast(station, horizon, '未對照到唯一且有樣本的歷史站點基線；僅顯示即時庫存。', 'unmatched', observedAt)
        }
        results.set(station.id, horizons)
        rememberSnapshot(station, observedAt)
      }
      coverage.value = {
        asOf: observedAt,
        primaryHorizonMinutes: profileManifest.prediction.primaryHorizonMinutes,
        historicalProfileStations: profileManifest.prediction.coverage.historicalProfileStations,
        liveStations: stations.length,
        matchedStations,
        unmatchedStations,
        ambiguousStationMatches,
        notApplicableStations,
        matchedRate: stations.length ? matchedStations / stations.length : 0,
      }
      error.value = ''
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '無法載入歷史基線，因此只顯示即時庫存。'
      const notApplicableStations = stations.filter(station => station.serviceStatus !== 'operational').length
      coverage.value = {
        asOf: observedAt,
        primaryHorizonMinutes: 60,
        historicalProfileStations: 0,
        liveStations: stations.length,
        matchedStations: 0,
        unmatchedStations: Math.max(0, stations.length - notApplicableStations),
        ambiguousStationMatches: 0,
        notApplicableStations,
        matchedRate: 0,
      }
      for (const station of stations) {
        results.set(station.id, {
          '30': inventoryOnlyForecast(station, '30', '歷史基線暫時無法載入；僅顯示即時庫存。', station.serviceStatus === 'operational' ? 'unmatched' : 'not_applicable', observedAt),
          '60': inventoryOnlyForecast(station, '60', '歷史基線暫時無法載入；僅顯示即時庫存。', station.serviceStatus === 'operational' ? 'unmatched' : 'not_applicable', observedAt),
          '120': inventoryOnlyForecast(station, '120', '歷史基線暫時無法載入；僅顯示即時庫存。', station.serviceStatus === 'operational' ? 'unmatched' : 'not_applicable', observedAt),
        })
      }
    }
    return results
  }

  return { manifest, error, coverage, forecastsFor }
}
