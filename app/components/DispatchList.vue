<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type DispatchRecommendation, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  compact?: boolean
  maxItems?: number
  embedded?: boolean
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ accept: [dispatchId: string]; select: [stationId: string] }>()

const stationLookup = computed(() => new Map(props.stations.map(station => [station.id, station])))
const visibleDispatches = computed(() => props.compact ? props.dispatches.slice(0, props.maxItems || 3) : props.dispatches)
const allDispatchesTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))
const nameFor = (id: string) => displayStationName(stationLookup.value.get(id)?.name || '')
const expandedDispatchId = ref<string | null>(null)
const containerClasses = {
  default: 'panel overflow-hidden',
  embedded: 'overflow-hidden border-0 bg-transparent shadow-none',
} as const
const operationClasses = {
  deliver_bikes: 'border-positive bg-positive-surface text-positive',
  remove_bikes: 'border-info bg-info-surface text-info',
} as const
const assignClasses = {
  proposed: 'border-accent bg-accent text-on-accent hover:bg-accent-strong',
  assigned: 'border-line bg-panel-muted text-muted',
  completed: 'border-line bg-panel-muted text-muted',
} as const
const safetyClasses = {
  safe: 'text-positive',
  unsafe: 'text-danger',
} as const
const operationLabel = (dispatch: DispatchRecommendation) => dispatch.operation === 'remove_bikes' ? '移車' : '補車'
const sourceRole = (dispatch: DispatchRecommendation) => dispatch.operation === 'remove_bikes' ? '待疏散滿位站' : '供給站'
const destinationRole = (dispatch: DispatchRecommendation) => dispatch.operation === 'remove_bikes' ? '接收空位站' : '缺車站'
const sourceSafetyLabel = (dispatch: DispatchRecommendation) => dispatch.operation === 'remove_bikes' ? '移出後保留可借車' : '調出後安全庫存'
const destinationSafetyLabel = () => '調度後保留可還位'

function impactFor(dispatch: DispatchRecommendation) {
  const from = stationLookup.value.get(dispatch.fromStationId)
  const to = stationLookup.value.get(dispatch.toStationId)
  if (!from || !to) return null

  const movableBikes = Math.max(0, Math.min(dispatch.bikeCount, from.availableBikes, to.availableDocks))
  const donorSafetyStock = Math.max(2, Math.ceil(from.totalDocks * .15))
  const receiverDockBuffer = Math.max(2, Math.ceil(to.totalDocks * .1))
  const fromAfterBikes = Math.max(0, from.availableBikes - movableBikes)
  const fromAfterDocks = Math.min(from.totalDocks, from.availableDocks + movableBikes)
  const toAfterBikes = Math.min(to.totalDocks, to.availableBikes + movableBikes)
  const toAfterDocks = Math.max(0, to.availableDocks - movableBikes)

  return {
    from,
    to,
    movableBikes,
    donorSafetyStock,
    receiverDockBuffer,
    fromAfterBikes,
    fromAfterDocks,
    toAfterBikes,
    toAfterDocks,
    donorSafe: fromAfterBikes >= donorSafetyStock,
    receiverSafe: toAfterDocks >= receiverDockBuffer,
  }
}

function toggleImpact(dispatchId: string) {
  expandedDispatchId.value = expandedDispatchId.value === dispatchId ? null : dispatchId
}
</script>

