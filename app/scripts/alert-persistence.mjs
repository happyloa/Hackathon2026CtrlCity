const PERSISTENT_STATES = new Set(['empty', 'full', 'unavailable'])

/**
 * Derive the known duration of a current inventory failure from contiguous
 * half-hour snapshots. A snapshot is evidence for the whole bucket, so even a
 * newly observed condition has a non-zero, 30-minute duration.
 */
export function deriveStatePersistence(history, current, { bucketMinutes = 30 } = {}) {
  if (!current || !PERSISTENT_STATES.has(current.currentState)) return null

  const currentEpoch = Number(current.epoch)
  const intervalMs = bucketMinutes * 60 * 1000
  if (!Number.isFinite(currentEpoch) || !Number.isFinite(intervalMs) || intervalMs <= 0) return null

  const snapshotsByEpoch = new Map()
  for (const snapshot of history) {
    const epoch = Number(snapshot?.epoch)
    if (Number.isFinite(epoch) && epoch <= currentEpoch) snapshotsByEpoch.set(epoch, snapshot)
  }
  // Captures normally already contain the current bucket. Retaining this
  // fallback keeps the result meaningful when a caller passes a partial window.
  snapshotsByEpoch.set(currentEpoch, current)

  let bucketCount = 0
  let startedAt = current.at
  for (let epoch = currentEpoch; ; epoch -= intervalMs) {
    const snapshot = snapshotsByEpoch.get(epoch)
    if (!snapshot || snapshot.currentState !== current.currentState) break
    bucketCount += 1
    startedAt = snapshot.at
  }

  return {
    condition: current.currentState,
    startedAt,
    durationMinutes: bucketCount * bucketMinutes,
  }
}
