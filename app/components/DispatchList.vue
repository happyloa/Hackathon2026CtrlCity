<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DispatchRecommendation, StationRisk } from '~/shared/ops'

const props = defineProps<{
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  compact?: boolean
}>()

const emit = defineEmits<{ accept: [dispatchId: string]; select: [stationId: string] }>()

const stationLookup = computed(() => new Map(props.stations.map(station => [station.id, station])))
const visibleDispatches = computed(() => props.compact ? props.dispatches.slice(0, 4) : props.dispatches)
const nameFor = (id: string) => stationLookup.value.get(id)?.name || '未命名站點'
const expandedDispatchId = ref<string | null>(null)

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
  <section class="panel dispatch-panel">
    <div class="panel-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:routing-2-outline" /> 調度建議</p>
        <h2>先處理這些搬運任務</h2>
      </div>
      <NuxtLink v-if="compact" to="/dispatch" class="text-link">調度工作台 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </div>

    <div v-if="visibleDispatches.length" class="dispatch-list">
      <article v-for="dispatch in visibleDispatches" :key="dispatch.id" class="dispatch-item">
        <div class="dispatch-row">
          <div class="dispatch-route">
            <button type="button" @click="emit('select', dispatch.fromStationId)">{{ nameFor(dispatch.fromStationId) }}</button>
            <span><Icon icon="solar:arrow-right-outline" /></span>
            <button type="button" @click="emit('select', dispatch.toStationId)">{{ nameFor(dispatch.toStationId) }}</button>
          </div>
          <div class="dispatch-meta">
            <span><b>{{ dispatch.bikeCount }}</b> 台</span>
            <small>{{ dispatch.distanceKm.toFixed(1) }} km · 優先 {{ Math.round(dispatch.priorityScore) }}</small>
          </div>
          <button
            type="button"
            class="assign-button"
            :class="{ assigned: dispatch.status !== 'proposed' }"
            :disabled="dispatch.status !== 'proposed'"
            @click="emit('accept', dispatch.id)"
          >
            {{ dispatch.status === 'proposed' ? '指派任務' : '已指派' }}
          </button>
        </div>
        <button type="button" class="impact-toggle" :aria-expanded="expandedDispatchId === dispatch.id" @click="toggleImpact(dispatch.id)">
          <Icon icon="solar:calculator-minimalistic-outline" />
          {{ expandedDispatchId === dispatch.id ? '收合調度影響試算' : '查看調度影響試算' }}
          <Icon :icon="expandedDispatchId === dispatch.id ? 'solar:alt-arrow-up-outline' : 'solar:alt-arrow-down-outline'" />
        </button>
        <section v-if="expandedDispatchId === dispatch.id && impactFor(dispatch)" class="dispatch-impact" aria-label="調度影響試算">
          <p class="impact-notice"><Icon icon="solar:shield-warning-outline" /> 模擬結果，不改寫預測；指派前仍需人工覆核。</p>
          <div class="impact-grid">
            <div class="impact-station">
              <p><span>取車站</span>{{ impactFor(dispatch)?.from.name }}</p>
              <dl>
                <div><dt>可借車</dt><dd>{{ impactFor(dispatch)?.from.availableBikes }} <b>→</b> <strong>{{ impactFor(dispatch)?.fromAfterBikes }}</strong></dd></div>
                <div><dt>可還位</dt><dd>{{ impactFor(dispatch)?.from.availableDocks }} <b>→</b> <strong>{{ impactFor(dispatch)?.fromAfterDocks }}</strong></dd></div>
              </dl>
              <small :class="{ safe: impactFor(dispatch)?.donorSafe, unsafe: !impactFor(dispatch)?.donorSafe }"><Icon :icon="impactFor(dispatch)?.donorSafe ? 'solar:check-circle-outline' : 'solar:danger-triangle-outline'" /> 調出後安全庫存：{{ impactFor(dispatch)?.donorSafetyStock }} 台</small>
            </div>
            <div class="impact-arrow"><Icon icon="solar:round-arrow-right-outline" /><span>搬運 {{ impactFor(dispatch)?.movableBikes }} 台</span></div>
            <div class="impact-station">
              <p><span>送達站</span>{{ impactFor(dispatch)?.to.name }}</p>
              <dl>
                <div><dt>可借車</dt><dd>{{ impactFor(dispatch)?.to.availableBikes }} <b>→</b> <strong>{{ impactFor(dispatch)?.toAfterBikes }}</strong></dd></div>
                <div><dt>可還位</dt><dd>{{ impactFor(dispatch)?.to.availableDocks }} <b>→</b> <strong>{{ impactFor(dispatch)?.toAfterDocks }}</strong></dd></div>
              </dl>
              <small :class="{ safe: impactFor(dispatch)?.receiverSafe, unsafe: !impactFor(dispatch)?.receiverSafe }"><Icon :icon="impactFor(dispatch)?.receiverSafe ? 'solar:check-circle-outline' : 'solar:danger-triangle-outline'" /> 調度後保留可還位：{{ impactFor(dispatch)?.receiverDockBuffer }} 位</small>
            </div>
          </div>
        </section>
      </article>
    </div>
    <div v-else class="empty-state"><Icon icon="solar:check-circle-outline" />目前沒有可行的搬運建議。</div>
  </section>
