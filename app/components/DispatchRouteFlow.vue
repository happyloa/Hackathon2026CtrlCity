<script setup lang="ts">
import { ArrowUpRight, MapPin, Navigation, Pencil, Route } from '@lucide/vue'
import type { DispatchRoutePlan, DispatchRouteStopAction } from '~/shared/dispatch-route-planner'
import type { StationRisk } from '~/shared/ops'

const props = defineProps<{
  route: DispatchRoutePlan
  routeNumber: number
  selectedSequence: number | null
  stations: StationRisk[]
  isManual?: boolean
  labelOverride?: string
}>()

const emit = defineEmits<{
  selectStop: [sequence: number]
  inspectStation: [stationId: string]
  editRoute: []
}>()

const timelineElement = ref<HTMLElement | null>(null)
const headingId = useId()
const routeLabel = computed(() => props.labelOverride || `路線 ${String(props.routeNumber).padStart(2, '0')}`)
const routeShape = computed(() => JSON.stringify(props.route.stops.map(stop => [stop.stationId, stop.action])))

/**
 * Google's key-free "Maps URLs" directions format (`/maps/dir/?api=1`), not
 * the paid Directions API -- this only ever opens Google Maps with the same
 * stop order already planned here, so a dispatcher can hand the route to a
 * driver without re-typing every stop. `dir_action=navigate` skips the route
 * preview and drops straight into turn-by-turn on the Google Maps mobile app;
 * desktop just opens the normal directions page.
 */
const googleMapsUrl = computed(() => {
  const stationById = new Map(props.stations.map(station => [station.id, station]))
  const coordinates = props.route.stops
    .map(stop => stationById.get(stop.stationId))
    .filter((station): station is StationRisk => station !== undefined
      && Number.isFinite(station.latitude) && Number.isFinite(station.longitude))
    .map(station => `${station.latitude},${station.longitude}`)
  if (coordinates.length < 2) return null

  const params = new URLSearchParams({
    api: '1',
    origin: coordinates[0]!,
    destination: coordinates[coordinates.length - 1]!,
    travelmode: 'driving',
    dir_action: 'navigate',
  })
  const waypoints = coordinates.slice(1, -1)
  if (waypoints.length) params.set('waypoints', waypoints.join('|'))
  return `https://www.google.com/maps/dir/?${params.toString()}`
})

function loadPercent(load: number) {
  return Math.min(100, Math.max(0, load / Math.max(1, props.route.vehicleCapacity) * 100))
}

function actionLabel(action: DispatchRouteStopAction) {
  return { pickup: '取車', dropoff: '卸車', mixed: '取車與卸車' }[action]
}

function stopPinColor(stop: DispatchRoutePlan['stops'][number]) {
  if (stop.sequence === 1) return '#3ecf8e'
  if (stop.action === 'pickup') return '#7dd3fc'
  return '#ff6f61'
}

// Keep map-driven selection visible without moving the page or its map.
async function revealSelectedStop(resetScroll = false) {
  await nextTick()
  const container = timelineElement.value
  if (!container) return
  if (resetScroll) container.scrollTop = 0
  if (props.selectedSequence === null) return
  const row = container.querySelector<HTMLElement>(`[data-stop-sequence="${props.selectedSequence}"]`)
  if (!row) return
  const containerBounds = container.getBoundingClientRect()
  const rowBounds = row.getBoundingClientRect()
  const padding = 16
  let top = container.scrollTop
  if (rowBounds.top < containerBounds.top + padding) {
    top += rowBounds.top - containerBounds.top - padding
  } else if (rowBounds.bottom > containerBounds.bottom - padding) {
    top += rowBounds.bottom - containerBounds.bottom + padding
  } else {
    return
  }
  container.scrollTo({ top, behavior: 'auto' })
}

watch(() => props.selectedSequence, () => { void revealSelectedStop() })
watch(routeShape, () => { void revealSelectedStop(true) })
onMounted(() => { void revealSelectedStop() })
</script>

