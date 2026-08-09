<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DataMode, HorizonKey, StationRisk } from '~/shared/ops'

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
const abnormalCount = computed(() => mappedStations.value.filter((station) => {
  const tone = markerTone(station)
  return tone === 'empty-risk' || tone === 'full-risk' || tone === 'service-review'
}).length)

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

type MarkerTone = 'stable' | 'empty-risk' | 'full-risk' | 'service-review' | 'inventory-only'

function forecastFor(station: StationRisk) {
  return station.forecast.horizons[props.horizon]
}

function markerTone(station: StationRisk): MarkerTone {
  if (station.serviceStatus !== 'operational') return 'service-review'
  if (station.currentState === 'empty_now') return 'empty-risk'
  if (station.currentState === 'full_now') return 'full-risk'

  const forecast = forecastFor(station)
  if (isLive.value && forecast.baselineStatus !== 'matched') return 'inventory-only'
  if (forecast.emptyRisk >= forecast.alertThreshold && forecast.emptyRisk >= forecast.fullRisk) return 'empty-risk'
  if (forecast.fullRisk >= forecast.alertThreshold) return 'full-risk'
  return 'stable'
}

function markerColor(station: StationRisk) {
  const colors: Record<MarkerTone, string> = {
    stable: '#1e6f62',
    'empty-risk': '#a93a34',
    'full-risk': '#2f648f',
    'service-review': '#65706b',
    'inventory-only': '#8a5a09',
  }
  return colors[markerTone(station)]
}

function markerStatus(station: StationRisk) {
  const tone = markerTone(station)
  if (tone === 'service-review') {
    return station.serviceStatus === 'official_inactive'
      ? '官方未啟用（需確認）'
      : '疑似服務異常（需確認）'
  }
  if (tone === 'inventory-only') return '僅顯示即時庫存'
  if (station.currentState === 'empty_now') return '目前無車可借'
  if (station.currentState === 'full_now') return '目前無位可還'
  if (tone === 'empty-risk') return '預測缺車風險'
  if (tone === 'full-risk') return '預測缺位風險'
  return isLive.value ? '即時庫存與基線穩定' : '預測風險低'
}

function interventionGap(station: StationRisk) {
  const forecast = forecastFor(station)
  const buffer = Math.max(2, Math.ceil(station.totalDocks * .35))
  const tone = markerTone(station)
  if (tone === 'empty-risk') return Math.max(1, buffer - Math.min(station.availableBikes, forecast.predictedBikes))
  if (tone === 'full-risk') return Math.max(1, buffer - Math.min(station.availableDocks, forecast.predictedDocks))
  return tone === 'service-review' ? 2 : 0
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, character => htmlEntities[character] || character)
}

function tooltipContent(station: StationRisk) {
  const forecast = forecastFor(station)
  const tone = markerTone(station)
  const inventory = `可借 ${station.availableBikes}・可還 ${station.availableDocks}`
  const direction = tone === 'empty-risk' ? `無車風險指標 ${Math.round(forecast.emptyRisk * 100)}／100，建議補車` : tone === 'full-risk'
    ? `無位風險指標 ${Math.round(forecast.fullRisk * 100)}／100，建議移車`
    : markerStatus(station)
  const context = forecast.baselineStatus === 'matched'
    ? `${props.horizon} 分鐘 · ${direction}`
    : direction
  return `<strong>${escapeHtml(station.name)}</strong><span>${escapeHtml(station.district || '新北市')}・${inventory}</span><span>${escapeHtml(context)}</span>`
}

