<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { Alert, DataMode, DispatchRecommendation, StationRisk } from '~/shared/ops'

const props = defineProps<{
  alerts: Alert[]
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  dataMode: DataMode
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{
  select: [stationId: string]
  acknowledge: [alertId: string]
  accept: [dispatchId: string]
}>()

const proposedDispatches = computed(() => props.dispatches.filter(dispatch => dispatch.status === 'proposed').length)
const openAlerts = computed(() => props.alerts.filter(alert => alert.status === 'open').length)
const headline = computed(() => {
  if (proposedDispatches.value) return `先處理 ${proposedDispatches.value} 筆可行搬運任務`
  if (openAlerts.value) return `先確認 ${openAlerts.value} 個待處理風險`
  return '目前沒有待處理項目'
})
const contextLabel = computed(() => props.dataMode === 'live'
  ? '空／滿站看即時庫存；已對照基線的站點另評估 60 分鐘風險。'
  : '用歷史時點重演相同的確認與指派流程。')
const allDispatchesTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))
const allAlertsTarget = computed(() => ({ path: '/alerts', query: props.contextQuery || {} }))
</script>

<template>
  <section class="panel overflow-hidden" aria-labelledby="task-queue-title">
    <header class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 調度工作佇列</p>
        <h2 id="task-queue-title" class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ headline }}</h2>
        <p class="m-0 mt-2 text-base leading-6 text-muted">{{ contextLabel }}</p>
      </div>
      <div class="flex flex-wrap gap-2 text-base" aria-label="待處理數量">
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1 font-semibold text-muted"><b class="font-mono text-accent">{{ proposedDispatches }}</b> 任務</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1 font-semibold text-muted"><b class="font-mono text-accent">{{ openAlerts }}</b> 風險</span>
      </div>
    </header>

    <div class="divide-y divide-line">
      <section aria-labelledby="dispatch-step-title">
        <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">1</span>
          <div class="min-w-0 flex-1">
            <strong id="dispatch-step-title" class="block text-base text-ink">優先搬運任務</strong>
            <small class="mt-1 block text-base leading-6 text-muted">檢視影響試算後，由值班人員指派。</small>
          </div>
          <NuxtLink :to="allDispatchesTarget" class="text-link ml-auto min-h-11 text-base">全部任務 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
        </div>
        <DispatchList
          embedded
          compact
          :max-items="2"
          :dispatches="dispatches"
          :stations="stations"
          :context-query="contextQuery"
          @select="emit('select', $event)"
          @accept="emit('accept', $event)"
        />
      </section>

      <section aria-labelledby="alert-step-title">
        <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">2</span>
          <div class="min-w-0 flex-1">
            <strong id="alert-step-title" class="block text-base text-ink">待確認風險</strong>
            <small class="mt-1 block text-base leading-6 text-muted">確認異常或補充現場資訊；完整清單仍可另外查看。</small>
          </div>
          <NuxtLink :to="allAlertsTarget" class="text-link ml-auto min-h-11 text-base">全部風險 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
        </div>
        <AlertList
          embedded
          compact
          :max-items="1"
          :alerts="alerts"
          :stations="stations"
          :context-query="contextQuery"
          @select="emit('select', $event)"
          @acknowledge="emit('acknowledge', $event)"
        />
      </section>
    </div>

    <p class="m-0 flex items-start gap-2 border-t border-line bg-panel-muted p-4 text-base font-semibold leading-6 text-muted"><Icon class="mt-1 shrink-0 text-lg text-warning" icon="solar:shield-warning-outline" /> 建議用於排序與覆核，不會直接派遣真實車隊。</p>
  </section>
</template>
