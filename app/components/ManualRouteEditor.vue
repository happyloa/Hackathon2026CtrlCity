<script setup lang="ts">
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, Clock, Plus, Route as RouteIcon, Trash2, TriangleAlert, Truck, X } from '@lucide/vue'
import { horizonBucketFor, minutesUntilScheduledTime, recomputeManualRoute } from '~/shared/manual-route-planner'
import { displayStationName, type StationRisk } from '~/shared/ops'

const props = defineProps<{ stations: StationRisk[]; asOf: string }>()
const emit = defineEmits<{ select: [stationId: string] }>()

const {
  routes,
  activeRouteId,
  editorExpanded: expanded,
  focusRoute,
  createRoute,
  removeRoute,
  renameRoute,
  setVehicleCapacity,
  setScheduledAt,
  addStop,
  removeStop,
  updateStop,
  moveStop,
} = useManualRoutes()

const addStationId = ref('')
const editorContentId = useId()

const HORIZON_LABEL: Record<string, string> = { now: '目前', '30': '30 分鐘預測', '60': '60 分鐘預測' }

const stationOptions = computed(() => [...props.stations]
  .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hant'))
  .map(station => ({ value: station.id, label: `${displayStationName(station.name)}（${station.district || '行政區未標示'}）` })))

const plans = computed(() => new Map(routes.value.map((route) => {
  const horizon = horizonBucketFor(minutesUntilScheduledTime(route.scheduledAt, props.asOf))
  return [route.id, recomputeManualRoute(route, props.stations, horizon)]
})))
const activeRoute = computed(() => routes.value.find(route => route.id === activeRouteId.value) ?? routes.value[0] ?? null)
const activePlan = computed(() => (activeRoute.value ? plans.value.get(activeRoute.value.id) ?? null : null))

watch(routes, (items) => {
  if (!items.some(route => route.id === activeRouteId.value)) activeRouteId.value = items[0]?.id ?? ''
}, { immediate: true })

function selectRoute(routeId: string) {
  focusRoute(routeId)
}

function handleCreateRoute() {
  const route = createRoute()
  focusRoute(route.id)
}

function handleAddStation(stationId: string) {
  if (!activeRoute.value || !stationId) return
  addStop(activeRoute.value.id, stationId)
  addStationId.value = ''
}

function loadPercent(load: number, capacity: number) {
  return Math.min(100, Math.max(0, load / Math.max(1, capacity) * 100))
}
</script>