function markerOptions(station: StationRisk) {
  const selected = station.id === props.selectedId
  const gap = interventionGap(station)
  return {
    radius: Math.max(4.5, 5 + Math.min(7, Math.sqrt(gap) * 1.7)) + (selected ? 2 : 0),
    color: selected ? '#f5f5f1' : '#1d2926',
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
  if (!selected || selected.latitude === null || selected.longitude === null) return
  leafletMap.panTo([selected.latitude, selected.longitude], { animate: true, duration: .35 })
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
  .map((station) => {
    const forecast = forecastFor(station)
    return `${station.id}:${station.latitude}:${station.longitude}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.serviceStatus}:${forecast.emptyRisk}:${forecast.fullRisk}:${forecast.predictedBikes}:${forecast.predictedDocks}:${forecast.baselineStatus}`
  })
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
        <h2>{{ isLive ? `新北市 ${horizon} 分鐘即時基線風險` : `新北市 ${horizon} 分鐘預測風險分布` }}</h2>
      </div>
      <span class="risk-summary"><b>{{ mappedStations.length }}</b> {{ stationQuery ? '個搜尋結果' : (isLive ? '個即時站點' : '個預測站點') }}</span>
    </div>

    <div class="geographic-map" role="region" :aria-label="isLive ? '新北市即時基線風險站點地圖' : '新北市歷史預測風險站點地圖'">
      <div ref="mapElement" class="map-canvas" />
      <div class="map-tools" role="group" aria-label="地圖工具">
        <label class="map-search">
          <Icon icon="solar:magnifer-outline" />
          <input v-model="stationQuery" type="search" placeholder="搜尋站名或行政區" aria-label="搜尋站名或行政區" />
        </label>
        <button type="button" class="map-reset" @click="fitNewTaipeiBounds"><Icon icon="solar:map-arrow-left-outline" /> 回到新北全域</button>
      </div>
      <p v-if="!mappedStations.length" class="map-empty">目前沒有可定位的站點資料。</p>
    </div>
    <div class="map-caption">
      <p class="map-instruction"><Icon icon="solar:cursor-square-outline" /> 圓點顏色代表風險方向，大小代表預估介入缺口</p>
      <div class="geographic-map-legend" aria-label="風險方向圖例">
        <span><i class="legend-dot normal" />基線穩定</span>
        <span><i class="legend-dot empty" />無車風險／目前無車</span>
        <span><i class="legend-dot full" />無位風險／目前無位</span>
        <span><i class="legend-dot unavailable" />疑似服務異常</span>
        <span v-if="isLive"><i class="legend-dot inventory-only" />未對照基線</span>
      </div>
    </div>
    <p class="map-status-summary"><Icon icon="solar:info-circle-outline" /> {{ isLive ? `目前有 ${abnormalCount} 個站點需留意；紅色為缺車、藍色為缺位、灰色需人工確認。` : `目前有 ${abnormalCount} 個風險或服務異常站點；地圖與資料皆限定新北市。` }}</p>
  </section>
</template>

<style scoped>
.geographic-map-panel { overflow: hidden; }
.geographic-map {
  position: relative;
  min-height: 510px;
  margin: 0 14px;
  overflow: hidden;
  background: #e3e9e4;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.map-canvas { width: 100%; min-height: 510px; }
.map-instruction,
.geographic-map-legend,
.map-empty {
  margin: 0;
  color: var(--muted);
  font-size: 16px;
  font-weight: 600;
}

.map-caption {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 11px 18px 0;
}
.map-instruction {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.map-instruction svg { color: var(--teal-dark); font-size: 19px; }
.map-tools {
  position: absolute;
  z-index: 500;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--line-strong, var(--line));
  border-radius: 6px;
}

.map-search { display: inline-flex; align-items: center; gap: 5px; min-width: 215px; color: inherit; }
.map-search svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 19px; }
.map-search input { width: 100%; min-width: 0; padding: 6px 4px; color: inherit; background: transparent; border: 0; outline: 0; font: inherit; }
.map-search input::placeholder { color: var(--muted); opacity: 1; }
.map-reset { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 6px 9px; color: #fff; background: var(--teal-dark); border: 1px solid var(--teal-dark); border-radius: 5px; font: inherit; font-size: 16px; font-weight: 700; cursor: pointer; }
.map-reset:hover, .map-reset:focus-visible { color: #fff; background: var(--teal); border-color: var(--teal); outline: 3px solid rgba(30, 111, 98, .28); outline-offset: 2px; }
.geographic-map-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 13px;
}

.geographic-map-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend-dot { width: 10px; height: 10px; border: 1px solid rgba(11, 42, 47, .62); border-radius: 50%; background: #1e6f62; }
.legend-dot.empty { background: #a93a34; }.legend-dot.full { background: #2f648f; }.legend-dot.unavailable { background: #65706b; }.legend-dot.inventory-only { background: #8a5a09; }
.map-empty { position: absolute; z-index: 500; inset: 50% auto auto 50%; padding: 12px; color: var(--ink); background: var(--panel); border: 1px solid var(--line-strong, var(--line)); border-radius: 6px; font-weight: 700; transform: translate(-50%, -50%); }
.map-status-summary { display: flex; align-items: center; gap: 6px; margin: 10px 18px 14px; color: var(--muted); font-size: 16px; font-weight: 600; }
.map-status-summary svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 19px; }

:global(.geographic-map .leaflet-container) { min-height: 510px; font-family: 'Noto Sans TC', sans-serif; }
:global(.geographic-map .leaflet-control-zoom a) { width: 35px; height: 35px; color: #1d2926; font-size: 25px; line-height: 33px; }
:global(.geographic-map .leaflet-control-attribution) { padding: 3px 6px; color: #35433f; background: rgba(255, 255, 255, .94); font-size: 16px; }
:global(.geographic-map .leaflet-control-attribution a) { color: #15584e; font-weight: 700; }
:global(.geographic-map .leaflet-tooltip) { padding: 8px 10px; color: #1d2926; background: #fff; border: 1px solid #a9b7af; border-radius: 5px; box-shadow: none; font-size: 16px; }
:global(.geographic-map .leaflet-tooltip strong), :global(.geographic-map .leaflet-tooltip span) { display: block; }
:global(.geographic-map .leaflet-tooltip span) { margin-top: 3px; color: #55635f; font-weight: 600; }
:global(html[data-theme='dark'] .geographic-map) { background: #10262c; border-color: var(--line-strong); }
:global(html[data-theme='dark'] .geographic-map .leaflet-tile-pane) { filter: brightness(.72) saturate(.82); }
:global(html[data-theme='dark'] .map-instruction), :global(html[data-theme='dark'] .geographic-map-legend) { color: var(--muted); }
:global(html[data-theme='dark'] .map-tools), :global(html[data-theme='dark'] .map-empty) { color: var(--ink); background: var(--panel); border-color: var(--line-strong); box-shadow: none; }
:global(html[data-theme='dark'] .map-instruction svg), :global(html[data-theme='dark'] .map-search svg) { color: var(--teal); }
:global(html[data-theme='dark'] .map-search) { color: var(--ink); }
:global(html[data-theme='dark'] .map-search input::placeholder) { color: var(--muted); }
:global(html[data-theme='dark'] .map-reset) { color: #12221e; background: #9dd4c6; border-color: #9dd4c6; }
:global(html[data-theme='dark'] .map-reset:hover), :global(html[data-theme='dark'] .map-reset:focus-visible) { color: #12221e; background: #c4e6db; border-color: #c4e6db; }
:global(html[data-theme='dark'] .legend-dot) { border-color: #effbf8; }
:global(html[data-theme='dark'] .geographic-map .leaflet-control-zoom a), :global(html[data-theme='dark'] .geographic-map .leaflet-control-attribution) { color: var(--ink); background: var(--panel); border-color: var(--line-strong); }
:global(html[data-theme='dark'] .geographic-map .leaflet-control-attribution a) { color: var(--teal); }
:global(html[data-theme='dark'] .geographic-map .leaflet-tooltip) { color: var(--ink); background: var(--panel); border-color: var(--line-strong); }
:global(html[data-theme='dark'] .geographic-map .leaflet-tooltip span) { color: var(--muted); }

@media (max-width: 1150px) { .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 460px; } }
@media (max-width: 780px) {
  .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 390px; }
  .map-tools { top: 55px; right: 8px; max-width: calc(100% - 16px); }
  .map-search { min-width: 170px; }
  .map-caption { gap: 7px 12px; padding: 10px 14px 0; }
}
@media (max-width: 480px) {
  .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 350px; }
  .map-tools { top: 51px; left: 8px; right: 8px; justify-content: space-between; }
  .map-search { min-width: 0; flex: 1; }
  .map-reset { padding: 6px 7px; }
}
</style>
