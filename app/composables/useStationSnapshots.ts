import { LIVE_SNAPSHOT_POLICY } from '~/shared/parameters.mjs'

export interface StationSnapshot {
  at: number
  bikes: number
  docks: number
}

export interface StationSnapshotInput {
  id: string
  availableBikes: number
  availableDocks: number
}

const STORAGE_KEY = 'station-snapshots:v1'
const FIVE_MINUTES_MS = 5 * 60_000
const RETENTION_MS = LIVE_SNAPSHOT_POLICY.localStorageRetentionHours * 60 * 60_000

/**
 * Module-scope singleton, shared by every `useStationSnapshots()` caller in
 * this tab (alerts, momentum, and future frozen-station detection all read
 * and write the same buffer) -- mirrors the existing `slotCache`/`matchIndex`
 * pattern in `useLiveRiskProfiles.ts` rather than Nuxt's `useState`, since
 * this is plain in-memory + localStorage state with no SSR-hydration story
 * (it is live-mode-only and never touches the server).
 */
const store = new Map<string, StationSnapshot[]>()
let loaded = false

function isSnapshot(value: unknown): value is StationSnapshot {
  const candidate = value as Partial<StationSnapshot> | null
  return typeof candidate?.at === 'number'
    && typeof candidate?.bikes === 'number'
    && typeof candidate?.docks === 'number'
}

/** Rounds to the nearest 5-minute wall-clock boundary. */
function normalizedEpoch(epoch: number): number {
  return Math.round(epoch / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
}

function withoutStale(snapshots: readonly StationSnapshot[], nowEpoch: number): StationSnapshot[] {
  const cutoff = nowEpoch - RETENTION_MS
  return snapshots.filter(snapshot => snapshot.at >= cutoff)
}

function loadFromStorage() {
  if (loaded || !import.meta.client) return
  loaded = true
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const now = Date.now()
    for (const [stationId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const valid = withoutStale(value.filter(isSnapshot), now)
      if (valid.length) store.set(stationId, valid)
    }
  } catch {
    // Corrupt or inaccessible storage falls back to an empty in-memory buffer.
  }
}

function persist() {
  if (!import.meta.client) return
  try {
    const payload: Record<string, StationSnapshot[]> = {}
    for (const [stationId, snapshots] of store) payload[stationId] = snapshots
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // A full or blocked storage quota must not take the page down; the
    // in-memory buffer for this tab keeps working either way.
  }
}

/**
 * Shared browser-side history of each station's live bikes/docks readings,
 * persisted to localStorage so it survives a reload. This is the single
 * source every live-mode feature that needs "what has this station's
 * inventory looked like recently" reads from and writes to: the rule
 * baseline's momentum term, the real-time low-bikes persistence lists, and
 * client-side frozen/stuck-station detection.
 */
export function useStationSnapshots() {
  loadFromStorage()

  /** One station's snapshots, oldest first. */
  function snapshotsFor(stationId: string): readonly StationSnapshot[] {
    return store.get(stationId) ?? []
  }

  /**
   * Records one poll's readings for every station in a single pass, then
   * persists once -- not once per station -- since this only ever runs
   * once per `useLivePolling.ts` cycle (every 5 minutes).
   */
  function remember(stations: readonly StationSnapshotInput[], observedAt: string) {
    const epoch = Date.parse(observedAt)
    if (!Number.isFinite(epoch)) return
    const at = normalizedEpoch(epoch)

    for (const station of stations) {
      const existing = store.get(station.id) ?? []
      const next = withoutStale(
        [...existing.filter(snapshot => snapshot.at !== at), { at, bikes: station.availableBikes, docks: station.availableDocks }]
          .sort((left, right) => left.at - right.at),
        at,
      ).slice(-LIVE_SNAPSHOT_POLICY.maxSnapshotsPerStation)
      store.set(station.id, next)
    }
    persist()
  }

  return { snapshotsFor, remember }
}
