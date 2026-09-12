<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type Alert, type StationRisk } from '~/shared/ops'
import { stationOverviewStatus } from '~/shared/station-overview'

const props = withDefaults(defineProps<{
  stations: StationRisk[]
  alerts: Alert[]
  pageSize?: number
  resetKey?: string
}>(), {
  pageSize: 50,
})

const emit = defineEmits<{ select: [stationId: string] }>()
const visibleCount = ref(props.pageSize)
const alertLookup = computed(() => new Map(props.alerts.map(alert => [alert.stationId, alert])))
const visibleStations = computed(() => props.stations.slice(0, visibleCount.value))
const remainingCount = computed(() => Math.max(0, props.stations.length - visibleStations.value.length))

watch(() => props.resetKey, () => { visibleCount.value = props.pageSize })

function statusFor(station: StationRisk) {
  return stationOverviewStatus(station, alertLookup.value.get(station.id))
}

function statusLabel(station: StationRisk) {
  const status = statusFor(station)
  if (status === 'service') return station.serviceStatus === 'official_inactive' ? '官方停用' : '服務異常'
  if (status === 'unknown') return '資料不足'
  if (status === 'stable') return '穩定'

  const condition = alertLookup.value.get(station.id)?.condition
  if (status === 'empty') return condition === 'empty_now' ? '目前無車' : '可能缺車'
  return condition === 'full_now' ? '目前無位' : '可能缺位'
}

function statusClasses(station: StationRisk) {
  const status = statusFor(station)
  if (status === 'service') return 'border-line-strong text-muted'
  if (status === 'unknown') return 'border-warning text-warning'
  if (status === 'stable') return 'border-positive text-positive'
  return status === 'empty' ? 'border-danger text-danger' : 'border-info text-info'
}

function rowClasses(station: StationRisk) {
  const status = statusFor(station)
  if (status === 'service') return 'border-l-line-strong bg-panel-muted'
  if (status === 'unknown') return 'border-l-warning bg-warning-surface'
  if (status === 'stable') return 'border-l-positive bg-positive-surface'
  return status === 'empty' ? 'border-l-danger' : 'border-l-info'
}

/**
 * Empty/full rows read a priority score (0-100, see `scoreAlertPriority`), so
 * their fill is a horizontal bar sized to that score instead of a flat block
 * -- a 95-point station and a 73-point station shouldn't look equally severe.
 */
function rowStyle(station: StationRisk) {
  const status = statusFor(station)
  if (status !== 'empty' && status !== 'full') return {}
  const pct = Math.max(0, Math.min(100, alertLookup.value.get(station.id)?.priorityScore ?? 0))
  const surface = status === 'empty' ? 'var(--danger-surface)' : 'var(--info-surface)'
  return { background: `linear-gradient(to right, ${surface} 0%, ${surface} ${pct}%, transparent ${pct}%)` }
}

function statusIcon(station: StationRisk) {
  return {
    empty: 'solar:danger-triangle-outline',
    full: 'solar:danger-triangle-outline',
    stable: 'solar:check-circle-outline',
    unknown: 'solar:question-circle-outline',
    service: 'solar:settings-minimalistic-outline',
  }[statusFor(station)]
}
</script>

<template>
  <section class="panel overflow-hidden" aria-labelledby="station-list-title">
    <header class="flex flex-col gap-2 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="section-kicker"><Icon icon="solar:list-check-outline" /> 站點清單</p>
        <h2 id="station-list-title" class="mt-1 text-xl font-bold">{{ stations.length }} 個站點</h2>
      </div>
      <span class="text-base font-semibold text-muted">需要注意的站點排在前面</span>
    </header>

    <div v-if="visibleStations.length" class="divide-y divide-line">
      <article v-for="station in visibleStations" :key="station.id" class="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 border-l-4 px-4 py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]" :class="rowClasses(station)" :style="rowStyle(station)">
        <span class="grid size-10 shrink-0 place-items-center rounded-full border bg-panel text-lg" :class="statusClasses(station)">
          <Icon :icon="statusIcon(station)" />
        </span>
        <button type="button" class="min-w-0 flex-1 text-left hover:underline" @click="emit('select', station.id)">
          <strong class="block break-words text-base text-ink">{{ displayStationName(station.name) }}</strong>
          <span class="mt-0.5 block text-base text-muted">{{ station.district }} · 可借 {{ station.availableBikes }} · 可還 {{ station.availableDocks }}</span>
        </button>
        <div class="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:row-start-1 sm:justify-end">
          <span class="rounded-md border bg-panel px-2 py-1 text-base font-bold" :class="statusClasses(station)">{{ statusLabel(station) }}</span>
          <strong v-if="statusFor(station) === 'empty' || statusFor(station) === 'full'" class="w-14 text-right font-mono text-base text-ink">{{ Math.round(alertLookup.get(station.id)?.priorityScore || 0) }} 分</strong>
        </div>
      </article>
    </div>
    <div v-else class="flex min-h-32 items-center justify-center gap-2 p-4 text-center text-base font-semibold text-muted">
      <Icon class="text-xl" icon="solar:magnifer-outline" />找不到符合條件的站點
    </div>

    <div v-if="remainingCount" class="border-t border-line p-3 text-center">
      <button type="button" class="min-h-11 rounded-md border border-line-strong bg-panel px-4 text-base font-bold text-accent hover:bg-panel-muted" @click="visibleCount += pageSize">再顯示 {{ Math.min(pageSize, remainingCount) }} 個</button>
    </div>
  </section>
</template>
