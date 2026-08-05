<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DataMode, HorizonKey, RiskLevel, StationRisk } from '~/shared/ops'

const props = defineProps<{
  stations: StationRisk[]
  horizon: HorizonKey
  selectedId?: string
  dataMode?: DataMode
}>()

const emit = defineEmits<{ select: [stationId: string] }>()

type LeafletModule = typeof import('leaflet')
type LeafletMap = import('leaflet').Map
type LeafletLayerGroup = import('leaflet').LayerGroup
type LeafletCircleMarker = import('leaflet').CircleMarker
type LeafletRenderer = import('leaflet').Renderer

const mapElement = ref<HTMLElement | null>(null)
const isLive = computed(() => props.dataMode === 'live')
const stationQuery = ref('')
const allMappedStations = computed(() => props.stations.filter(station => station.latitude !== null && station.longitude !== null))
const mappedStations = computed(() => {
  const query = stationQuery.value.trim().toLocaleLowerCase('zh-TW')
  if (!query) return allMappedStations.value
  return allMappedStations.value.filter(station => `${station.name} ${station.district}`.toLocaleLowerCase('zh-TW').includes(query))
})
const abnormalCount = computed(() => isLive.value
  ? mappedStations.value.filter(station => station.currentState !== 'normal').length
  : mappedStations.value.filter(station => ['high', 'critical'].includes(markerTone(station))).length)

let leaflet: LeafletModule | null = null
let leafletMap: LeafletMap | null = null
let markerLayer: LeafletLayerGroup | null = null
let canvasRenderer: LeafletRenderer | null = null
let resizeObserver: ResizeObserver | null = null
const markerById = new globalThis.Map<string, LeafletCircleMarker>()
const htmlEntities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#039;',
  '"': '&quot;',
}

function markerTone(station: StationRisk): RiskLevel | 'empty' | 'full' | 'unavailable' {
  if (station.currentState === 'unavailable') return 'unavailable'
  if (isLive.value) {
    if (station.currentState === 'empty_now') return 'empty'
    if (station.currentState === 'full_now') return 'full'
    return 'normal'
  }
  if (station.currentState === 'empty_now' || station.currentState === 'full_now') return 'critical'
  return station.forecast.horizons[props.horizon].level
}

function markerColor(station: StationRisk) {
  const colors = {
    normal: '#168c80',
    medium: '#c18a08',
    high: '#dd761a',
    critical: '#d94045',
    empty: '#d94045',
    full: '#dd761a',
    unavailable: '#697982',
  } as const
  return colors[markerTone(station)]
}

function markerStatus(station: StationRisk) {
  if (isLive.value) {
    if (station.currentState === 'empty_now') return '無車可借'
    if (station.currentState === 'full_now') return '無位可還'
    if (station.currentState === 'unavailable') return '暫停／異常'
    return '可借可還'
  }

  const level = markerTone(station)
  const labels: Record<RiskLevel | 'empty' | 'full' | 'unavailable', string> = {
    normal: '風險低',
    medium: '中風險',
    high: '高風險',
    critical: '需優先處理',
    empty: '目前無車',
    full: '目前無位',
    unavailable: '暫停／異常',
  }
  return labels[level]
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, character => htmlEntities[character] || character)
}

function tooltipContent(station: StationRisk) {
  const inventory = isLive.value
    ? `可借 ${station.availableBikes}・可還 ${station.availableDocks}`
    : `${props.horizon} 分鐘 ${markerStatus(station)}`
  return `<strong>${escapeHtml(station.name)}</strong><span>${escapeHtml(station.district || '新北市')}・${inventory}</span>`
}

function markerOptions(station: StationRisk) {
  const selected = station.id === props.selectedId
  return {
    radius: selected ? 7.5 : 5,
    color: selected ? '#f7fffd' : '#102c32',
    weight: selected ? 3 : 1.25,
    fillColor: markerColor(station),
    fillOpacity: selected ? 1 : .92,
  }
}

