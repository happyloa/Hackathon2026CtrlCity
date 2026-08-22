<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type DataMode, type HorizonKey, type PredictionCoverage, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  stations: StationRisk[]
  horizon: HorizonKey
  selectedId?: string
  dataMode?: DataMode
  profileCoverage?: PredictionCoverage | null
  profileError?: string
}>()

const emit = defineEmits<{ select: [stationId: string], retryBaseline: [] }>()

type LeafletModule = typeof import('leaflet')
type LeafletMap = import('leaflet').Map
type LeafletLayerGroup = import('leaflet').LayerGroup
type LeafletCircleMarker = import('leaflet').CircleMarker
type LeafletRenderer = import('leaflet').Renderer

const mapElement = ref<HTMLElement | null>(null)
const isLive = computed(() => props.dataMode === 'live')
const stationQuery = ref('')
const showAllStations = ref(false)
const allMappedStations = computed(() => props.stations.filter(station => station.latitude !== null && station.longitude !== null))
const mappedStations = computed(() => {
  const query = stationQuery.value.trim().toLocaleLowerCase('zh-TW')
  if (!query && !showAllStations.value) {
    return allMappedStations.value.filter(station => station.id === props.selectedId || isActionable(station))
  }
  if (!query) return allMappedStations.value
  return allMappedStations.value.filter(station => `${station.name} ${station.district}`.toLocaleLowerCase('zh-TW').includes(query))
})
const searchResults = computed(() => stationQuery.value.trim() ? mappedStations.value.slice(0, 6) : [])
const hasBaselineLoadError = computed(() => isLive.value && Boolean(props.profileError))
const actionableCount = computed(() => allMappedStations.value.filter(isActionable).length)
const unmatchedBaselineCount = computed(() => {
  if (!isLive.value || hasBaselineLoadError.value) return 0
  return allMappedStations.value.filter(station => station.serviceStatus === 'operational' && forecastFor(station).baselineStatus === 'unmatched').length
})
const headerCount = computed(() => stationQuery.value
  ? mappedStations.value.length
  : showAllStations.value
    ? allMappedStations.value.length
    : actionableCount.value)
const headerLabel = computed(() => stationQuery.value
  ? '個搜尋結果'
  : showAllStations.value
    ? '個全市站點'
    : '個待處理站點')
const baselineNotice = computed(() => {
  if (!isLive.value) return ''
  if (hasBaselineLoadError.value) return '歷史基線暫時無法載入，現在僅顯示官方即時庫存；按「立即更新」即可重新比對。'
  if (unmatchedBaselineCount.value) return `${unmatchedBaselineCount.value} 個新增或改名站尚無同站歷史基線，僅顯示即時庫存，不納入 60 分鐘預估。`
  return ''
})
const mapStatusText = computed(() => {
  if (stationQuery.value) return `搜尋結果共 ${mappedStations.value.length} 站；點選站點查看即時庫存與判讀。`
  if (showAllStations.value) return `顯示全市 ${allMappedStations.value.length} 站；顏色標示需要優先處理的狀態。`
  return `預設只顯示 ${actionableCount.value} 個待處理站點；可切換查看全市或搜尋站名。`
})

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

function isActionable(station: StationRisk) {
  const tone = markerTone(station)
  return tone === 'empty-risk' || tone === 'full-risk' || tone === 'service-review'
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
  if (tone === 'inventory-only') return hasBaselineLoadError.value ? '基線暫不可用，僅顯示即時庫存' : '尚無歷史基線，僅顯示即時庫存'
  if (station.currentState === 'empty_now') return '目前無車可借'
  if (station.currentState === 'full_now') return '目前無位可還'
  if (tone === 'empty-risk') return isLive.value ? '60 分鐘缺車風險' : '預測缺車風險'
  if (tone === 'full-risk') return isLive.value ? '60 分鐘缺位風險' : '預測缺位風險'
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
  const direction = tone === 'empty-risk' ? `無車風險分數 ${Math.round(forecast.emptyRisk * 100)}／100，建議補車` : tone === 'full-risk'
    ? `無位風險分數 ${Math.round(forecast.fullRisk * 100)}／100，建議移車`
    : markerStatus(station)
  const context = forecast.baselineStatus === 'matched'
    ? `${props.horizon} 分鐘 · ${direction}`
    : direction
  return `<strong>${escapeHtml(displayStationName(station.name))}</strong><span>${escapeHtml(station.district || '新北市')}・${inventory}</span><span>${escapeHtml(context)}</span>`
}

