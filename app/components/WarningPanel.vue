<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { refillAmountFor } from '~/shared/operational-policy.mjs'
import { buildLiveOperations } from '~/shared/live-operations'
import { displayStationName, type DashboardSummary, type HorizonKey, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  stations: StationRisk[]
  asOf: string
  summary: DashboardSummary
}>()

const emit = defineEmits<{ select: [stationId: string] }>()

const TABS: { key: HorizonKey; label: string }[] = [
  { key: '30', label: '30 分鐘' },
  { key: '60', label: '60 分鐘' },
]

const activeHorizon = ref<HorizonKey>('30')

/**
 * A station only belongs here once its forecast for this horizon is
 * "empty_forecast" -- the same threshold `buildLiveOperations` uses for the
 * dispatch route. A station that has already run out comes back as
 * "empty_now" instead and is excluded, because that's not a warning anymore,
 * it's something to dispatch for right now.
 */
function warningsFor(horizon: HorizonKey) {
  const alerts = buildLiveOperations(props.stations, props.asOf, { horizon }).alerts
  const stationLookup = new Map(props.stations.map(station => [station.id, station]))
  return alerts
    .filter(alert => alert.condition === 'empty_forecast')
    .map((alert) => {
      const station = stationLookup.get(alert.stationId)!
      const predictedBikes = Math.max(0, station.forecast.horizons[horizon].predictedBikes)
      return {
        station,
        // Round only for display; feeding the raw forecast (not the rounded
        // display value) into refillAmountFor keeps this exactly aligned
        // with the dispatch route's own gap calculation.
        predictedBikesDisplay: Math.round(predictedBikes),
        refillBikes: refillAmountFor(station, predictedBikes),
      }
    })
    .sort((left, right) => right.refillBikes - left.refillBikes || left.station.id.localeCompare(right.station.id))
}

const warningsByHorizon = computed(() => Object.fromEntries(
  TABS.map(({ key }) => [key, warningsFor(key)]),
) as Record<HorizonKey, ReturnType<typeof warningsFor>>)
const countsByHorizon = computed(() => Object.fromEntries(
  TABS.map(({ key }) => [key, warningsByHorizon.value[key].length]),
) as Record<HorizonKey, number>)
const activeWarnings = computed(() => warningsByHorizon.value[activeHorizon.value])
const description = computed(() => {
  const horizonSummary = TABS.map(tab => `${tab.label} ${countsByHorizon.value[tab.key]} 站`).join(' · ')
  return `${horizonSummary} · 空站 ${props.summary.emptyNow} · 滿柱 ${props.summary.fullNow}`
})
</script>

<template>
  <section class="panel overflow-hidden">
    <DisclosurePanel title="示警" icon="solar:bell-bing-outline" :description="description">
      <div class="flex flex-wrap gap-2 px-4 pb-3 pt-1" role="tablist" aria-label="預測視野">
        <button v-for="tab in TABS" :key="tab.key" type="button" role="tab" :aria-selected="activeHorizon === tab.key"
          class="min-h-9 rounded-md border px-3 text-base font-semibold transition-colors" :class="activeHorizon === tab.key
            ? 'border-accent-strong bg-accent text-on-accent'
            : 'border-line bg-panel-muted text-muted hover:border-accent-strong'" @click="activeHorizon = tab.key">
          {{ tab.label }}（{{ countsByHorizon[tab.key] }}）
        </button>
      </div>

      <div v-if="activeWarnings.length" class="divide-y divide-line border-t border-line">
        <button v-for="item in activeWarnings" :key="item.station.id" type="button"
          class="flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-panel-muted"
          @click="emit('select', item.station.id)">
          <span class="grid size-10 shrink-0 place-items-center rounded-full bg-warning-surface text-lg text-warning">
            <Icon icon="solar:danger-triangle-outline" />
          </span>
          <span class="min-w-0 flex-1 text-base leading-6 text-ink">
            <strong class="block break-words font-bold">{{ displayStationName(item.station.name) }}</strong>
            <span class="mt-1 block text-muted">{{ item.station.district || '行政區未標示' }}</span>
          </span>
          <span class="ml-auto flex w-full items-center justify-between gap-2 text-base sm:w-auto sm:flex-col sm:items-end">
            <span class="text-muted">預估可借車 <strong class="font-mono text-ink">{{ item.predictedBikesDisplay }}</strong> 台</span>
            <span class="text-muted">建議補 <strong class="font-mono text-ink">{{ item.refillBikes }}</strong> 台</span>
          </span>
        </button>
      </div>
      <div v-else class="flex min-h-24 items-center justify-center gap-2 border-t border-line p-4 text-center text-base font-semibold text-positive">
        <Icon class="text-lg" icon="solar:check-circle-outline" />這個視野目前沒有預測會缺車的站。
      </div>
    </DisclosurePanel>
  </section>
</template>