function renderMarkers() {
  if (!leaflet || !leafletMap || !markerLayer || !canvasRenderer) return

  const visibleIds = new Set<string>()
  for (const station of mappedStations.value) {
    if (station.latitude === null || station.longitude === null) continue
    visibleIds.add(station.id)

    const existing = markerById.get(station.id)
    if (existing) {
      existing.setLatLng([station.latitude, station.longitude])
      existing.setRadius(markerOptions(station).radius)
      existing.setStyle(markerOptions(station))
      existing.setTooltipContent(tooltipContent(station))
      continue
    }

    const marker = leaflet.circleMarker([station.latitude, station.longitude], {
      ...markerOptions(station),
      renderer: canvasRenderer,
      bubblingMouseEvents: false,
    })
    marker.bindTooltip(tooltipContent(station), {
      direction: 'top',
      offset: [0, -4],
      opacity: 1,
      sticky: true,
    })
    marker.on('click', () => emit('select', station.id))
    marker.addTo(markerLayer)
    markerById.set(station.id, marker)
  }

  for (const [stationId, marker] of markerById) {
    if (visibleIds.has(stationId)) continue
    markerLayer.removeLayer(marker)
    markerById.delete(stationId)
  }
}

function fitNewTaipeiBounds() {
  if (!leaflet || !leafletMap || !allMappedStations.value.length) return
  const points = allMappedStations.value
    .filter(station => station.latitude !== null && station.longitude !== null)
    .map(station => [station.latitude as number, station.longitude as number] as [number, number])
  if (points.length) leafletMap.fitBounds(leaflet.latLngBounds(points), { padding: [26, 26], maxZoom: 13 })
}

function focusSelectedStation() {
  if (!leafletMap || !props.selectedId) return
  const selected = mappedStations.value.find(station => station.id === props.selectedId)
  if (selected?.latitude !== null && selected?.longitude !== null) {
    leafletMap.panTo([selected.latitude, selected.longitude], { animate: true, duration: .35 })
  }
}

async function initialiseMap() {
  if (!mapElement.value || leafletMap) return
  leaflet = await import('leaflet')
  leafletMap = leaflet.map(mapElement.value, {
    attributionControl: false,
    preferCanvas: true,
    scrollWheelZoom: false,
    zoomControl: true,
    minZoom: 9,
    maxZoom: 19,
  })
  leaflet.control.attribution({ position: 'bottomleft', prefix: false }).addTo(leafletMap)
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(leafletMap)
  canvasRenderer = leaflet.canvas({ padding: .5 })
  markerLayer = leaflet.layerGroup().addTo(leafletMap)
  renderMarkers()
  fitNewTaipeiBounds()

  resizeObserver = new ResizeObserver(() => leafletMap?.invalidateSize({ pan: false }))
  resizeObserver.observe(mapElement.value)
}

const stationSignature = computed(() => mappedStations.value
  .map(station => `${station.id}:${station.latitude}:${station.longitude}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.forecast.horizons[props.horizon].level}`)
  .join('|'))

watch(stationSignature, () => renderMarkers())
watch(() => props.selectedId, () => {
  renderMarkers()
  focusSelectedStation()
})
watch([() => props.dataMode, () => props.horizon], () => renderMarkers())

onMounted(() => { void initialiseMap() })
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  markerById.clear()
  leafletMap?.remove()
  leafletMap = null
})
</script>