<template>
  <section id="manual-route-editor" class="manual-panel" :class="{ 'has-issues': activePlan && !activePlan.feasible }" aria-label="手動調度路線">
    <button class="manual-trigger" type="button" :aria-expanded="expanded" :aria-controls="editorContentId" @click="expanded = !expanded">
      <span class="manual-symbol"><RouteIcon style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /></span>
      <span class="manual-heading">手動調度路線<small>自行新增／編輯站點與取卸車數量，即時重算車載與預測庫存</small></span>
      <span class="manual-figures"><strong>{{ routes.length }}</strong> 條</span>
      <span class="manual-action">{{ expanded ? '收合' : '編輯路線' }}<ChevronDown style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" :class="{ 'is-expanded': expanded }" /></span>
    </button>

    <div v-if="expanded" :id="editorContentId" class="manual-content">
      <div class="manual-route-tabs" role="group" aria-label="選擇手動路線">
        <button v-for="route in routes" :key="route.id" type="button" class="manual-route-tab"
          :class="{ 'is-active': activeRoute?.id === route.id, 'is-warning': !plans.get(route.id)?.feasible }"
          :aria-pressed="activeRoute?.id === route.id" @click="selectRoute(route.id)">
          <TriangleAlert v-if="!plans.get(route.id)?.feasible" :size="13" aria-hidden="true" />
          {{ route.label }}<b>{{ route.scheduledAt }} · {{ route.stops.length }} 站</b>
        </button>
        <button type="button" class="manual-route-add" @click="handleCreateRoute"><Plus :size="15" aria-hidden="true" />新增路線</button>
      </div>

      <div v-if="!activeRoute" class="manual-empty">
        <RouteIcon :size="26" aria-hidden="true" />
        <p>尚未建立手動路線，點「新增路線」開始安排。</p>
      </div>

      <fieldset v-else-if="activePlan" class="manual-editor">
        <div class="manual-route-header">
          <input class="manual-route-label" type="text" :value="activeRoute.label"
            aria-label="路線名稱" @change="renameRoute(activeRoute.id, ($event.target as HTMLInputElement).value)" />
          <label class="manual-capacity"><span>車輛容量</span><input type="number" min="1" :value="activeRoute.vehicleCapacity"
            @change="setVehicleCapacity(activeRoute.id, Number(($event.target as HTMLInputElement).value))" /><span>台</span></label>
          <label class="manual-schedule"><Clock :size="14" aria-hidden="true" /><span>預計執行</span><input type="time" :value="activeRoute.scheduledAt"
            @change="setScheduledAt(activeRoute.id, ($event.target as HTMLInputElement).value)" /></label>
          <button type="button" class="manual-delete-route" @click="removeRoute(activeRoute.id)"><Trash2 :size="15" aria-hidden="true" />刪除路線</button>
        </div>
        <p class="manual-horizon-note"><Clock :size="13" aria-hidden="true" />依預計執行時間，以{{ HORIZON_LABEL[activePlan.horizon] }}庫存估算；同一時段以內的其他手動路線效果也已從自動建議路線扣除。</p>

        <dl class="manual-metrics">
          <div><dt>搬運數量</dt><dd>{{ activePlan.totalTransferBikes }}<small>台</small></dd></div>
          <div><dt>停靠站點</dt><dd>{{ activePlan.stops.length }}<small>站</small></dd></div>
          <div><dt>站間估距</dt><dd>{{ activePlan.totalDistanceKm.toFixed(1) }}<small>km</small></dd></div>
        </dl>
        <div class="manual-capacity-track-wrap">
          <p><span><Truck :size="14" aria-hidden="true" />最高車載</span><strong>{{ activePlan.peakVehicleLoad }} / {{ activePlan.vehicleCapacity }} 台</strong></p>
          <div class="manual-capacity-track" role="progressbar" :aria-valuenow="activePlan.peakVehicleLoad" aria-valuemin="0" :aria-valuemax="activePlan.vehicleCapacity">
            <span :style="{ width: `${loadPercent(activePlan.peakVehicleLoad, activePlan.vehicleCapacity)}%` }" />
          </div>
        </div>

        <p v-if="!activePlan.feasible" class="manual-route-warning" role="alert"><TriangleAlert :size="15" aria-hidden="true" />此路線目前不可行：{{ activePlan.issues[0] }}<template v-if="activePlan.issues.length > 1">（另有 {{ activePlan.issues.length - 1 }} 項問題，詳見各停靠站）</template></p>
        <p v-else-if="activePlan.stops.length" class="manual-route-ok"><CheckCircle2 :size="15" aria-hidden="true" />路線可行，車輛已在終點歸零。</p>

        <ol class="manual-stops">
          <li v-for="(stop, index) in activePlan.stops" :key="stop.stopId" class="manual-stop" :class="{ 'is-warning': stop.issues.length }">
            <span class="manual-stop-sequence">{{ stop.sequence }}</span>
            <div class="manual-stop-body">
              <button type="button" class="manual-stop-name" @click="emit('select', stop.stationId)">
                <strong>{{ stop.stationName }}</strong>
                <span>{{ stop.district || '行政區未標示' }}<template v-if="index > 0"> · 距上站約 {{ stop.distanceFromPreviousKm.toFixed(1) }} km</template></span>
              </button>
              <div class="manual-stop-inputs">
                <label>取車<input type="number" min="0" :value="stop.pickupBikes"
                  @change="updateStop(activeRoute.id, stop.stopId, { pickupBikes: Number(($event.target as HTMLInputElement).value) })" /><span>台</span></label>
                <label>卸車<input type="number" min="0" :value="stop.dropoffBikes"
                  @change="updateStop(activeRoute.id, stop.stopId, { dropoffBikes: Number(($event.target as HTMLInputElement).value) })" /><span>台</span></label>
              </div>
              <p class="manual-stop-predicted">
                <span>車載 <b>{{ stop.vehicleLoadAfter }}</b></span>
                <span v-if="stop.predictedBikesAfter !== null">預測可借車 <b>{{ stop.predictedBikesAfter }}</b></span>
                <span v-if="stop.predictedDocksAfter !== null">預測可還位 <b>{{ stop.predictedDocksAfter }}</b></span>
              </p>
              <p v-for="issue in stop.issues" :key="issue" class="manual-stop-issue"><TriangleAlert :size="13" aria-hidden="true" />{{ issue }}</p>
            </div>
            <div class="manual-stop-actions">
              <button type="button" aria-label="上移此站" :disabled="index === 0" @click="moveStop(activeRoute.id, stop.stopId, -1)"><ArrowUp :size="15" aria-hidden="true" /></button>
              <button type="button" aria-label="下移此站" :disabled="index === activePlan.stops.length - 1" @click="moveStop(activeRoute.id, stop.stopId, 1)"><ArrowDown :size="15" aria-hidden="true" /></button>
              <button type="button" aria-label="移除此站" class="manual-stop-remove" @click="removeStop(activeRoute.id, stop.stopId)"><X :size="15" aria-hidden="true" /></button>
            </div>
          </li>
        </ol>

        <div class="manual-add-stop">
          <ModalPicker v-model="addStationId" label="新增停靠站" title="選擇要新增的站點" :options="stationOptions" @update:model-value="handleAddStation" />
        </div>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.manual-panel { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 9px; background: var(--panel); overflow: hidden; }
