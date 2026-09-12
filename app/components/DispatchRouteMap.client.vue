<script setup lang="ts">
import { Info, LoaderCircle, LocateFixed, MapPin, MapPinned, Minus, Plus, RefreshCw, TriangleAlert } from '@lucide/vue'
import type { DispatchRoutePlan, DispatchRouteStop, DispatchRouteStopAction } from '~/shared/dispatch-route-planner'
import type { StationRisk } from '~/shared/ops'

const props = defineProps<{
  route: DispatchRoutePlan
  stations: StationRisk[]
  selectedSequence: number | null
  routeNumber: number
}>()

const emit = defineEmits<{ selectStop: [sequence: number] }>()

type LeafletModule = typeof import('leaflet')
type Coordinate = [number, number]
interface MappedStop {
  stop: DispatchRouteStop
  coordinate: Coordinate
}

const mapElement = ref<HTMLElement | null>(null)
const ready = ref(false)
const initialising = ref(false)
const initialisationError = ref(false)
const tilesLoading = ref(false)
const failedTileCount = ref(0)
const routeLabel = computed(() => `路線 ${String(props.routeNumber).padStart(2, '0')}`)
const stationById = computed(() => new Map(props.stations.map(station => [station.id, station])))
const routePoints = computed<(MappedStop | null)[]>(() => props.route.stops.map(stop => {
  const station = stationById.value.get(stop.stationId)
  const latitude = station?.latitude
  const longitude = station?.longitude
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { stop, coordinate: [latitude, longitude] }
}))
const mappedStops = computed(() => routePoints.value.filter((point): point is MappedStop => point !== null))
const missingCoordinateCount = computed(() => props.route.stops.length - mappedStops.value.length)
const selectedStop = computed(() => props.route.stops.find(stop => stop.sequence === props.selectedSequence) ?? null)

// Live inventory polling must not reset a map that the dispatcher has panned.
// Only a changed route or its coordinates causes a fit; text/action changes
// refresh the markers while preserving the current viewport.
const geometryKey = computed(() => JSON.stringify(
  routePoints.value.map(point => point ? [point.stop.sequence, point.stop.stationId, ...point.coordinate] : null),
))
const markerKey = computed(() => JSON.stringify([
  geometryKey.value,
  props.route.stops.map(stop => [stop.sequence, stop.stationName, stop.action, stop.pickupBikes, stop.dropoffBikes]),
]))

let leaflet: LeafletModule | null = null
let leafletMap: import('leaflet').Map | null = null
let tileLayer: import('leaflet').TileLayer | null = null
let routeLayer: import('leaflet').LayerGroup | null = null
let resizeObserver: ResizeObserver | null = null
let resizeFrame = 0
let disposed = false
let lastGeometryKey = ''
const failedTiles = new Set<HTMLElement>()
const sequenceButtons = new Map<number, HTMLButtonElement>()
const visitMarkers: { marker: import('leaflet').Marker, sequences: number[] }[] = []

function actionLabel(action: DispatchRouteStopAction) {
  return { pickup: '取車', dropoff: '卸車', mixed: '卸車＋取車' }[action]
}

function operationLabel(stop: DispatchRouteStop) {
  return [stop.dropoffBikes > 0 ? `卸 ${stop.dropoffBikes} 台` : '', stop.pickupBikes > 0 ? `取 ${stop.pickupBikes} 台` : '']
    .filter(Boolean).join(' · ')
}