<template>
  <section :class="embedded ? containerClasses.embedded : containerClasses.default">
    <div v-if="!embedded" class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 搬運任務清單</p>
        <h2 class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">先處理這些搬運任務</h2>
      </div>
      <NuxtLink v-if="compact" :to="allDispatchesTarget" class="text-link min-h-11 text-base">調度工作台 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </div>

    <div v-if="visibleDispatches.length" class="divide-y divide-line">
      <article v-for="dispatch in visibleDispatches" :key="dispatch.id" class="p-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span class="shrink-0 rounded-full border px-2 py-1 text-base font-bold" :class="operationClasses[dispatch.operation]">{{ operationLabel(dispatch) }}</span>
            <button type="button" class="min-w-0 flex-1 break-words text-left text-base font-bold text-ink hover:text-accent hover:underline" @click="emit('select', dispatch.fromStationId)">{{ nameFor(dispatch.fromStationId) }}</button>
            <span class="shrink-0 text-lg text-muted" aria-hidden="true"><Icon icon="solar:arrow-right-outline" /></span>
            <button type="button" class="min-w-0 flex-1 break-words text-left text-base font-bold text-accent hover:text-accent-strong hover:underline" @click="emit('select', dispatch.toStationId)">{{ nameFor(dispatch.toStationId) }}</button>
          </div>
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base text-muted lg:justify-end">
            <span><b class="font-mono text-lg text-ink">{{ dispatch.bikeCount }}</b> 台</span>
            <small class="text-base">{{ dispatch.distanceKm.toFixed(1) }} km · 優先 {{ Math.round(dispatch.priorityScore) }}</small>
          </div>
          <button
            type="button"
            class="min-h-11 w-full rounded-md border px-3 text-base font-bold transition-colors sm:w-auto"
            :class="assignClasses[dispatch.status]"
            :disabled="dispatch.status !== 'proposed'"
            @click="emit('accept', dispatch.id)"
          >
            {{ dispatch.status === 'proposed' ? `指派${operationLabel(dispatch)}` : '已指派' }}
          </button>
        </div>
        <button type="button" class="mt-2 inline-flex min-h-11 items-center gap-1 text-base font-bold text-accent hover:text-accent-strong hover:underline" :aria-expanded="expandedDispatchId === dispatch.id" @click="toggleImpact(dispatch.id)">
          <Icon icon="solar:calculator-minimalistic-outline" />
          {{ expandedDispatchId === dispatch.id ? '收合調度影響試算' : '查看調度影響試算' }}
          <Icon :icon="expandedDispatchId === dispatch.id ? 'solar:alt-arrow-up-outline' : 'solar:alt-arrow-down-outline'" />
        </button>
        <section v-if="expandedDispatchId === dispatch.id && impactFor(dispatch)" class="mt-1 rounded-lg border border-line bg-panel-muted p-3" aria-label="調度影響試算">
          <p class="m-0 flex items-start gap-2 text-base font-semibold leading-6 text-muted"><Icon class="mt-1 shrink-0 text-lg text-warning" icon="solar:shield-warning-outline" /> 模擬結果，不改寫預測；指派前仍需人工覆核。</p>
          <div class="mt-3 grid gap-3 lg:grid-cols-3">
            <div class="rounded-md border border-line bg-panel p-3">
              <p class="m-0 mb-2 grid gap-1 text-base font-bold text-ink"><span class="text-muted">{{ sourceRole(dispatch) }}</span>{{ displayStationName(impactFor(dispatch)?.from.name || '') }}</p>
              <dl class="grid gap-1 text-base">
                <div class="flex justify-between gap-2 text-muted"><dt>可借車</dt><dd class="m-0 font-mono font-bold text-ink">{{ impactFor(dispatch)?.from.availableBikes }} <b class="px-1 text-muted">→</b> <strong class="text-accent">{{ impactFor(dispatch)?.fromAfterBikes }}</strong></dd></div>
                <div class="flex justify-between gap-2 text-muted"><dt>可還位</dt><dd class="m-0 font-mono font-bold text-ink">{{ impactFor(dispatch)?.from.availableDocks }} <b class="px-1 text-muted">→</b> <strong class="text-accent">{{ impactFor(dispatch)?.fromAfterDocks }}</strong></dd></div>
              </dl>
              <small class="mt-2 flex items-center gap-1 text-base font-bold" :class="impactFor(dispatch)?.donorSafe ? safetyClasses.safe : safetyClasses.unsafe"><Icon :icon="impactFor(dispatch)?.donorSafe ? 'solar:check-circle-outline' : 'solar:danger-triangle-outline'" /> {{ sourceSafetyLabel(dispatch) }}：{{ impactFor(dispatch)?.donorSafetyStock }} 台</small>
            </div>
            <div class="flex items-center gap-2 text-base font-bold text-accent lg:flex-col lg:justify-center lg:text-center"><Icon class="text-2xl" icon="solar:round-arrow-right-outline" /><span>搬運 {{ impactFor(dispatch)?.movableBikes }} 台</span></div>
            <div class="rounded-md border border-line bg-panel p-3">
              <p class="m-0 mb-2 grid gap-1 text-base font-bold text-ink"><span class="text-muted">{{ destinationRole(dispatch) }}</span>{{ displayStationName(impactFor(dispatch)?.to.name || '') }}</p>
              <dl class="grid gap-1 text-base">
                <div class="flex justify-between gap-2 text-muted"><dt>可借車</dt><dd class="m-0 font-mono font-bold text-ink">{{ impactFor(dispatch)?.to.availableBikes }} <b class="px-1 text-muted">→</b> <strong class="text-accent">{{ impactFor(dispatch)?.toAfterBikes }}</strong></dd></div>
                <div class="flex justify-between gap-2 text-muted"><dt>可還位</dt><dd class="m-0 font-mono font-bold text-ink">{{ impactFor(dispatch)?.to.availableDocks }} <b class="px-1 text-muted">→</b> <strong class="text-accent">{{ impactFor(dispatch)?.toAfterDocks }}</strong></dd></div>
              </dl>
              <small class="mt-2 flex items-center gap-1 text-base font-bold" :class="impactFor(dispatch)?.receiverSafe ? safetyClasses.safe : safetyClasses.unsafe"><Icon :icon="impactFor(dispatch)?.receiverSafe ? 'solar:check-circle-outline' : 'solar:danger-triangle-outline'" /> {{ destinationSafetyLabel() }}：{{ impactFor(dispatch)?.receiverDockBuffer }} 位</small>
            </div>
          </div>
        </section>
      </article>
    </div>
    <div v-else class="flex min-h-24 items-center justify-center gap-2 p-4 text-center text-base font-semibold text-positive"><Icon class="text-lg" icon="solar:check-circle-outline" />目前沒有可行的搬運建議。</div>
  </section>
</template>
