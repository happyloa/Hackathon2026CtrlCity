/** Browser-safe contract for scheduler observations; no AWS SDK enters the SPA. */
export interface StationPersistence {
  currentState: string
  stateSince: string
  stateMinutes: number
  unchangedSince: string
  unchangedMinutes: number
  last: [number, number]
}
export interface PersistenceState {
  schemaVersion: '1.0'
  updatedAt: string
  bucketMinutes: number
  stations: Record<string, StationPersistence>
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
  }
  return data
}