function stopPinColor(stop: DispatchRouteStop) {
  if (stop.sequence === 1) return '#3ecf8e'
  if (stop.action === 'pickup') return '#7dd3fc'
  return '#ff6f61'
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function fitRoute() {
  if (!leaflet || !leafletMap || !mappedStops.value.length) return
  leafletMap.fitBounds(leaflet.latLngBounds(mappedStops.value.map(point => point.coordinate)), {
    paddingTopLeft: [64, 128],
    paddingBottomRight: [64, 54],
    maxZoom: 16,
    animate: false,
  })
}

function updateSelection(pan = true) {
  for (const [sequence, button] of sequenceButtons) {
    const selected = sequence === props.selectedSequence
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-pressed', String(selected))
    button.closest('.dispatch-visit-group')?.classList.toggle('has-selected-visit',
      Boolean(button.parentElement?.querySelector('[aria-pressed="true"]')))
  }
  for (const { marker, sequences } of visitMarkers) {
    marker.setZIndexOffset(props.selectedSequence !== null && sequences.includes(props.selectedSequence) ? 1000 : 0)
  }
  if (!pan || !leafletMap) return
  const point = mappedStops.value.find(entry => entry.stop.sequence === props.selectedSequence)
  if (point) leafletMap.panInside(point.coordinate, {
    paddingTopLeft: [64, 132],
    paddingBottomRight: [64, 54],
    animate: !prefersReducedMotion(),
  })
}

function addDirection(from: Coordinate, to: Coordinate) {
  if (!leaflet || !leafletMap || !routeLayer) return
  const start = leafletMap.project(from, 16)
  const end = leafletMap.project(to, 16)
  if (start.distanceTo(end) < 12) return
  const heading = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI
  // Outbound and return legs get different positions along the same segment,
  // keeping both directions visible when a route revisits a station.
  const position = leafletMap.unproject(start.add(end.subtract(start).multiplyBy(.42)), 16)
  const arrow = document.createElement('span')
  arrow.className = 'dispatch-direction-head'
  arrow.setAttribute('aria-hidden', 'true')
  arrow.style.transform = `rotate(${heading + 45}deg)`
  leaflet.marker(position, {
    icon: leaflet.divIcon({ html: arrow, className: 'dispatch-direction', iconSize: [16, 16], iconAnchor: [8, 8] }),
    interactive: false,
    keyboard: false,
    zIndexOffset: -100,
  }).addTo(routeLayer)
}

function drawRoute() {
  if (!leaflet || !leafletMap || !routeLayer) return
  routeLayer.clearLayers()
  sequenceButtons.clear()
  visitMarkers.length = 0

  for (let index = 1; index < routePoints.value.length; index++) {
    const from = routePoints.value[index - 1]
    const to = routePoints.value[index]
    // Missing coordinates are shown in the notice instead of drawing an
    // invented shortcut across a stop that cannot be placed on the map.
    if (!from || !to) continue
    const segment: Coordinate[] = [from.coordinate, to.coordinate]
    leaflet.polyline(segment, { color: '#102235', weight: 8, opacity: .8, interactive: false }).addTo(routeLayer)
    leaflet.polyline(segment, { color: '#75b7ff', weight: 4, opacity: 1, dashArray: '10 7', interactive: false }).addTo(routeLayer)
    addDirection(from.coordinate, to.coordinate)
  }

  // A station can be visited several times, and separate station IDs may
  // share coordinates. Every visit gets its own labelled button in a single
  // marker so none of these stops is hidden behind another pin.
  const groups = new Map<string, MappedStop[]>()
  for (const point of mappedStops.value) {
    const key = point.coordinate.join(',')
    const group = groups.get(key)
    if (group) group.push(point)
    else groups.set(key, [point])
  }
  for (const group of groups.values()) {
    const first = group[0]!
    const marker = document.createElement('div')
    marker.className = `dispatch-visit-group${group.length > 1 ? ' has-repeat-visits' : ''}`
    marker.setAttribute('role', 'group')
    marker.setAttribute('aria-label', `停靠順序 ${group.map(point => point.stop.sequence).join('、')}`)
    const columns = Math.min(group.length, 4)
    marker.style.gridTemplateColumns = `repeat(${columns}, 44px)`
    for (const { stop } of group) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `dispatch-visit-button visit-${stop.action}`
      button.style.setProperty('--visit-color', stopPinColor(stop))
      button.innerHTML = `<svg class="dispatch-visit-pin" viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg><span class="dispatch-visit-number">${stop.sequence}</span>`
      button.title = `第 ${stop.sequence} 站 · ${stop.stationName} · ${operationLabel(stop)}`
      button.setAttribute('aria-label', button.title)
      button.setAttribute('aria-pressed', 'false')
      button.addEventListener('click', () => emit('selectStop', stop.sequence))
      marker.appendChild(button)
      sequenceButtons.set(stop.sequence, button)
    }
    leaflet.DomEvent.disableClickPropagation(marker)
    leaflet.DomEvent.disableScrollPropagation(marker)
    const width = columns * 44 + 8
    const height = Math.ceil(group.length / columns) * 44 + 8
    const visitMarker = leaflet.marker(first.coordinate, {
      icon: leaflet.divIcon({ html: marker, className: 'dispatch-visit-anchor', iconSize: [width, height], iconAnchor: [width / 2, height / 2] }),
      keyboard: false,
      riseOnHover: true,
    }).addTo(routeLayer)
    visitMarkers.push({ marker: visitMarker, sequences: group.map(point => point.stop.sequence) })
  }

  const geometryChanged = geometryKey.value !== lastGeometryKey
  lastGeometryKey = geometryKey.value
  if (geometryChanged) fitRoute()
  updateSelection(false)
}