</template>

<style scoped>
.dispatch-item + .dispatch-item { border-top: 1px solid var(--line); }
.impact-toggle { display: inline-flex; align-items: center; gap: 5px; margin: 0 16px 11px; padding: 5px 0; color: var(--teal-dark); background: transparent; border: 0; font: inherit; font-size: 16px; font-weight: 800; cursor: pointer; }
.impact-toggle:hover, .impact-toggle:focus-visible { color: var(--ink); text-decoration: underline; outline: 0; }
.impact-toggle:focus-visible { text-decoration-thickness: 2px; text-underline-offset: 4px; }
.impact-toggle svg { font-size: 18px; }
.dispatch-impact { margin: 0 16px 14px; padding: 12px; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; }
.impact-notice { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; color: var(--muted); font-size: 16px; font-weight: 700; }
.impact-notice svg { flex: 0 0 auto; color: var(--orange); font-size: 19px; }
.impact-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: stretch; }
.impact-station { padding: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.impact-station > p { display: grid; gap: 2px; margin: 0 0 8px; color: var(--ink); font-size: 16px; font-weight: 800; }
.impact-station > p span { color: var(--muted); font-size: 16px; font-weight: 700; }
.impact-station dl { display: grid; gap: 4px; margin: 0; }
.impact-station dl div { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 16px; }
.impact-station dt, .impact-station dd { margin: 0; }
.impact-station dd { color: var(--ink); font-family: 'DM Mono', monospace; font-weight: 700; }
.impact-station dd b { color: var(--muted); padding: 0 2px; }
.impact-station dd strong { color: var(--teal-dark); }
.impact-station small { display: flex; align-items: center; gap: 4px; margin-top: 9px; color: var(--muted); font-size: 16px; font-weight: 700; }
.impact-station small.safe { color: #167468; }.impact-station small.unsafe { color: #a84c3f; }
.impact-station small svg { font-size: 18px; }
.impact-arrow { display: grid; place-content: center; gap: 3px; min-width: 76px; color: var(--teal-dark); text-align: center; font-size: 16px; font-weight: 800; }
.impact-arrow svg { justify-self: center; font-size: 24px; }

:global(html[data-theme='dark'] .dispatch-impact) { background: #0b1d25; border-color: #49666c; }
:global(html[data-theme='dark'] .impact-station) { background: #10252e; border-color: #42636a; }
:global(html[data-theme='dark'] .impact-station > p), :global(html[data-theme='dark'] .impact-station dd) { color: #effbf8; }
:global(html[data-theme='dark'] .impact-station dd strong), :global(html[data-theme='dark'] .impact-toggle), :global(html[data-theme='dark'] .impact-arrow) { color: #8ff0df; }
:global(html[data-theme='dark'] .impact-station small.safe) { color: #9debdc; }:global(html[data-theme='dark'] .impact-station small.unsafe) { color: #ffb7ae; }

@media (max-width: 780px) { .impact-grid { grid-template-columns: 1fr; }.impact-arrow { grid-template-columns: auto 1fr; place-content: start; align-items: center; min-width: 0; text-align: left; }.impact-arrow svg { justify-self: start; transform: rotate(90deg); } }
</style>
