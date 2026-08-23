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
      ? '官方標示停用（不納入調度）'
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
  <section class="map-panel geographic-map-panel panel overflow-hidden">
    <div class="map-heading flex items-start justify-between gap-3 px-4 pb-3 pt-4">
      <div>
        <p class="section-kicker"><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:map-point-wave-outline'" /> 站點地圖</p>
        <h2 class="mt-1 text-xl font-bold text-ink">{{ isLive ? `${horizon} 分鐘待處理站點` : `${horizon} 分鐘預測風險分布` }}</h2>
      </div>
      <div class="map-summary grid min-w-32 justify-items-end rounded-lg border border-line-strong bg-panel-muted px-2.5 py-2 font-bold leading-tight" :class="hasBaselineLoadError ? 'text-warning' : 'text-accent-strong'">
        <strong>{{ headerCount }}</strong>
        <span class="text-base text-ink">{{ headerLabel }}</span>
        <small v-if="isLive" class="mt-1 text-base font-semibold text-muted">{{ hasBaselineLoadError ? '基線暫不可用' : (profileCoverage ? `已對照 ${profileCoverage.matchedStations}／${profileCoverage.liveStations}` : '正在載入基線') }}</small>
      </div>
    </div>

    <div class="map-command-row flex items-center gap-2 px-3.5 pb-3" role="group" aria-label="地圖工具">
      <div class="map-search flex min-h-10 min-w-0 flex-1 basis-64 items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 text-ink" role="search">
        <Icon class="shrink-0 text-xl text-accent-strong" icon="solar:magnifer-outline" />
        <input v-model="stationQuery" class="min-w-0 w-full bg-transparent py-1.5 text-base text-ink outline-none placeholder:text-muted" type="text" inputmode="search" enterkeyhint="search" placeholder="搜尋站名或行政區" aria-label="搜尋站名或行政區" />
        <button v-if="stationQuery" class="grid h-8 w-8 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-accent-strong hover:text-on-accent" type="button" aria-label="清除站點搜尋" @click="stationQuery = ''"><Icon class="text-xl" icon="solar:close-circle-outline" /></button>
      </div>
      <div class="map-actions flex items-center gap-2">
        <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-base font-bold text-accent-strong transition-colors hover:border-accent-strong hover:bg-panel-muted" :aria-pressed="showAllStations" @click="toggleStationScope"><Icon class="text-lg" :icon="showAllStations ? 'solar:filter-outline' : 'solar:map-point-outline'" /> {{ showAllStations ? '只看待處理站' : `查看全市 ${allMappedStations.length} 站` }}</button>
        <button type="button" class="map-reset inline-flex min-h-11 items-center gap-1.5 rounded-md border border-accent-strong bg-accent-strong px-2.5 py-1.5 text-base font-bold text-on-accent transition-colors hover:border-accent hover:bg-accent" aria-label="重設為新北市全域" title="重設為新北市全域" @click="fitNewTaipeiBounds"><Icon class="text-lg" icon="solar:map-arrow-left-outline" /> <span class="map-reset-label">新北全域</span></button>
      </div>
    </div>

    <div v-if="stationQuery" class="map-search-results mx-3.5 mb-3 grid grid-cols-2 gap-1.5 rounded-lg border border-line bg-panel-muted p-2" role="region" aria-label="站點搜尋結果" aria-live="polite">
      <button v-for="station in searchResults" :key="station.id" class="flex min-h-13 items-center justify-between gap-2 rounded-md border border-line bg-panel px-2.5 py-2 text-left text-base text-ink transition-colors hover:border-accent-strong hover:bg-surface" type="button" @click="chooseSearchResult(station.id)">
        <span class="grid min-w-0 gap-0.5"><strong class="truncate">{{ displayStationName(station.name) }}</strong><small class="text-base text-muted">{{ station.district || '新北市' }}</small></span>
        <b class="shrink-0 whitespace-nowrap font-mono text-base text-accent-strong">{{ station.availableBikes }} 車／{{ station.availableDocks }} 位</b>
      </button>
      <p v-if="!searchResults.length" class="col-span-full m-1 text-center text-base text-muted">找不到符合的站點。</p>
      <p v-else-if="mappedStations.length > searchResults.length" class="col-span-full m-1 text-center text-base text-muted">另有 {{ mappedStations.length - searchResults.length }} 站，請輸入更完整的站名或行政區。</p>
    </div>

    <div class="geographic-map map-height relative z-0 isolate mx-3.5 min-h-112 overflow-hidden rounded-lg border border-line bg-map" role="region" :aria-label="isLive ? '新北市即時基線風險站點地圖' : '新北市歷史預測風險站點地圖'">
      <div ref="mapElement" class="map-canvas map-height min-h-112 w-full" />
      <p v-if="!mappedStations.length" class="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-3 text-base font-bold text-ink">目前沒有可定位的站點資料。</p>
    </div>
    <div class="map-caption grid gap-2 px-4 pt-3">
      <p class="inline-flex items-center gap-1.5 text-base font-semibold text-muted"><Icon class="text-xl text-accent-strong" icon="solar:cursor-square-outline" /> 點選站點查看風險與替代還車引導</p>
      <p v-if="baselineNotice" class="flex flex-wrap items-start gap-1.5 text-base font-semibold" :class="hasBaselineLoadError ? 'text-warning' : 'text-muted'">
        <Icon class="mt-0.5 shrink-0 text-xl" :class="hasBaselineLoadError ? 'text-warning' : 'text-accent-strong'" :icon="hasBaselineLoadError ? 'solar:danger-triangle-outline' : 'solar:info-circle-outline'" />
        <span>{{ baselineNotice }}</span>
        <button v-if="hasBaselineLoadError" type="button" class="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong bg-transparent px-2 py-1 text-base font-bold text-accent-strong transition-colors hover:border-accent-strong hover:bg-panel-muted hover:text-ink" @click="emit('retryBaseline')"><Icon class="text-lg" icon="solar:refresh-circle-outline" /> 重新比對</button>
      </p>
      <div class="flex flex-wrap gap-x-3 gap-y-1.5 text-base font-semibold text-muted" aria-label="風險方向圖例">
        <span v-if="showAllStations" class="inline-flex items-center gap-1.5 whitespace-nowrap"><i class="h-2.5 w-2.5 rounded-full border border-line-strong bg-accent" />已對照、暫無處理</span>
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap"><i class="h-2.5 w-2.5 rounded-full border border-line-strong bg-danger" />補車優先｜無車／缺車風險</span>
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap"><i class="h-2.5 w-2.5 rounded-full border border-line-strong bg-info" />移車優先｜無位／缺位風險</span>
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap"><i class="h-2.5 w-2.5 rounded-full border border-line-strong bg-muted" />{{ isLive ? '官方停用／服務待確認｜不納入調度' : '服務狀態待確認' }}</span>
        <span v-if="isLive && !hasBaselineLoadError && unmatchedBaselineCount" class="inline-flex items-center gap-1.5 whitespace-nowrap"><i class="h-2.5 w-2.5 rounded-full border border-line-strong bg-warning" />僅即時庫存｜未納入預估</span>
      </div>
    </div>
    <p class="map-status-summary mx-4 mb-4 mt-2.5 flex items-center gap-1.5 text-base font-semibold text-muted"><Icon class="shrink-0 text-xl text-accent-strong" icon="solar:info-circle-outline" /> {{ mapStatusText }}</p>
  </section>
</template>

<style scoped>
 .geographic-map-panel { container-type: inline-size; }

@container (max-width: 760px) {
  .map-height { min-height: 22rem; }
  .map-command-row { align-items: stretch; flex-wrap: wrap; }
  .map-search { flex-basis: 100%; }
  .map-actions { width: 100%; }
  .map-actions > button { flex: 1 1 0; justify-content: center; }
  .map-search-results { grid-template-columns: 1fr; }
  .map-caption { gap: 0.5rem 0.75rem; padding: 0.625rem 0.875rem 0; }
  .map-status-summary { margin-right: 0.875rem; margin-left: 0.875rem; }
}
@container (max-width: 480px) {
  .map-height { min-height: 20rem; }
  .map-heading { display: grid; align-items: start; gap: 10px; }
  .map-summary { width: 100%; min-width: 0; justify-items: start; }
  .map-command-row { padding-right: 0.625rem; padding-left: 0.625rem; }
  .map-actions { display: grid; grid-template-columns: minmax(0, 1fr) 3rem; }
  .map-actions > button { min-height: 2.75rem; padding: 0.375rem 0.4375rem; }
  .map-reset-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
  .map-search-results { margin-right: 0.625rem; margin-left: 0.625rem; }
}
</style>