function retryTiles() {
  failedTiles.clear()
  failedTileCount.value = 0
  tileLayer?.redraw()
}

function zoomIn() {
  leafletMap?.zoomIn()
}

function zoomOut() {
  leafletMap?.zoomOut()
}

function onTileError(event: import('leaflet').TileErrorEvent) {
  failedTiles.add(event.tile)
  failedTileCount.value = failedTiles.size
}

function onTileComplete(event: import('leaflet').TileEvent) {
  failedTiles.delete(event.tile)
  failedTileCount.value = failedTiles.size
}

function disposeMap() {
  resizeObserver?.disconnect()
  resizeObserver = null
  cancelAnimationFrame(resizeFrame)
  tileLayer?.off()
  leafletMap?.remove()
  leafletMap = null
  tileLayer = null
  routeLayer = null
  sequenceButtons.clear()
  visitMarkers.length = 0
  failedTiles.clear()
  ready.value = false
}

async function initialiseMap() {
  if (initialising.value || leafletMap || !mapElement.value) return
  initialising.value = true
  initialisationError.value = false
  try {
    leaflet = await import('leaflet')
    if (disposed || !mapElement.value) return
    leafletMap = leaflet.map(mapElement.value, {
      attributionControl: false,
      zoomControl: false,
      scrollWheelZoom: false,
      minZoom: 10,
      maxZoom: 18,
    })
    leaflet.control.attribution({ position: 'bottomright', prefix: false }).addTo(leafletMap)
    tileLayer = leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    })
    tileLayer.on('loading', () => { tilesLoading.value = true })
    tileLayer.on('load', () => { tilesLoading.value = false })
    tileLayer.on('tileerror', onTileError)
    tileLayer.on('tileload', onTileComplete)
    tileLayer.on('tileunload', onTileComplete)
    tileLayer.addTo(leafletMap)
    routeLayer = leaflet.layerGroup().addTo(leafletMap)
    // Used only when an otherwise valid route temporarily has no coordinates.
    // The empty-state layer explains why no stops appear.
    leafletMap.setView([25.012, 121.465], 12)
    lastGeometryKey = ''
    drawRoute()
    resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => leafletMap?.invalidateSize({ pan: false }))
    })
    resizeObserver.observe(mapElement.value)
    ready.value = true
  } catch {
    disposeMap()
    initialisationError.value = true
  } finally {
    initialising.value = false
  }
}

watch(markerKey, drawRoute)
watch(() => props.selectedSequence, () => updateSelection())
onMounted(initialiseMap)
onBeforeUnmount(() => {
  disposed = true
  disposeMap()
})
</script>

<template>
  <section class="dispatch-route-map" :aria-label="`${routeLabel} 地圖`">
    <header class="route-map-header">
      <div class="route-map-heading"><MapPinned :size="18" aria-hidden="true" /><h3>{{ routeLabel }} · 地圖</h3></div>
      <button type="button" class="route-map-fit" :disabled="!ready || !mappedStops.length" @click="fitRoute">
        <LocateFixed :size="17" aria-hidden="true" />完整路線
      </button>
    </header>
    <div class="route-map-legend" aria-label="路線圖例">
      <span><i class="legend-pickup" />取車</span>
      <span><i class="legend-dropoff" />卸車</span>
      <span><i class="legend-mixed" />卸車＋取車</span>
      <span class="route-order-hint">數字為停靠順序</span>
    </div>
    <div class="route-map-stage geographic-map">
      <div ref="mapElement" class="route-map-canvas" :aria-label="`${routeLabel} 停靠順序地圖`" />

      <div v-if="selectedStop && ready" class="route-map-selection" :class="`selected-${selectedStop.action}`" aria-live="polite">
        <span class="selection-marker relative shrink-0" aria-hidden="true">
          <MapPin class="map-route-stop-pin" :style="{ color: stopPinColor(selectedStop) }" :size="42"
            :stroke-width="1.75" />
          <span class="map-route-stop-number absolute grid place-items-center rounded-full font-mono font-bold text-black"
            :style="{ backgroundColor: stopPinColor(selectedStop) }">{{ selectedStop.sequence }}</span>
        </span>
        <div><small>第 {{ selectedStop.sequence }} 站 · {{ actionLabel(selectedStop.action) }}</small><strong>{{ selectedStop.stationName }}</strong><span>{{ operationLabel(selectedStop) }}</span></div>
      </div>
      <div v-if="ready" class="route-map-zoom" aria-label="地圖縮放">
        <button type="button" aria-label="放大地圖" @click="zoomIn"><Plus :size="20" aria-hidden="true" /></button>
        <button type="button" aria-label="縮小地圖" @click="zoomOut"><Minus :size="20" aria-hidden="true" /></button>
      </div>
      <div v-if="initialising || initialisationError || (ready && !mappedStops.length)" class="route-map-state" role="status">
        <template v-if="initialising"><LoaderCircle :size="24" class="map-loader" aria-hidden="true" /><p>正在載入路線地圖</p></template>
        <template v-else-if="initialisationError"><TriangleAlert :size="24" aria-hidden="true" /><p>路線地圖暫時無法載入</p><button type="button" @click="initialiseMap"><RefreshCw :size="16" aria-hidden="true" />重新載入</button></template>
        <template v-else><MapPinned :size="24" aria-hidden="true" /><p>這條路線目前沒有可顯示的站點座標</p></template>
      </div>
      <div v-if="ready && failedTileCount" class="route-map-tile-notice" role="status">
        <TriangleAlert :size="16" aria-hidden="true" /><span>部分底圖載入失敗，路線仍可查看。</span>
        <button type="button" @click="retryTiles"><RefreshCw :size="15" aria-hidden="true" />重試</button>
      </div>
      <span v-else-if="ready && tilesLoading" class="route-map-tile-loading" role="status"><LoaderCircle :size="14" class="map-loader" aria-hidden="true" />載入底圖</span>
    </div>
    <footer class="route-map-caption"><Info :size="15" aria-hidden="true" /><span>站點直線連線，非道路導航<span v-if="missingCoordinateCount"> · {{ missingCoordinateCount }} 站缺少座標</span></span></footer>
  </section>