<template>
  <section class="panel map-panel geographic-map-panel" :class="{ 'live-map-panel': isLive }">
    <div class="panel-heading map-heading">
      <div>
        <p class="section-kicker"><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:map-point-wave-outline'" /> 新北市實景地圖</p>
        <h2>{{ isLive ? '新北市全域即時站點分布' : `新北市 ${horizon} 分鐘預測風險分布` }}</h2>
      </div>
      <span class="risk-summary"><b>{{ mappedStations.length }}</b> {{ stationQuery ? '個搜尋結果' : (isLive ? '個即時站點' : '個預測站點') }}</span>
    </div>

    <div class="geographic-map" role="region" :aria-label="isLive ? '新北市全域即時公共自行車站點地圖' : '新北市歷史預測風險站點地圖'">
      <div ref="mapElement" class="map-canvas" />
      <p class="map-instruction"><Icon icon="solar:cursor-square-outline" /> {{ isLive ? '圓點代表即時庫存，點選查看站點詳情' : '圓點代表預測風險，點選查看站點詳情' }}</p>
      <div class="map-tools" role="group" aria-label="地圖工具">
        <label class="map-search">
          <Icon icon="solar:magnifer-outline" />
          <input v-model="stationQuery" type="search" placeholder="搜尋站名或行政區" aria-label="搜尋站名或行政區" />
        </label>
        <button type="button" class="map-reset" @click="fitNewTaipeiBounds"><Icon icon="solar:map-arrow-left-outline" /> 回到新北全域</button>
      </div>
      <div class="geographic-map-legend" :aria-label="isLive ? '即時站況圖例' : '預測風險圖例'">
        <template v-if="isLive">
          <span><i class="legend-dot normal" />可借可還</span>
          <span><i class="legend-dot empty" />無車可借</span>
          <span><i class="legend-dot full" />無位可還</span>
          <span><i class="legend-dot unavailable" />暫停／異常</span>
        </template>
        <template v-else>
          <span><i class="legend-dot normal" />風險低</span>
          <span><i class="legend-dot medium" />中風險</span>
          <span><i class="legend-dot high" />高風險</span>
          <span><i class="legend-dot critical" />需優先處理</span>
        </template>
      </div>
      <p v-if="!mappedStations.length" class="map-empty">目前沒有可定位的站點資料。</p>
    </div>
    <p class="map-status-summary"><Icon icon="solar:info-circle-outline" /> {{ isLive ? `目前有 ${abnormalCount} 個站點需要留意；地圖範圍與資料皆限定新北市。` : `目前有 ${abnormalCount} 個高風險站點；預測模型與歷史資料皆限定新北市。` }}</p>
  </section>
</template>

<style scoped>
.geographic-map-panel { overflow: hidden; }
.geographic-map {
  position: relative;
  min-height: 510px;
  margin: 0 11px;
  overflow: hidden;
  background: #dbe6e6;
  border: 1px solid #c9dbdb;
  border-radius: 14px;
}

.map-canvas { width: 100%; min-height: 510px; }
.map-instruction,
.map-tools,
.geographic-map-legend,
.map-empty {
  position: absolute;
  z-index: 500;
  margin: 0;
  color: #18373d;
  background: rgba(255, 255, 255, .96);
  border: 1px solid rgba(86, 126, 129, .62);
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(14, 42, 47, .18);
}

.map-instruction {
  top: 12px;
  left: 54px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 70px);
  padding: 8px 10px;
  font-size: 16px;
  font-weight: 700;
}

