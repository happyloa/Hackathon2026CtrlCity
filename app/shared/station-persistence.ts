/** Browser-safe contract for scheduler observations; no AWS SDK enters the SPA. */
export interface StationPersistence {
  currentState: string
  stateSince: string
  stateMinutes: number
  unchangedSince: string
  unchangedMinutes: number
  last: [number, number]
  /**
   * How long `availableBikes` has stayed below LOW_BIKES_THRESHOLD without a
   * break. Omitted while the station is at or above the threshold, which keeps
   * the published file small -- most stations are not low at any given moment.
   *
   * The browser used to derive this from its own rolling buffer, which meant
   * the list stayed empty until a tab had been open for the whole window. The
   * scheduler already sees every poll, so it answers the question once for
   * everyone instead.
   */
  lowBikesSince?: string
  lowBikesMinutes?: number
  /**
   * One metric held at a single reading of 0..FROZEN_STATION_POLICY
   * .stuckValueCeiling while the other stayed positive -- the live counterpart
   * of `scripts/detect-frozen-stations.mjs`. Omitted unless the station is
   * currently a candidate.
   */
  frozenMetric?: 'bikes' | 'docks'
  frozenValue?: number
  frozenSince?: string
  frozenMinutes?: number
}
export interface PersistenceState {
  schemaVersion: '1.0'
  updatedAt: string
  bucketMinutes: number
  stations: Record<string, StationPersistence>
}

function validOptionalRun(since: unknown, minutes: unknown): boolean {
  if (since === undefined && minutes === undefined) return true
  return typeof since === 'string' && Number.isFinite(Date.parse(since))
    && typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
}

export function freshPersistence(value: unknown, now = Date.now()): PersistenceState | null {
  const data = value as PersistenceState | null
  const age = now - Date.parse(data?.updatedAt ?? '')
  if (data?.schemaVersion !== '1.0' || !Number.isFinite(age) || age < -60_000 || age >= 15 * 60_000
    || !data.stations || typeof data.stations !== 'object' || Array.isArray(data.stations)) return null
  for (const item of Object.values(data.stations)) {
    if (!item || typeof item.currentState !== 'string' || !Array.isArray(item.last) || item.last.length !== 2
      || !item.last.every(n => Number.isFinite(n) && n >= 0)
      || !Number.isFinite(item.stateMinutes) || item.stateMinutes < 0
      || !Number.isFinite(item.unchangedMinutes) || item.unchangedMinutes < 0
      || !Number.isFinite(Date.parse(item.stateSince)) || !Number.isFinite(Date.parse(item.unchangedSince))) return null
    // Optional runs are absent on files written before this field existed, and
    // absent on stations the condition does not currently apply to.
    if (!validOptionalRun(item.lowBikesSince, item.lowBikesMinutes)) return null
    if (!validOptionalRun(item.frozenSince, item.frozenMinutes)) return null
    if (item.frozenMetric !== undefined && item.frozenMetric !== 'bikes' && item.frozenMetric !== 'docks') return null
  }
  return data
}

/**
 * True when the file carries the scheduler-computed runs, not just the base
 * clocks. A deployment whose Lambda predates those fields keeps using the
 * browser's own buffer, so an old file degrades instead of emptying the lists.
 */
export function hasServerRuns(state: PersistenceState | null): boolean {
  return state !== null && Object.values(state.stations).some(item => item.lowBikesSince !== undefined)
}

/** Stations whose available bikes have stayed below the threshold for `minutes`. */
export function lowBikesIdsFromPersistence(state: PersistenceState, minutes: number): string[] {
  return Object.entries(state.stations)
    .filter(([, item]) => (item.lowBikesMinutes ?? -1) >= minutes)
    .map(([stationId]) => stationId)
    .sort()
}

export interface FrozenStationRun {
  stationId: string
  metric: 'bikes' | 'docks'
  stuckValue: number
}

/** Stations whose stuck metric has held its reading for `minutes`. */
export function frozenStationsFromPersistence(state: PersistenceState, minutes: number): FrozenStationRun[] {
  return Object.entries(state.stations)
    .filter(([, item]) => item.frozenMetric !== undefined && (item.frozenMinutes ?? -1) >= minutes)
    .map(([stationId, item]) => ({ stationId, metric: item.frozenMetric!, stuckValue: item.frozenValue ?? 0 }))
    .sort((left, right) => left.stationId.localeCompare(right.stationId))
}
