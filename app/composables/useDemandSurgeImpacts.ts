import { nextUpcomingSurgePhase, upcomingDemandSurgeImpacts, type DemandSurgeImpact, type UpcomingSurgePhase } from '~/shared/demand-surge-impact.ts'
import type { StationRisk } from '~/shared/ops'

/**
 * Surfaces demand events (predicted usage surges declared on /admin/events)
 * starting within the next 60 minutes, alongside whether the 500m neighbour
 * group around each affected station has enough spare bikes to proactively
 * top it up before it runs out. Ticks its own clock so the 30/60-minute
 * tiers advance while a page stays open, independent of the live
 * dashboard's poll cycle.
 */
export function useDemandSurgeImpacts(stations: () => StationRisk[] | undefined) {
  const { events } = useDemandEvents()
  const nowEpoch = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    timer = setInterval(() => { nowEpoch.value = Date.now() }, 60_000)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  const impacts = computed<DemandSurgeImpact[]>(() => {
    const list = stations()
    if (!list || !list.length) return []
    return upcomingDemandSurgeImpacts(events.value, list, nowEpoch.value)
  })
  const nextPhase = computed<UpcomingSurgePhase | null>(() => nextUpcomingSurgePhase(events.value, nowEpoch.value))

  return { impacts, nextPhase }
}