.map-instruction svg { color: #08756e; font-size: 19px; }
.map-tools {
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px;
}

.map-search { display: inline-flex; align-items: center; gap: 5px; min-width: 215px; color: #18373d; }
.map-search svg { flex: 0 0 auto; color: #08756e; font-size: 19px; }
.map-search input { width: 100%; min-width: 0; padding: 6px 4px; color: inherit; background: transparent; border: 0; outline: 0; font: inherit; }
.map-search input::placeholder { color: #526e73; opacity: 1; }
.map-reset { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 6px 9px; color: #123f42; background: #dff5f0; border: 1px solid #6daaa0; border-radius: 7px; font: inherit; font-size: 16px; font-weight: 800; cursor: pointer; }
.map-reset:hover, .map-reset:focus-visible { color: #082b2d; background: #c9eee5; border-color: #23766d; outline: 3px solid rgba(31, 130, 119, .28); outline-offset: 2px; }
.geographic-map-legend {
  right: 12px;
  bottom: 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px 13px;
  padding: 10px 12px;
  font-size: 16px;
  font-weight: 700;
}

.geographic-map-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend-dot { width: 10px; height: 10px; border: 1px solid rgba(11, 42, 47, .62); border-radius: 50%; background: #168c80; }
.legend-dot.medium { background: #c18a08; }.legend-dot.high, .legend-dot.full { background: #dd761a; }.legend-dot.critical, .legend-dot.empty { background: #d94045; }.legend-dot.unavailable { background: #697982; }
.map-empty { inset: 50% auto auto 50%; padding: 12px; font-size: 16px; font-weight: 700; transform: translate(-50%, -50%); }
.map-status-summary { display: flex; align-items: center; gap: 6px; margin: 10px 18px 14px; color: var(--muted); font-size: 16px; font-weight: 600; }
.map-status-summary svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 19px; }

:global(.geographic-map .leaflet-container) { min-height: 510px; font-family: 'Noto Sans TC', sans-serif; }
:global(.geographic-map .leaflet-control-zoom a) { width: 35px; height: 35px; color: #13343a; font-size: 25px; line-height: 33px; }
:global(.geographic-map .leaflet-control-attribution) { padding: 3px 6px; color: #18373d; background: rgba(255, 255, 255, .92); font-size: 16px; }
:global(.geographic-map .leaflet-control-attribution a) { color: #075f5a; font-weight: 700; }
:global(.geographic-map .leaflet-tooltip) { padding: 8px 10px; color: #102c32; background: #f8fffd; border: 1px solid #4a777b; border-radius: 8px; box-shadow: 0 4px 14px rgba(8, 36, 40, .22); font-size: 16px; }
:global(.geographic-map .leaflet-tooltip strong), :global(.geographic-map .leaflet-tooltip span) { display: block; }
:global(.geographic-map .leaflet-tooltip span) { margin-top: 3px; color: #4a6267; font-weight: 600; }
:global(html[data-theme='dark'] .geographic-map) { background: #10262c; border-color: #42656a; }
:global(html[data-theme='dark'] .geographic-map .leaflet-tile-pane) { filter: brightness(.72) saturate(.82); }
:global(html[data-theme='dark'] .map-instruction), :global(html[data-theme='dark'] .geographic-map-legend), :global(html[data-theme='dark'] .map-empty) { color: #effbf8; background: rgba(5, 20, 27, .95); border-color: #6a9194; box-shadow: 0 4px 14px rgba(0, 0, 0, .42); }
:global(html[data-theme='dark'] .map-tools) { color: #effbf8; background: rgba(5, 20, 27, .95); border-color: #6a9194; box-shadow: 0 4px 14px rgba(0, 0, 0, .42); }
:global(html[data-theme='dark'] .map-instruction svg) { color: #8af0df; }
:global(html[data-theme='dark'] .map-search) { color: #effbf8; }
:global(html[data-theme='dark'] .map-search svg) { color: #8af0df; }
:global(html[data-theme='dark'] .map-search input::placeholder) { color: #bbd2d2; }
:global(html[data-theme='dark'] .map-reset) { color: #06252a; background: #bdf4e8; border-color: #e2fff8; }
:global(html[data-theme='dark'] .map-reset:hover), :global(html[data-theme='dark'] .map-reset:focus-visible) { color: #03181c; background: #e2fff8; border-color: #ffffff; }
:global(html[data-theme='dark'] .legend-dot) { border-color: #effbf8; }
:global(html[data-theme='dark'] .geographic-map .leaflet-control-zoom a), :global(html[data-theme='dark'] .geographic-map .leaflet-control-attribution) { color: #effbf8; background: rgba(5, 20, 27, .94); border-color: #6a9194; }
:global(html[data-theme='dark'] .geographic-map .leaflet-control-attribution a) { color: #aaf7e8; }
:global(html[data-theme='dark'] .geographic-map .leaflet-tooltip) { color: #effbf8; background: #0a2029; border-color: #77a0a4; }
:global(html[data-theme='dark'] .geographic-map .leaflet-tooltip span) { color: #c4d9d8; }

@media (max-width: 1150px) { .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 460px; } }
@media (max-width: 780px) {
  .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 390px; }
  .map-instruction { left: 50px; max-width: calc(100% - 62px); }
  .map-tools { top: 55px; right: 8px; max-width: calc(100% - 16px); }
  .map-search { min-width: 170px; }
  .geographic-map-legend { right: 8px; bottom: 8px; gap: 6px 9px; padding: 8px; }
}
@media (max-width: 480px) {
  .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 350px; }
  .map-instruction { top: 8px; left: 48px; padding: 7px 8px; }
  .map-tools { top: 51px; left: 8px; right: 8px; justify-content: space-between; }
  .map-search { min-width: 0; flex: 1; }
  .map-reset { padding: 6px 7px; }
  .geographic-map-legend { grid-template-columns: 1fr; }
}
</style>
