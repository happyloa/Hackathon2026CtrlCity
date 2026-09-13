import type { DemandEvent } from './demand-events.mjs'
import { parseLocalDateTime } from './operational-adjustments.mjs'
import type { StationRisk } from './ops.ts'
import { groupOperationalStations, type StationForGrouping } from './risk-map-visuals.ts'
import { safetyStockFor } from './operational-policy.mjs'

/** Demand events are always Taipei wall-clock strings (see demand-events.mjs); Taiwan has no DST, so this offset is constant. */
const TAIPEI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * `parseLocalDateTime` reads the string's digits as if they were UTC (the
 * "pseudo-UTC" convention the offline dataset tooling relies on for
 * timezone-independent weekday/slot alignment). Comparing that number
 * directly against `Date.now()` -- a real UTC instant -- silently shifts
 * every trigger by the host's UTC offset: on a Taipei browser (UTC+8) a
 * phase reads as 8 hours later than it truly is, so it can linger for 8
 * hours after the real event ends before its lead time finally goes
 * negative. Subtracting the fixed Taipei offset here converts the pseudo-UTC
 * value into the real UTC instant it names, so it lines up with `Date.now()`.
 */
function parseTaipeiTriggerEpoch(value: string): number | null {
  const pseudoUtc = parseLocalDateTime(value)
  return pseudoUtc === null ? null : pseudoUtc - TAIPEI_UTC_OFFSET_MS
}

/** How close to the phase's trigger time we are; 30min is the more urgent tier. */
export type DemandSurgeImpactTier = '60min' | '30min'

/** Which direction the crowd is expected to move bikes during this phase. */
export type SurgeEffect = 'borrow_surge' | 'return_surge'

interface SurgePhase {
  /** Index within the event's phase sequence -- distinguishes start/end phases in ids. */
  index: number
  triggerAt: string
  effect: SurgeEffect
  label: string
}

/**
 * Splits an event into the phase(s) that actually put pressure on a station.
 * A single-direction event is one phase anchored at startAt; the two-phase
 * patterns model a single gathering: a wave in near startAt and a wave out
 * near endAt, in either order depending which the operator picked.
 */
function phasesFor(event: DemandEvent): SurgePhase[] {
  switch (event.pattern) {
    case 'return_surge':
      return [{ index: 0, triggerAt: event.startAt, effect: 'return_surge', label: '還車潮' }]
    case 'fills_then_empties':
      return [
        { index: 0, triggerAt: event.startAt, effect: 'return_surge', label: '開場還車潮' },
        { index: 1, triggerAt: event.endAt, effect: 'borrow_surge', label: '散場借車潮' },
      ]
    case 'empties_then_fills':
      return [
        { index: 0, triggerAt: event.startAt, effect: 'borrow_surge', label: '開場借車潮' },
        { index: 1, triggerAt: event.endAt, effect: 'return_surge', label: '散場還車潮' },
      ]
    case 'borrow_surge':
    default:
      return [{ index: 0, triggerAt: event.startAt, effect: 'borrow_surge', label: '借車潮' }]
  }
}

export interface UpcomingSurgePhase {
  eventId: string
  eventName: string
  phaseLabel: string
  effect: SurgeEffect
  triggerAt: string
  /** Minutes from now until the phase's trigger time, rounded; always >= 0. */
  leadMinutes: number
}

/**
 * The nearest future phase across all events, regardless of whether it has
 * entered the 60-minute evaluation window yet. Lets the UI say *why* nothing
 * is showing ("next phase is still 3 hours out") instead of going silent,
 * which otherwise looks indistinguishable from a broken feature.
 */
export function nextUpcomingSurgePhase(events: readonly DemandEvent[], nowEpoch: number): UpcomingSurgePhase | null {
  let nearest: UpcomingSurgePhase | null = null
  for (const event of events) {
    for (const phase of phasesFor(event)) {
      const triggerEpoch = parseTaipeiTriggerEpoch(phase.triggerAt)
      if (triggerEpoch === null) continue
      const leadMinutes = Math.round((triggerEpoch - nowEpoch) / 60_000)
      if (leadMinutes < 0) continue
      if (nearest === null || leadMinutes < nearest.leadMinutes) {
        nearest = {
          eventId: event.id,
          eventName: event.name,
          phaseLabel: phase.label,
          effect: phase.effect,
          triggerAt: phase.triggerAt,
          leadMinutes,
        }
      }
    }
  }
  return nearest
}

export interface DemandSurgeImpact {
  eventId: string
  eventName: string
  phaseIndex: number
  phaseLabel: string
  effect: SurgeEffect
  stationId: string
  stationName: string
  district: string
  triggerAt: string
  /** Minutes from now until the phase's trigger time, rounded. */
  leadMinutes: number
  tier: DemandSurgeImpactTier
  /**
   * Proxy for how many bikes this station could see borrowed (or returned)
   * during the phase: its total dock capacity. There is no historical
   * rental-count data in this system (only inventory snapshots), so this is
   * a deliberate, transparent worst-case stand-in rather than a fabricated
   * flow figure -- see 資料與展示界線.md's "不得補造...營運紀錄" rule. A
   * well-attended event can still push real demand above this number.
   */
  estimatedDemand: number
  neighbourStationIds: string[]
  /**
   * For a borrow_surge, bikes neighbours could send over while keeping their
   * own safety stock. For a return_surge, docks neighbours could receive
   * while keeping their own safety stock.
   */
  neighbourSpareCapacity: number
  shortfall: number
  canAbsorb: boolean
  reasons: string[]
}