<template>
  <section class="dispatch-flow" :aria-labelledby="headingId">
    <header class="flow-header">
      <div class="flow-title-row">
        <div>
          <p class="flow-eyebrow"><Route :size="15" :stroke-width="2" aria-hidden="true" />停靠順序{{ isManual ? '（手動）' : '' }}</p>
          <h2 :id="headingId">{{ routeLabel }}</h2>
        </div>
        <span v-if="isManual" class="flow-priority"><button type="button" class="flow-edit-button" @click="emit('editRoute')"><Pencil :size="13" aria-hidden="true" />在下方編輯</button></span>
        <span v-else class="flow-priority">優先分數 <strong>{{ Math.round(route.highestPriorityScore) }}</strong><button type="button" class="flow-edit-button" @click="emit('editRoute')"><Pencil :size="13" aria-hidden="true" />建立可編輯版本</button></span>
      </div>

      <dl class="flow-metrics">
        <div><dt>搬運數量</dt><dd>{{ route.totalTransferBikes }}<small>台</small></dd></div>
        <div><dt>停靠站點</dt><dd>{{ route.stops.length }}<small>站</small></dd></div>
        <div><dt>站間估距</dt><dd>{{ route.totalDistanceKm.toFixed(1) }}<small>km</small></dd></div>
      </dl>

      <div class="flow-capacity">
        <p><span>最高車載</span><strong>{{ route.peakVehicleLoad }} <span>/ {{ route.vehicleCapacity }} 台</span></strong></p>
        <div class="flow-capacity-track" role="progressbar" aria-label="本路線最高車載" :aria-valuenow="route.peakVehicleLoad" :aria-valuemin="0" :aria-valuemax="route.vehicleCapacity">
          <span :style="{ width: `${loadPercent(route.peakVehicleLoad)}%` }" />
        </div>
      </div>
    </header>

    <div class="flow-instruction">
      <span><MapPin :size="14" :stroke-width="2" aria-hidden="true" />點選站點，在地圖定位</span>
      <a v-if="googleMapsUrl" class="flow-export-link" :href="googleMapsUrl" target="_blank" rel="noopener" :aria-label="`在 Google 地圖開啟${routeLabel}的導航路線`">
        <Navigation :size="13" :stroke-width="2" aria-hidden="true" />Google 導航
      </a>
    </div>

    <div ref="timelineElement" class="flow-scroll" tabindex="0" :aria-label="`${routeLabel}停靠站點清單`">
      <ol class="flow-stops">
        <li v-for="(stop, stopIndex) in route.stops" :key="`${stop.stationId}:${stop.sequence}`"
          class="flow-stop" :class="[`flow-stop--${stop.action}`, { 'is-selected': selectedSequence === stop.sequence }]"
          :data-stop-sequence="stop.sequence" :aria-current="selectedSequence === stop.sequence ? 'step' : undefined">
          <span class="flow-marker relative" aria-hidden="true">
            <MapPin class="map-route-stop-pin" :style="{ color: stopPinColor(stop) }" :size="42"
              :stroke-width="1.75" />
            <span class="map-route-stop-number absolute grid place-items-center rounded-full font-mono font-bold text-black"
              :style="{ backgroundColor: stopPinColor(stop) }">{{ stop.sequence }}</span>
          </span>
          <div class="flow-stop-card">
            <button type="button" class="flow-stop-select" :aria-pressed="selectedSequence === stop.sequence"
              :aria-label="`定位第 ${stop.sequence} 站：${stop.stationName}，取車 ${stop.pickupBikes} 台、卸車 ${stop.dropoffBikes} 台，車載 ${stop.vehicleLoadAfter} 台`"
              @click="emit('selectStop', stop.sequence)">
              <span class="flow-stop-topline">
                <span class="flow-action">
                  <span class="flow-action-icons" aria-hidden="true">
                    <img v-if="stop.action !== 'pickup'" src="/animations/dropoff.svg" alt="" width="15" height="20" class="shrink-0" />
                    <img v-if="stop.action !== 'dropoff'" src="/animations/pickup.svg" alt="" width="15" height="20" class="shrink-0" />
                  </span>{{ actionLabel(stop.action) }}
                </span>
                <span v-if="stopIndex === 0" class="flow-endpoint">起點</span>
                <span v-else-if="stopIndex === route.stops.length - 1" class="flow-endpoint">終點</span>
                <span v-if="selectedSequence === stop.sequence" class="flow-selected-label">已選取</span>
              </span>
              <strong class="flow-station-name">{{ stop.stationName }}</strong>
              <span class="flow-station-context">{{ stop.district || '新北市' }}<template v-if="stopIndex > 0"> · 距上站約 {{ stop.distanceFromPreviousKm.toFixed(1) }} km</template></span>

              <span class="flow-stop-bottomline">
                <span class="flow-quantities">
                  <span v-if="stop.pickupBikes > 0" class="flow-quantity-pickup">取 <b>{{ stop.pickupBikes }}</b> 台</span>
                  <span v-if="stop.dropoffBikes > 0" class="flow-quantity-dropoff">卸 <b>{{ stop.dropoffBikes }}</b> 台</span>
                </span>
                <span class="flow-load">車載 <b>{{ stop.vehicleLoadAfter }}</b> / {{ route.vehicleCapacity }}</span>
              </span>
              <span class="flow-stop-load-track" aria-hidden="true"><span :style="{ width: `${loadPercent(stop.vehicleLoadAfter)}%` }" /></span>
            </button>
            <button v-if="selectedSequence === stop.sequence" type="button" class="flow-inspect"
              :aria-label="`查看${stop.stationName}站點資料`" @click="emit('inspectStation', stop.stationId)">
              <MapPin :size="15" :stroke-width="2" aria-hidden="true" />查看站點資料<ArrowUpRight :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ol>
    </div>
    <footer class="flow-footer">{{ route.taskCount }} 筆搬運需求<span>里程為站點直線估算</span></footer>
  </section>