function markerOptions(station: StationRisk) {
  const selected = station.id === props.selectedId
  const gap = interventionGap(station)
  return {
    radius: Math.max(4.5, 5 + Math.min(7, Math.sqrt(gap) * 1.7)) + (selected ? 2 : 0),
    color: selected ? '#f4f4f5' : '#242428',
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

function toggleStationScope() {
  showAllStations.value = !showAllStations.value
}

function chooseSearchResult(stationId: string) {
  emit('select', stationId)
}

function focusSelectedStation() {
  if (!leafletMap || !props.selectedId) return
  const selected = mappedStations.value.find(station => station.id === props.selectedId)
  if (!selected || selected.latitude === null || selected.longitude === null) return
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  leafletMap.panTo([selected.latitude, selected.longitude], { animate: !reduceMotion, duration: reduceMotion ? 0 : .35 })
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

const stationSignature = computed(() => `${hasBaselineLoadError.value}|${mappedStations.value
  .map((station) => {
    const forecast = forecastFor(station)
    return `${station.id}:${station.latitude}:${station.longitude}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.serviceStatus}:${forecast.emptyRisk}:${forecast.fullRisk}:${forecast.predictedBikes}:${forecast.predictedDocks}:${forecast.baselineStatus}`
  })
  .join('|')}`)

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
        <p class="section-kicker"><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:map-point-wave-outline'" /> 站點地圖</p>
        <h2>{{ isLive ? `${horizon} 分鐘待處理站點` : `${horizon} 分鐘預測風險分布` }}</h2>
      </div>
      <div class="map-summary" :class="{ 'map-summary--warning': hasBaselineLoadError }">
        <strong>{{ headerCount }}</strong>
        <span>{{ headerLabel }}</span>
        <small v-if="isLive">{{ hasBaselineLoadError ? '基線暫不可用' : (profileCoverage ? `已對照 ${profileCoverage.matchedStations}／${profileCoverage.liveStations}` : '正在載入基線') }}</small>
      </div>
    </div>

    <div class="map-command-row" role="group" aria-label="地圖工具">
      <div class="map-search" role="search">
        <Icon icon="solar:magnifer-outline" />
        <input v-model="stationQuery" type="text" inputmode="search" enterkeyhint="search" placeholder="搜尋站名或行政區" aria-label="搜尋站名或行政區" />
        <button v-if="stationQuery" class="map-search-clear" type="button" aria-label="清除站點搜尋" @click="stationQuery = ''"><Icon icon="solar:close-circle-outline" /></button>
      </div>
      <div class="map-actions">
        <button type="button" class="map-view-toggle" :aria-pressed="showAllStations" @click="toggleStationScope"><Icon :icon="showAllStations ? 'solar:filter-outline' : 'solar:map-point-outline'" /> {{ showAllStations ? '只看待處理站' : `查看全市 ${allMappedStations.length} 站` }}</button>
        <button type="button" class="map-reset" aria-label="重設為新北市全域" title="重設為新北市全域" @click="fitNewTaipeiBounds"><Icon icon="solar:map-arrow-left-outline" /> <span class="map-reset-label">新北全域</span></button>
      </div>
    </div>

    <div v-if="stationQuery" class="map-search-results" role="region" aria-label="站點搜尋結果" aria-live="polite">
      <button v-for="station in searchResults" :key="station.id" type="button" @click="chooseSearchResult(station.id)">
        <span><strong>{{ displayStationName(station.name) }}</strong><small>{{ station.district || '新北市' }}</small></span>
        <b>{{ station.availableBikes }} 車／{{ station.availableDocks }} 位</b>
      </button>
      <p v-if="!searchResults.length">找不到符合的站點。</p>
      <p v-else-if="mappedStations.length > searchResults.length">另有 {{ mappedStations.length - searchResults.length }} 站，請輸入更完整的站名或行政區。</p>
    </div>

    <div class="geographic-map" role="region" :aria-label="isLive ? '新北市即時基線風險站點地圖' : '新北市歷史預測風險站點地圖'">
      <div ref="mapElement" class="map-canvas" />
      <p v-if="!mappedStations.length" class="map-empty">目前沒有可定位的站點資料。</p>
    </div>
    <div class="map-caption">
      <p class="map-instruction"><Icon icon="solar:cursor-square-outline" /> 點選站點查看風險與替代還車引導</p>
      <p v-if="baselineNotice" class="baseline-notice" :class="{ 'baseline-notice--warning': hasBaselineLoadError }">
        <Icon :icon="hasBaselineLoadError ? 'solar:danger-triangle-outline' : 'solar:info-circle-outline'" />
        <span>{{ baselineNotice }}</span>
        <button v-if="hasBaselineLoadError" type="button" class="baseline-retry" @click="emit('retryBaseline')"><Icon icon="solar:refresh-circle-outline" /> 重新比對</button>
      </p>
      <div class="geographic-map-legend" aria-label="風險方向圖例">
        <span v-if="showAllStations"><i class="legend-dot normal" />已對照、暫無處理</span>
        <span><i class="legend-dot empty" />補車優先｜無車／缺車風險</span>
        <span><i class="legend-dot full" />移車優先｜無位／缺位風險</span>
        <span><i class="legend-dot unavailable" />服務狀態待確認</span>
        <span v-if="isLive && !hasBaselineLoadError && unmatchedBaselineCount"><i class="legend-dot inventory-only" />僅即時庫存｜未納入預估</span>
      </div>
    </div>
    <p class="map-status-summary"><Icon icon="solar:info-circle-outline" /> {{ mapStatusText }}</p>
  </section>
</template>

<style scoped>
.geographic-map-panel { container-type: inline-size; overflow: hidden; }
.geographic-map {
  position: relative;
  min-height: 440px;
  margin: 0 14px;
  overflow: hidden;
  background: #e3e9e4;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.map-summary {
  display: grid;
  justify-items: end;
  min-width: 126px;
  padding: 7px 10px;
  color: var(--teal-dark);
  background: var(--surface-muted);
  border: 1px solid var(--line-strong, var(--line));
  border-radius: 6px;
  font-weight: 700;
  line-height: 1.15;
}
.map-summary strong { font-size: 22px; }
.map-summary span { color: var(--ink); font-size: 16px; }
.map-summary small { margin-top: 4px; color: var(--muted); font-size: 16px; font-weight: 600; }
.map-summary--warning { color: #9a5d07; }
.map-canvas { width: 100%; min-height: 440px; }
.map-instruction,
.geographic-map-legend,
.baseline-notice,
.map-empty {
  margin: 0;
  color: var(--muted);
  font-size: 16px;
  font-weight: 600;
}

.map-command-row { display: flex; align-items: center; gap: 8px; padding: 0 14px 12px; }
.map-actions { display: flex; align-items: center; gap: 7px; }
.map-instruction {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.map-caption { display: grid; gap: 8px; padding: 11px 18px 0; }
.map-instruction svg { color: var(--teal-dark); font-size: 19px; }
.map-search {
  display: inline-flex;
  flex: 1 1 260px;
  align-items: center;
  gap: 5px;
  min-width: 0;
  min-height: 38px;
  padding: 0 9px;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--line-strong, var(--line));
  border-radius: 5px;
}
.map-search svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 19px; }
.map-search input { width: 100%; min-width: 0; padding: 6px 0; color: inherit; background: transparent; border: 0; outline: 0; font: inherit; }
.map-search input::placeholder { color: var(--muted); opacity: 1; }
.map-search-clear { display: inline-grid; flex: 0 0 auto; width: 30px; height: 30px; place-items: center; padding: 0; color: var(--muted); background: transparent; border: 0; border-radius: 4px; font: inherit; }.map-search-clear:hover, .map-search-clear:focus-visible { color: var(--on-accent); background: var(--teal-dark); outline: 0; }.map-search-clear svg { color: currentColor; font-size: 20px; }
.map-reset, .map-view-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 6px 9px; border-radius: 5px; font: inherit; font-size: 16px; font-weight: 700; cursor: pointer; }
.map-reset { color: var(--on-accent); background: var(--teal-dark); border: 1px solid var(--teal-dark); }
.map-view-toggle { color: var(--teal-dark); background: var(--panel); border: 1px solid var(--line-strong, var(--line)); }
.map-reset:hover, .map-reset:focus-visible { color: var(--on-accent); background: var(--teal); border-color: var(--teal); outline: 3px solid rgba(30, 111, 98, .28); outline-offset: 2px; }
.map-view-toggle:hover, .map-view-toggle:focus-visible { color: var(--ink); border-color: var(--teal-dark); outline: 3px solid rgba(30, 111, 98, .18); outline-offset: 2px; }
.map-search-results { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 0 14px 12px; padding: 8px; background: var(--surface-muted); border: 1px solid var(--line); border-radius: 6px; }
.map-search-results button { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 52px; padding: 8px 10px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 5px; font: inherit; text-align: left; }
.map-search-results button:hover, .map-search-results button:focus-visible { border-color: var(--teal-dark); }
.map-search-results button > span { display: grid; min-width: 0; gap: 2px; }
.map-search-results strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
.map-search-results small { color: var(--muted); font-size: 16px; }
.map-search-results b { flex: 0 0 auto; color: var(--teal-dark); font-family: ui-monospace, Consolas, monospace; font-size: 16px; white-space: nowrap; }
.map-search-results > p { grid-column: 1 / -1; margin: 4px; color: var(--muted); font-size: 16px; text-align: center; }
.geographic-map-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 13px;
}
.geographic-map-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend-dot { width: 10px; height: 10px; border: 1px solid rgba(11, 42, 47, .62); border-radius: 50%; background: #1e6f62; }
.legend-dot.empty { background: #a93a34; }.legend-dot.full { background: #2f648f; }.legend-dot.unavailable { background: #65706b; }.legend-dot.inventory-only { background: #8a5a09; }
.baseline-notice { display: flex; align-items: flex-start; gap: 6px; color: var(--muted); }
.baseline-notice svg { flex: 0 0 auto; margin-top: 1px; color: var(--teal-dark); font-size: 19px; }
.baseline-notice--warning { color: #8b5608; }.baseline-notice--warning svg { color: #9a5d07; }
.baseline-retry { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; min-height: 30px; margin: -3px 0 -3px 4px; padding: 4px 7px; color: var(--teal-dark); background: transparent; border: 1px solid var(--line-strong, var(--line)); border-radius: 5px; font: inherit; font-weight: 700; cursor: pointer; }
.baseline-retry svg { margin: 0; color: currentColor; font-size: 17px; }.baseline-retry:hover, .baseline-retry:focus-visible { color: var(--ink); background: var(--teal-dark); border-color: var(--teal-dark); outline: 3px solid rgba(30, 111, 98, .2); outline-offset: 2px; }
.map-empty { position: absolute; z-index: 500; inset: 50% auto auto 50%; padding: 12px; color: var(--ink); background: var(--panel); border: 1px solid var(--line-strong, var(--line)); border-radius: 6px; font-weight: 700; transform: translate(-50%, -50%); }
.map-status-summary { display: flex; align-items: center; gap: 6px; margin: 10px 18px 14px; color: var(--muted); font-size: 16px; font-weight: 600; }
.map-status-summary svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 19px; }

:global(.geographic-map .leaflet-container) { min-height: 440px; font-family: 'Noto Sans TC', sans-serif; }
:global(.geographic-map .leaflet-control-zoom a) { width: 35px; height: 35px; color: #1d2926; font-size: 25px; line-height: 33px; }
:global(.geographic-map .leaflet-control-attribution) { padding: 3px 6px; color: #35433f; background: rgba(255, 255, 255, .94); font-size: 16px; }
:global(.geographic-map .leaflet-control-attribution a) { color: #15584e; font-weight: 700; }
:global(.geographic-map .leaflet-tooltip) { padding: 8px 10px; color: #1d2926; background: #fff; border: 1px solid #a9b7af; border-radius: 5px; box-shadow: none; font-size: 16px; }
:global(.geographic-map .leaflet-tooltip strong), :global(.geographic-map .leaflet-tooltip span) { display: block; }
:global(.geographic-map .leaflet-tooltip span) { margin-top: 3px; color: #55635f; font-weight: 600; }
:global(html[data-theme='dark'] .geographic-map) { background: #18181b; border-color: var(--line-strong); }
:global(html[data-theme='dark'] .geographic-map .leaflet-tile-pane) { filter: brightness(.66) saturate(.58); }
:global(html[data-theme='dark'] .map-instruction), :global(html[data-theme='dark'] .geographic-map-legend), :global(html[data-theme='dark'] .baseline-notice) { color: var(--muted); }
:global(html[data-theme='dark'] .map-search), :global(html[data-theme='dark'] .map-summary), :global(html[data-theme='dark'] .map-empty) { color: var(--ink); background: var(--panel); border-color: var(--line-strong); box-shadow: none; }
:global(html[data-theme='dark'] .map-summary--warning) { color: #e8ba65; }
:global(html[data-theme='dark'] .baseline-retry) { color: var(--teal); }
:global(html[data-theme='dark'] .map-instruction svg), :global(html[data-theme='dark'] .map-search svg) { color: var(--teal); }
:global(html[data-theme='dark'] .map-search) { color: var(--ink); }
:global(html[data-theme='dark'] .map-search input::placeholder) { color: var(--muted); }
:global(html[data-theme='dark'] .legend-dot) { border-color: #effbf8; }
:global(html[data-theme='dark'] .geographic-map .leaflet-control-zoom a), :global(html[data-theme='dark'] .geographic-map .leaflet-control-attribution) { color: var(--ink); background: var(--panel); border-color: var(--line-strong); }
:global(html[data-theme='dark'] .geographic-map .leaflet-control-attribution a) { color: var(--teal); }
:global(html[data-theme='dark'] .geographic-map .leaflet-tooltip) { color: var(--ink); background: var(--panel); border-color: var(--line-strong); }
:global(html[data-theme='dark'] .geographic-map .leaflet-tooltip span) { color: var(--muted); }

@media (max-width: 1150px) { .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 400px; } }
@container (max-width: 760px) {
  .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 350px; }
  .map-command-row { align-items: stretch; flex-wrap: wrap; }
  .map-search { flex-basis: 100%; }
  .map-actions { width: 100%; }
  .map-actions button { flex: 1 1 0; justify-content: center; }
  .map-search-results { grid-template-columns: 1fr; }
  .map-caption { gap: 7px 12px; padding: 10px 14px 0; }
  .map-status-summary { margin-right: 14px; margin-left: 14px; }
}
@container (max-width: 480px) {
  .geographic-map, .map-canvas, :global(.geographic-map .leaflet-container) { min-height: 320px; }
  .map-heading { display: grid; align-items: start; gap: 10px; }
  .map-summary { width: 100%; min-width: 0; justify-items: start; }
  .map-command-row { padding-right: 10px; padding-left: 10px; }
  .map-actions { display: grid; grid-template-columns: minmax(0, 1fr) 48px; }
  .map-reset, .map-view-toggle { min-height: 44px; padding: 6px 7px; }
  .map-reset-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
  .map-search-results { margin-right: 10px; margin-left: 10px; }
}
</style>