.manual-panel.has-issues { border-left-color: var(--warning); }
.manual-trigger { display: flex; align-items: center; gap: 14px; padding: 11px 16px; width: 100%; text-align: left; }
.manual-trigger:hover { background: color-mix(in srgb, var(--accent) 4%, transparent); }
.manual-symbol { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 8px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); font-size: var(--icon-md); }
.manual-heading { font-size: var(--type-body1); font-weight: 650; }
.manual-heading small { display: block; font-size: var(--type-body2); font-weight: 400; color: var(--muted); margin-top: 2px; }
.manual-figures { margin-left: 18px; color: var(--muted); font-size: var(--type-body2); }
.manual-figures strong { margin-right: 4px; font-size: var(--type-h6); color: var(--ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.manual-action { display: inline-flex; align-items: center; justify-content: end; gap: 9px; margin-left: auto; font-size: var(--type-body2); font-weight: 550; white-space: nowrap; }
.manual-action svg { transition: transform .15s; }
.is-expanded { transform: rotate(180deg); }
.manual-content { background: var(--panel); border-top: 1px solid var(--line); padding: 14px 16px 18px; display: grid; gap: 14px; }
.manual-route-tabs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.manual-route-tab { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 11px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-size: var(--type-body2); font-weight: 550; }
.manual-route-tab b { font-weight: 400; margin-left: 4px; }
.manual-route-tab.is-active { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.manual-route-tab.is-warning:not(.is-active) { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 40%, var(--line)); }
.manual-route-add { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 11px; border: 1px dashed var(--line-strong); border-radius: 6px; color: var(--accent); font-size: var(--type-body2); font-weight: 550; }
.manual-route-add:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.manual-empty { display: grid; justify-items: center; gap: 8px; padding: 28px 16px; color: var(--muted); text-align: center; }
.manual-editor { display: grid; gap: 12px; }
.manual-route-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.manual-route-label { flex: 1; min-width: 160px; min-height: 40px; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--canvas); font-size: var(--type-body1); font-weight: 650; color: var(--ink); }
.manual-capacity { display: flex; align-items: center; gap: 6px; font-size: var(--type-body2); color: var(--muted); }
.manual-capacity input { width: 56px; min-height: 40px; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--canvas); color: var(--ink); font-variant-numeric: tabular-nums; }
.manual-schedule { display: flex; align-items: center; gap: 6px; font-size: var(--type-body2); color: var(--muted); }
.manual-schedule input { min-height: 40px; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--canvas); color: var(--ink); font-variant-numeric: tabular-nums; }
.manual-horizon-note { display: flex; align-items: start; gap: 6px; margin: 0; color: var(--muted); font-size: var(--type-body2); }
.manual-delete-route { display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 6px; color: var(--danger); font-size: var(--type-body2); }
.manual-delete-route:hover { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 6%, transparent); }
.manual-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.manual-metrics > div + div { border-left: 1px solid var(--line); padding-left: 14px; }
.manual-metrics dt { color: var(--muted); font-size: var(--type-body2); margin-bottom: 4px; }
.manual-metrics dd { margin: 0; font-size: var(--type-h6); font-weight: 600; font-variant-numeric: tabular-nums; }
.manual-metrics dd small { margin-left: 4px; color: var(--muted); font-size: var(--type-body2); font-weight: 400; }
.manual-capacity-track-wrap p { display: flex; justify-content: space-between; gap: 12px; margin: 0 0 6px; color: var(--muted); font-size: var(--type-body2); }
.manual-capacity-track-wrap p span { display: inline-flex; align-items: center; gap: 6px; }
.manual-capacity-track-wrap strong { color: var(--ink); font-weight: 550; font-variant-numeric: tabular-nums; }
.manual-capacity-track { height: 5px; border-radius: 10px; background: var(--panel-muted); overflow: hidden; }
.manual-capacity-track > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.manual-route-warning, .manual-route-ok { display: flex; align-items: start; gap: 7px; padding: 10px 12px; border-radius: 7px; font-size: var(--type-body2); }
.manual-route-warning { color: var(--warning); background: color-mix(in srgb, var(--warning) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warning) 30%, var(--line)); }
.manual-route-ok { color: var(--positive); background: color-mix(in srgb, var(--positive) 8%, transparent); border: 1px solid color-mix(in srgb, var(--positive) 30%, var(--line)); }
.manual-stops { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.manual-stop { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: color-mix(in srgb, var(--panel-muted) 15%, var(--panel)); }
.manual-stop.is-warning { border-color: color-mix(in srgb, var(--warning) 40%, var(--line)); }
.manual-stop-sequence { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--panel-muted); color: var(--muted); font-size: var(--type-body2); font-weight: 650; }
.manual-stop-body { min-width: 0; display: grid; gap: 6px; }
.manual-stop-name { text-align: left; min-width: 0; }
.manual-stop-name strong { display: block; font-size: var(--type-body2); font-weight: 600; overflow-wrap: anywhere; }
.manual-stop-name:hover strong { text-decoration: underline; text-underline-offset: 3px; }
.manual-stop-name span { display: block; color: var(--muted); font-size: var(--type-body2); margin-top: 2px; }
.manual-stop-inputs { display: flex; flex-wrap: wrap; gap: 14px; }
.manual-stop-inputs label { display: flex; align-items: center; gap: 6px; font-size: var(--type-body2); color: var(--muted); }
.manual-stop-inputs input { width: 64px; min-height: 36px; padding: 5px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--canvas); color: var(--ink); font-variant-numeric: tabular-nums; }
.manual-stop-predicted { display: flex; flex-wrap: wrap; gap: 12px; margin: 0; color: var(--muted); font-size: var(--type-body2); }
.manual-stop-predicted b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.manual-stop-issue { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--warning); font-size: var(--type-body2); }
.manual-stop-actions { display: flex; flex-direction: column; gap: 4px; }
.manual-stop-actions button { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); }
.manual-stop-actions button:hover:not(:disabled) { border-color: var(--accent); color: var(--ink); }
.manual-stop-actions button:disabled { opacity: .35; }
.manual-stop-remove:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
.manual-add-stop { max-width: 360px; }
@media (max-width: 640px) { .manual-stop { grid-template-columns: 22px minmax(0, 1fr); } .manual-stop-actions { grid-column: 1 / -1; flex-direction: row; justify-content: flex-end; } }
</style>