</template>

<style scoped>
.dispatch-flow {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: var(--dispatch-workspace-height, 720px);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink);
}
.flow-header { flex-shrink: 0; padding: 20px 20px 17px; border-bottom: 1px solid var(--line); }
.flow-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.flow-eyebrow { display: flex; align-items: center; gap: 6px; margin: 0 0 5px; color: var(--muted); font-size: var(--type-body2); }
.flow-title-row h2 { margin: 0; font-size: var(--type-h6); line-height: 1.25; font-weight: 650; letter-spacing: -.025em; }
.flow-priority { display: grid; justify-items: end; gap: 5px; color: var(--muted); font-size: var(--type-body2); }
.flow-priority strong { color: var(--ink); font-size: var(--type-body1); font-weight: 600; font-variant-numeric: tabular-nums; }
.flow-edit-button { display: flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--accent); font-size: var(--type-body2); white-space: nowrap; }
.flow-edit-button:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.flow-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 18px 0 15px; }
.flow-metrics > div + div { border-left: 1px solid var(--line); padding-left: 14px; }
.flow-metrics dt { color: var(--muted); font-size: var(--type-body2); margin-bottom: 4px; }
.flow-metrics dd { margin: 0; font-size: var(--type-h5); line-height: 1.2; font-weight: 600; font-variant-numeric: tabular-nums; }
.flow-metrics dd small { margin-left: 4px; color: var(--muted); font-size: var(--type-body2); font-weight: 400; }
.flow-capacity p { display: flex; justify-content: space-between; gap: 12px; margin: 0 0 6px; color: var(--muted); font-size: var(--type-body2); }
.flow-capacity strong { color: var(--ink); font-weight: 550; font-variant-numeric: tabular-nums; }
.flow-capacity strong span { color: var(--muted); font-weight: 400; }
.flow-capacity-track { height: 5px; border-radius: 10px; background: var(--panel-muted); overflow: hidden; }
.flow-capacity-track > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.flow-instruction { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; padding: 11px 20px 0; color: var(--muted); font-size: var(--type-body2); }
.flow-instruction > span { display: flex; align-items: center; gap: 6px; }
.flow-export-link { display: flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--accent); font-size: var(--type-body2); font-weight: 550; white-space: nowrap; text-decoration: none; }
.flow-export-link:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.flow-scroll { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior-y: contain; padding: 15px 16px 18px; scrollbar-gutter: stable; }
.flow-stops { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.flow-stop { --stop-color: var(--dispatch-mixed, var(--warning)); display: grid; position: relative; grid-template-columns: 42px minmax(0, 1fr); align-items: start; gap: 10px; min-width: 0; }
.flow-stop--pickup { --stop-color: var(--dispatch-pickup, var(--accent)); }
.flow-stop--dropoff { --stop-color: var(--dispatch-dropoff, var(--danger)); }
.flow-stop:not(:last-child)::before { position: absolute; content: ''; width: 2px; top: 40px; bottom: -19px; left: 18px; background: color-mix(in srgb, var(--stop-color) 35%, var(--line)); }
.flow-marker { z-index: 1; display: block; width: 42px; height: 42px; margin-top: 6px; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 60%)); }
.map-route-stop-pin { display: block; width: 38px; height: 38px; }
.map-route-stop-number { z-index: 1; top: 7px; left: calc(50% - 2px); width: 16px; height: 16px; transform: translateX(-50%); font-size: var(--marker-label); line-height: 1; white-space: nowrap; }
.flow-stop-card { min-width: 0; border: 1px solid var(--line); border-radius: 9px; background: color-mix(in srgb, var(--panel-muted) 17%, var(--panel)); overflow: hidden; }
.flow-stop.is-selected .flow-stop-card { border-color: var(--stop-color); box-shadow: inset 3px 0 0 var(--stop-color); background: color-mix(in srgb, var(--stop-color) 6%, var(--panel)); }
.flow-stop-select { display: block; width: 100%; min-height: 44px; padding: 12px; border: 0; text-align: left; background: transparent; color: inherit; cursor: pointer; }
.flow-stop-select:hover { background: color-mix(in srgb, var(--stop-color) 7%, transparent); }
.flow-stop-topline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
.flow-action { display: inline-flex; align-items: center; gap: 5px; color: var(--stop-color); font-size: var(--type-body2); font-weight: 600; }
.flow-action-icons { display: inline-flex; align-items: center; gap: 1px; }
.flow-endpoint { color: var(--muted); font-size: var(--type-body2); border-left: 1px solid var(--line); padding-left: 6px; }
.flow-selected-label { margin-left: auto; color: var(--muted); font-size: var(--type-body2); }
.flow-station-name { display: block; font-size: var(--type-body2); line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
.flow-station-context { display: block; color: var(--muted); font-size: var(--type-body2); line-height: 1.6; margin-top: 2px; }
.flow-stop-bottomline { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
.flow-quantities { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--type-body2); }
.flow-quantities > span { display: inline-flex; gap: 3px; align-items: baseline; padding: 3px 6px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 4px; background: color-mix(in srgb, currentColor 7%, transparent); }
.flow-quantity-pickup { color: var(--dispatch-pickup, var(--accent)); }
.flow-quantity-dropoff { color: var(--dispatch-dropoff, var(--danger)); }
.flow-quantities b { font-size: var(--type-body2); font-weight: 650; font-variant-numeric: tabular-nums; }
.flow-load { color: var(--muted); font-size: var(--type-body2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.flow-load b { color: var(--ink); font-weight: 600; }
.flow-stop-load-track { display: block; height: 3px; overflow: hidden; margin-top: 7px; border-radius: 6px; background: var(--panel-muted); }
.flow-stop-load-track > span { display: block; height: 100%; background: color-mix(in srgb, var(--stop-color) 62%, transparent); border-radius: inherit; }
.flow-inspect { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 44px; padding: 8px 12px; border: 0; border-top: 1px solid color-mix(in srgb, var(--stop-color) 22%, var(--line)); color: var(--muted); background: transparent; font-size: var(--type-body2); font-weight: 500; cursor: pointer; }
.flow-inspect > svg:last-child { margin-left: auto; }
.flow-inspect:hover { color: var(--ink); background: var(--panel-muted); }
.flow-footer { display: flex; flex-shrink: 0; flex-wrap: wrap; justify-content: space-between; gap: 6px; padding: 11px 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: var(--type-body2); }
.flow-stop-select:focus-visible, .flow-inspect:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; border-radius: 6px; }
.flow-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
@media (max-width: 1100px) {
  .dispatch-flow { height: 560px; }
}
@media (max-width: 640px) {
  .dispatch-flow { height: 520px; }
}
@media (max-width: 480px) {
  .flow-header { padding: 17px 16px 14px; }
  .flow-metrics { gap: 8px; }
  .flow-metrics > div + div { padding-left: 10px; }
  .flow-scroll { padding: 14px 12px 16px; }
  .flow-stop { gap: 8px; }
  .flow-stop-select { padding: 11px 10px; }
  .flow-instruction, .flow-footer { padding-left: 16px; padding-right: 16px; }
}
</style>