interface DemandSurgeImpactOptions {
  safetyStockRatio?: number
  minimumSafetyStock?: number
}

function finite(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback
}

function tierFor(leadMinutes: number): DemandSurgeImpactTier | null {
  if (leadMinutes < 0) return null
  if (leadMinutes <= 30) return '30min'
  if (leadMinutes <= 60) return '60min'
  return null
}

/**
 * Finds demand events (predicted usage surges recorded on /admin/events, e.g.
 * a concert or festival near a station) with a phase starting within the
 * next 60 minutes, and estimates whether the 500m neighbour group around
 * each affected station has enough spare bikes or docks to proactively help
 * before it runs out. Decision support only -- per 調度規劃規則.md this never
 * returns an executed instruction, and per 資料與展示界線.md it must not
 * stand in for missing data with a fabricated number, hence the explicit,
 * documented demand proxy above.
 */
export function upcomingDemandSurgeImpacts(
  events: readonly DemandEvent[],
  stations: readonly StationRisk[],
  nowEpoch: number,
  options: DemandSurgeImpactOptions = {},
): DemandSurgeImpact[] {
  const stationById = new Map(stations.map(station => [station.id, station]))

  const groupingInput: StationForGrouping[] = stations.map(station => ({
    id: station.id,
    latitude: station.latitude,
    longitude: station.longitude,
    serviceStatus: station.serviceStatus,
  }))
  const neighbourIdsByStationId = new Map<string, string[]>()
  for (const group of groupOperationalStations(groupingInput)) {
    for (const memberId of group.memberIds) {
      neighbourIdsByStationId.set(memberId, group.memberIds.filter(id => id !== memberId))
    }
  }

  const impacts: DemandSurgeImpact[] = []
  for (const event of events) {
    for (const phase of phasesFor(event)) {
      const triggerEpoch = parseTaipeiTriggerEpoch(phase.triggerAt)
      if (triggerEpoch === null) continue
      const leadMinutes = Math.round((triggerEpoch - nowEpoch) / 60_000)
      const tier = tierFor(leadMinutes)
      if (tier === null) continue

      for (const stationId of event.stationIds) {
        const station = stationById.get(stationId)
        if (!station) continue

        const estimatedDemand = Math.max(0, Math.round(finite(station.totalDocks)))
        const neighbourIds = neighbourIdsByStationId.get(station.id) ?? []
        const neighbours = neighbourIds
          .map(id => stationById.get(id))
          .filter((candidate): candidate is StationRisk => Boolean(candidate))

        const borrow = phase.effect === 'borrow_surge'
        const neighbourSpareCapacity = Math.round(neighbours.reduce((sum, neighbour) => {
          const headroom = borrow
            ? finite(neighbour.availableBikes) - safetyStockFor(neighbour, options)
            : finite(neighbour.availableDocks) - safetyStockFor(neighbour, options)
          return sum + Math.max(0, headroom)
        }, 0))
        const shortfall = Math.max(0, estimatedDemand - neighbourSpareCapacity)
        const canAbsorb = neighbours.length > 0 && shortfall === 0
        const resource = borrow ? '可借車輛' : '可還空位'
        const riskLabel = borrow ? '缺車' : '滿車'
        const actionLabel = borrow ? '調度支援' : '調度移出'

        const reasons = neighbours.length === 0
          ? [`站點 500 公尺內找不到其他營運中站點，無法評估鄰站${actionLabel}能力，建議人工確認補位計畫。`]
          : canAbsorb
            ? [`鄰近 ${neighbours.length} 站合計可${actionLabel}約 ${neighbourSpareCapacity} 台${resource}（已保留各站安全庫存），足以應對本站約 ${estimatedDemand} 台的預估${riskLabel}風險。`]
            : [`鄰近 ${neighbours.length} 站合計可${actionLabel}約 ${neighbourSpareCapacity} 台${resource}，較本站約 ${estimatedDemand} 台的預估量短少 ${shortfall} 台，建議活動前調高安全庫存並加派車輛補位。`]

        impacts.push({
          eventId: event.id,
          eventName: event.name,
          phaseIndex: phase.index,
          phaseLabel: phase.label,
          effect: phase.effect,
          stationId: station.id,
          stationName: station.name,
          district: station.district,
          triggerAt: phase.triggerAt,
          leadMinutes,
          tier,
          estimatedDemand,
          neighbourStationIds: neighbours.map(neighbour => neighbour.id),
          neighbourSpareCapacity,
          shortfall,
          canAbsorb,
          reasons,
        })
      }
    }
  }

  return impacts.sort((left, right) => left.leadMinutes - right.leadMinutes
    || left.stationId.localeCompare(right.stationId)
    || left.phaseIndex - right.phaseIndex)
}
