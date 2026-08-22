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
  <section class="panel task-queue" aria-labelledby="task-queue-title">
    <header class="task-queue-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:routing-2-outline" /> 調度工作佇列</p>
        <h2 id="task-queue-title">{{ headline }}</h2>
        <p>{{ contextLabel }}</p>
      </div>
      <div class="queue-counts" aria-label="待處理數量">
        <span><b>{{ proposedDispatches }}</b> 任務</span>
        <span><b>{{ openAlerts }}</b> 風險</span>
      </div>
    </header>

    <div class="queue-steps">
      <section class="queue-step" aria-labelledby="dispatch-step-title">
        <div class="step-heading">
          <span>1</span>
          <div>
            <strong id="dispatch-step-title">優先搬運任務</strong>
            <small>檢視影響試算後，由值班人員指派。</small>
          </div>
          <NuxtLink :to="allDispatchesTarget" class="step-link">全部任務 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
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

      <section class="queue-step" aria-labelledby="alert-step-title">
        <div class="step-heading">
          <span>2</span>
          <div>
            <strong id="alert-step-title">待確認風險</strong>
            <small>確認異常或補充現場資訊；完整清單仍可另外查看。</small>
          </div>
          <NuxtLink :to="allAlertsTarget" class="step-link">全部風險 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
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

    <p class="task-queue-note"><Icon icon="solar:shield-warning-outline" /> 建議用於排序與覆核，不會直接派遣真實車隊。</p>
  </section>
</template>

<style scoped>
.task-queue {
  overflow: hidden;
}

.task-queue-heading {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: flex-start;
  padding: 17px 18px 15px;
  border-bottom: 1px solid var(--line);
}

.task-queue-heading h2 {
  margin: 0;
  color: var(--ink);
  font-size: 21px;
  letter-spacing: -.035em;
}

.task-queue-heading > div > p:not(.section-kicker) {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.5;
}

.queue-counts {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.queue-counts span {
  padding: 5px 7px;
  color: var(--muted);
  background: var(--surface-muted);
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
}

.queue-counts b {
  color: var(--teal-dark);
  font-family: "DM Mono", monospace;
}

.queue-steps {
  display: grid;
}

.queue-step + .queue-step {
  border-top: 1px solid var(--line);
}

.step-heading {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 13px 18px 7px;
}

.step-heading > span {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--on-accent);
  background: var(--teal-dark);
  border-radius: 50%;
  font-family: "DM Mono", monospace;
  font-size: 16px;
  font-weight: 800;
}

.step-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  color: var(--teal-dark);
  font-size: 16px;
  font-weight: 800;
  white-space: nowrap;
}

.step-link:hover {
  color: var(--ink);
  text-decoration: underline;
}

.step-link svg {
  font-size: 17px;
}

.step-heading strong,
.step-heading small {
  display: block;
}

.step-heading strong {
  color: var(--ink);
  font-size: 16px;
}

.step-heading small {
  margin-top: 2px;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.4;
}

.task-queue-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 11px 18px;
  color: var(--muted);
  background: var(--surface-muted);
  border-top: 1px solid var(--line);
  font-size: 16px;
  line-height: 1.45;
}

.task-queue-note svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--orange);
  font-size: 18px;
}

:deep(.is-embedded) {
  background: transparent;
  border: 0;
  border-radius: 0;
}

:deep(.is-embedded .dispatch-list),
:deep(.is-embedded .alert-list) {
  padding: 0 18px 13px;
}

:deep(.is-embedded .dispatch-item:last-child),
:deep(.is-embedded .alert-row:last-child) {
  border-bottom: 0;
}

:deep(.is-embedded .impact-toggle) {
  margin-left: 0;
}

:deep(.is-embedded .dispatch-impact) {
  margin-left: 0;
  margin-right: 0;
}

:deep(.is-embedded .empty-state) {
  min-height: 70px;
  padding: 10px 18px 15px;
}

@media (max-width: 620px) {
  .task-queue-heading {
    display: grid;
    gap: 10px;
  }

  .queue-counts {
    justify-content: flex-start;
  }

  .task-queue-heading h2 {
    font-size: 19px;
  }

  .task-queue-heading,
  .step-heading,
  .task-queue-note {
    padding-left: 14px;
    padding-right: 14px;
  }

  .step-heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: 'number title' '. link';
    align-items: start;
  }

  .step-heading > span { grid-area: number; }
  .step-heading > div { grid-area: title; min-width: 0; }
  .step-heading > div small { display: none; }
  .step-link { grid-area: link; min-height: 44px; margin: 2px 0 -6px; }

  :deep(.is-embedded .dispatch-list),
  :deep(.is-embedded .alert-list) {
    padding-left: 14px;
    padding-right: 14px;
  }
}

</style>
