import { useStationSnapshots } from '~/composables/useStationSnapshots'
import { FROZEN_STATION_POLICY } from '~/shared/parameters.mjs'
import type { LiveStation } from '~/shared/ops'

export type FrozenMetric = 'bikes' | 'docks'

export interface FrozenStationInfo {
  metric: FrozenMetric
  /** The exact reading (0 through `FROZEN_STATION_POLICY.stuckValueCeiling`) it has been stuck at. */
  stuckValue: number
}

// Tolerates one missed 5-minute poll (`useLivePolling.ts`'s cadence), same as
// the real-time low-bikes persistence check in `useLiveRiskProfiles.ts`.
const FROZEN_POLL_TOLERANCE_MS = 6 * 60_000

function metricValue(metric: FrozenMetric, bikes: number, docks: number): number {
  return metric === 'bikes' ? bikes : docks
}

function otherValue(metric: FrozenMetric, bikes: number, docks: number): number {
  return metric === 'bikes' ? docks : bikes
}

/**
 * Client-side counterpart to `scripts/detect-frozen-stations.mjs`, loosened
 * for live monitoring (see `FROZEN_STATION_POLICY`'s doc comment for why):
 * flags a station where one metric (available bikes, or available docks) has
 * sat at one single reading between 0 and `stuckValueCeiling` for an
 * unbroken run of at least `minutes`, while the other metric stayed
 * positive throughout. Reports both which metric is frozen and the exact
 * value it is stuck at, since that decides the message ("可借車持續為 2 台"
 * vs. "可還位持續為 0 個").
 *
 * Backed entirely by the shared snapshot buffer, so like the low-bikes
 * persistence check, it reports nothing until the buffer has accumulated at
 * least `minutes` of history for a station.
 */
export function frozenStationIds(
  stations: readonly LiveStation[],
  observedAt: string,
  minutes: number = FROZEN_STATION_POLICY.minRunMinutes,
): Map<string, FrozenStationInfo> {
  const result = new Map<string, FrozenStationInfo>()
  const epoch = Date.parse(observedAt)
  if (!Number.isFinite(epoch)) return result
  const windowStart = epoch - minutes * 60_000
  const { snapshotsFor } = useStationSnapshots()

  stationLoop: for (const station of stations) {
    for (const metric of ['bikes', 'docks'] as const) {
      const stuckValue = metricValue(metric, station.availableBikes, station.availableDocks)
      const other = otherValue(metric, station.availableBikes, station.availableDocks)
      if (stuckValue > FROZEN_STATION_POLICY.stuckValueCeiling || other <= 0) continue

      const snapshots = snapshotsFor(station.id)
      const withinWindow = snapshots.filter(snapshot => snapshot.at <= epoch
        && snapshot.at >= windowStart - FROZEN_POLL_TOLERANCE_MS)
      const earliest = withinWindow[0]
      if (!earliest || earliest.at > windowStart + FROZEN_POLL_TOLERANCE_MS) continue

      const stillFrozen = withinWindow.every(snapshot => metricValue(metric, snapshot.bikes, snapshot.docks) === stuckValue
        && otherValue(metric, snapshot.bikes, snapshot.docks) > 0)
      if (stillFrozen) {
        result.set(station.id, { metric, stuckValue })
        continue stationLoop
      }
    }
  }

  return result
}