</template>

<style scoped>
.dispatch-route-map {
  --route-pickup: #7dd3fc;
  --route-dropoff: #ff6f61;
  --route-mixed: #f4cc79;
  display: flex;
  flex-direction: column;
  height: var(--dispatch-workspace-height, 720px);
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
}
.route-map-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; }
.route-map-heading { display: flex; align-items: center; gap: 9px; color: var(--accent); }
.route-map-heading h3 { margin: 0; color: var(--ink); font-size: 16px; font-weight: 700; }
.route-map-fit { display: inline-flex; min-height: 38px; align-items: center; justify-content: center; gap: 7px; padding: 7px 11px; border: 1px solid var(--line-strong); border-radius: 7px; color: var(--ink); background: var(--panel); font-size: 12px; font-weight: 600; white-space: nowrap; }
.route-map-fit:hover:not(:disabled) { border-color: var(--accent); background: var(--panel-muted); }
.route-map-fit:disabled { cursor: default; opacity: .45; }
.route-map-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 17px; padding: 0 18px 14px; color: var(--muted); font-size: 12px; }
.route-map-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.route-map-legend i { width: 9px; height: 9px; border: 1px solid #0002; border-radius: 50%; }
.legend-pickup { background: var(--route-pickup); }
.legend-dropoff { background: var(--route-dropoff); }
.legend-mixed { background: var(--route-mixed); }
.route-map-legend .route-order-hint { margin-left: auto; }
.route-map-stage { position: relative; isolation: isolate; flex: 1; min-height: 0; border-block: 1px solid var(--line); background: var(--map); }
.route-map-canvas { position: relative; z-index: 0; width: 100%; height: 100%; }
.route-map-canvas :deep(.leaflet-tile-pane) { filter: brightness(.62) saturate(.46); }
:global([data-theme="light"]) .route-map-canvas :deep(.leaflet-tile-pane) { filter: brightness(.95) saturate(.55); }
.route-map-canvas :deep(.leaflet-control-attribution) { max-width: 100%; font-size: 10px; line-height: 16px; }
.route-map-canvas :deep(.dispatch-visit-anchor), .route-map-canvas :deep(.dispatch-direction) { border: none; background: none; }
.route-map-canvas :deep(.dispatch-visit-group) { display: grid; width: max-content; gap: 0; padding: 4px; border-radius: 30px; }
.route-map-canvas :deep(.dispatch-visit-group.has-repeat-visits) { background: #17212ded; box-shadow: 0 2px 9px #0007; border-radius: 27px; }
.route-map-canvas :deep(.dispatch-visit-button) { position: relative; display: block; width: 42px; height: 42px; border: 0; color: var(--visit-color); background: transparent; cursor: pointer; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 60%)); }
.route-map-canvas :deep(.dispatch-visit-pin) { position: absolute; z-index: 0; top: 0; left: 0; display: block; width: 38px; height: 38px; }
.route-map-canvas :deep(.dispatch-visit-number) { position: absolute; z-index: 1; top: 7px; left: calc(50% - 2px); display: grid; width: 16px; height: 16px; place-items: center; transform: translateX(-50%); border-radius: 50%; color: #000; background: var(--visit-color); font-family: var(--font-mono, monospace); font-size: 10px; font-weight: 700; line-height: 1; white-space: nowrap; }
.route-map-canvas :deep(.dispatch-visit-button.is-selected) { filter: drop-shadow(0 0 2px #fff) drop-shadow(0 0 4px #3876c5); }
.route-map-canvas :deep(.dispatch-visit-button:hover) { filter: drop-shadow(0 0 2px #fff); }
.route-map-canvas :deep(.dispatch-visit-button:focus-visible) { outline: 3px solid #fff; outline-offset: 2px; }
.route-map-canvas :deep(.dispatch-direction-head) { display: block; width: 12px; height: 12px; border-top: 3px solid #d8eeff; border-right: 3px solid #d8eeff; filter: drop-shadow(0 1px 2px #122c4e); }
.route-map-selection { position: absolute; z-index: 500; top: 14px; left: 14px; display: flex; align-items: flex-start; gap: 10px; max-width: min(360px, calc(100% - 88px)); padding: 11px 13px; border: 1px solid var(--line-strong); border-radius: 9px; color: var(--ink); background: color-mix(in srgb, var(--panel) 96%, transparent); box-shadow: 0 4px 14px #0002; pointer-events: none; }
.selection-marker { display: block; width: 42px; height: 42px; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 60%)); }
.selection-marker .map-route-stop-pin { display: block; width: 38px; height: 38px; }
.selection-marker .map-route-stop-number { z-index: 1; top: 7px; left: calc(50% - 2px); width: 16px; height: 16px; transform: translateX(-50%); font-size: 10px; line-height: 1; white-space: nowrap; }
.route-map-selection > div { min-width: 0; }
.route-map-selection small { display: block; color: var(--muted); font-size: 11px; line-height: 16px; }
.route-map-selection strong { display: block; overflow-wrap: anywhere; margin-top: 3px; font-size: 13px; line-height: 19px; }
.route-map-selection div > span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 16px; }
.route-map-zoom { position: absolute; z-index: 500; top: 14px; right: 14px; overflow: hidden; border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: 0 2px 8px #0002; }
.route-map-zoom button { display: grid; width: 42px; height: 42px; place-items: center; color: var(--ink); background: var(--panel); }
.route-map-zoom button + button { border-top: 1px solid var(--line); }
.route-map-zoom button:hover { color: var(--accent); background: var(--panel-muted); }
.route-map-state { position: absolute; z-index: 600; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 28px; color: var(--muted); background: var(--panel); text-align: center; }
.route-map-state p { margin: 0; font-size: 14px; }
.route-map-state button, .route-map-tile-notice button { display: inline-flex; min-height: 36px; align-items: center; justify-content: center; gap: 7px; padding: 5px 9px; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--ink); background: var(--panel); font-size: 12px; }
.route-map-tile-notice { position: absolute; z-index: 500; right: 12px; bottom: 30px; left: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 7px; color: var(--warning); background: var(--panel); font-size: 12px; line-height: 18px; }
.route-map-tile-notice button { margin-left: auto; }
.route-map-tile-loading { position: absolute; z-index: 500; bottom: 30px; left: 12px; display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 5px; color: var(--muted); background: var(--panel); font-size: 11px; }
.route-map-caption { display: flex; align-items: flex-start; gap: 7px; padding: 12px 16px; color: var(--muted); font-size: 11px; line-height: 17px; }
.route-map-caption > svg { flex-shrink: 0; margin-top: 1px; }
.dispatch-route-map button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.map-loader { animation: route-map-spin 1s linear infinite; }
@keyframes route-map-spin { to { transform: rotate(360deg); } }
@media (max-width: 1100px) { .dispatch-route-map { height: 560px; } }
@media (max-width: 640px) {
  .route-map-header { padding: 12px 12px 10px; }
  .route-map-heading h3 { font-size: 14px; }
  .route-map-fit { min-height: 42px; padding-inline: 8px; }
  .route-map-legend { padding: 0 12px 11px; gap: 6px 12px; font-size: 11px; }
  .route-map-legend .route-order-hint { margin-left: 0; }
  .dispatch-route-map { height: 520px; }
  .route-map-selection { top: 10px; left: 10px; gap: 8px; padding: 9px 10px; max-width: calc(100% - 74px); }
  .route-map-zoom { top: 10px; right: 10px; }
  .route-map-caption { padding: 10px 12px; }
}
@media (prefers-reduced-motion: reduce) { .map-loader { animation: none; } }
</style>
