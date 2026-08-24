<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { safetyStockFor } from '~/shared/live-operations'
import { displayStationName, type DataMode, type HorizonKey, type PredictionCoverage, type StationRisk } from '~/shared/ops'
import {
  clusterNearbyRiskStations,
  stableInventoryTone,
  type StableInventoryTone,
} from '~/shared/risk-map-visuals'

const props = defineProps<{
  stations: StationRisk[]
  horizon: HorizonKey
  selectedId?: string
  dataMode?: DataMode
  district?: string
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
    ? `個${props.district || '全市'}站點`
    : '個需注意站點')
const scopeName = computed(() => props.district || '新北市')
const stationScopeActionLabel = computed(() => showAllStations.value
  ? '只看需注意'
  : `查看全部 ${allMappedStations.value.length} 站`)
const mapAriaLabel = computed(() => `${scopeName.value}${isLive.value ? '即時基線風險站點地圖' : '歷史預測風險站點地圖'}`)
const baselineNotice = computed(() => {
  if (!isLive.value) return ''
  if (hasBaselineLoadError.value) return '歷史基線暫時無法載入，目前只看即時庫存。'
  if (unmatchedBaselineCount.value) return `${unmatchedBaselineCount.value} 站沒有歷史基線，只顯示即時庫存。`
  return ''
})

let leaflet: LeafletModule | null = null
let leafletMap: LeafletMap | null = null
let hotspotLayer: LeafletLayerGroup | null = null
let markerLayer: LeafletLayerGroup | null = null
let hotspotRenderer: LeafletRenderer | null = null
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

const STABLE_MARKER_COLORS: Record<StableInventoryTone, string> = {
  balanced: '#1e6f62',
  'bike-heavy': '#7357c7',
  'dock-heavy': '#1787a0',
}
const MARKER_COLORS: Record<Exclude<MarkerTone, 'stable'>, string> = {
  'empty-risk': '#a93a34',
  'full-risk': '#2f648f',
  'service-review': '#65706b',
  'inventory-only': '#8a5a09',
}
const HOTSPOT_FILL = '#ec4899'
const HOTSPOT_STROKE = '#f472b6'

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

function isInventoryRisk(station: StationRisk) {
  const tone = markerTone(station)
  return tone === 'empty-risk' || tone === 'full-risk'
}

const riskProximityClusters = computed(() => clusterNearbyRiskStations(
  mappedStations.value.filter(isInventoryRisk),
))
const riskClusterSizeByStationId = computed(() => new Map(riskProximityClusters.value.flatMap(
  cluster => cluster.memberIds.map(stationId => [stationId, cluster.memberIds.length] as const),
)))
const hasVisibleStableStations = computed(() => mappedStations.value.some(station => markerTone(station) === 'stable'))
const hasVisibleInventoryOnlyStations = computed(() => mappedStations.value.some(station => markerTone(station) === 'inventory-only'))

function markerColor(station: StationRisk) {
  const tone = markerTone(station)
  return tone === 'stable'
    ? STABLE_MARKER_COLORS[stableInventoryTone(station)]
    : MARKER_COLORS[tone]
}

function stableInventoryStatus(station: StationRisk) {
  const tone = stableInventoryTone(station)
  const capacity = Math.max(1, station.totalDocks)
  if (tone === 'bike-heavy') return `穩定・可借約 ${Math.round(Math.min(1, station.availableBikes / capacity) * 100)}%`
  if (tone === 'dock-heavy') return `穩定・可還約 ${Math.round(Math.min(1, station.availableDocks / capacity) * 100)}%`
  return '穩定・供需均衡'
}

function markerStatus(station: StationRisk) {
  const tone = markerTone(station)
  if (tone === 'service-review') {
    return station.serviceStatus === 'official_inactive'
      ? '官方停用・不排路線'
      : '服務異常・不排路線'
  }
  if (tone === 'inventory-only') return '沒有歷史基線・只看即時庫存'
  if (station.currentState === 'empty_now') return '目前無車可借'
  if (station.currentState === 'full_now') return '目前無位可還'
  if (tone === 'empty-risk') return isLive.value ? '60 分鐘缺車風險' : '預測缺車風險'
  if (tone === 'full-risk') return isLive.value ? '60 分鐘缺位風險' : '預測缺位風險'
  return stableInventoryStatus(station)
}

function interventionGap(station: StationRisk) {
  const forecast = forecastFor(station)
  const buffer = safetyStockFor(station)
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
  const direction = station.currentState === 'empty_now'
    ? '官方即時：目前無車可借'
    : station.currentState === 'full_now'
      ? '官方即時：目前無位可還'
      : tone === 'empty-risk'
        ? `${props.horizon} 分鐘缺車風險 ${Math.round(forecast.emptyRisk * 100)}／100`
        : tone === 'full-risk'
          ? `${props.horizon} 分鐘缺位風險 ${Math.round(forecast.fullRisk * 100)}／100`
          : markerStatus(station)
  const context = forecast.baselineStatus === 'matched' || station.currentState !== 'normal'
    ? direction
    : markerStatus(station)
  const clusterSize = riskClusterSizeByStationId.value.get(station.id) || 0
  const clusterContext = clusterSize > 1
    ? `<span>300 公尺鄰近群組・共 ${clusterSize} 站</span>`
    : ''
  return `<strong>${escapeHtml(displayStationName(station.name))}</strong><span>${escapeHtml(station.district || '新北市')}・${inventory}</span><span>${escapeHtml(context)}</span>${clusterContext}`
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

function renderRiskHotspots() {
  if (!leaflet || !leafletMap || !hotspotLayer || !hotspotRenderer) return
  hotspotLayer.clearLayers()
  for (const cluster of riskProximityClusters.value) {
    leaflet.circle([cluster.latitude, cluster.longitude], {
      renderer: hotspotRenderer,
      pane: 'risk-hotspots',
      radius: cluster.radiusMeters,
      color: HOTSPOT_STROKE,
      weight: 1.25,
      opacity: .46,
      fillColor: HOTSPOT_FILL,
      fillOpacity: .14,
      interactive: false,
      bubblingMouseEvents: false,
    }).addTo(hotspotLayer)
  }
}

function renderMarkers() {
  if (!leaflet || !leafletMap || !markerLayer || !canvasRenderer) return
  renderRiskHotspots()

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

function fitCurrentScope() {
  if (!leaflet || !leafletMap || !allMappedStations.value.length) return
  const points = allMappedStations.value
    .filter(station => station.latitude !== null && station.longitude !== null)
    .map(station => [station.latitude as number, station.longitude as number] as [number, number])
  if (!points.length) return

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  leafletMap.fitBounds(leaflet.latLngBounds(points), {
    animate: !reduceMotion,
    duration: reduceMotion ? 0 : .35,
    maxZoom: props.district ? 14 : 13,
    padding: [28, 28],
  })
}

function toggleStationScope() {
  showAllStations.value = !showAllStations.value
}

function chooseSearchResult(stationId: string) {
  emit('select', stationId)
  stationQuery.value = ''
}

function focusSelectedStation() {
  if (!leafletMap || !props.selectedId) return
  const selected = allMappedStations.value.find(station => station.id === props.selectedId)
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
  leaflet.control.attribution({ position: 'bottomright', prefix: false }).addTo(leafletMap)
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(leafletMap)
  const hotspotPane = leafletMap.createPane('risk-hotspots')
  hotspotPane.style.zIndex = '350'
  hotspotPane.style.pointerEvents = 'none'
  hotspotRenderer = leaflet.canvas({ pane: 'risk-hotspots', padding: .5 })
  canvasRenderer = leaflet.canvas({ padding: .5 })
  hotspotLayer = leaflet.layerGroup().addTo(leafletMap)
  markerLayer = leaflet.layerGroup().addTo(leafletMap)
  fitCurrentScope()
  renderMarkers()

  resizeObserver = new ResizeObserver(() => leafletMap?.invalidateSize({ pan: false }))
  resizeObserver.observe(mapElement.value)
}

const stationSignature = computed(() => `${hasBaselineLoadError.value}|${mappedStations.value
  .map((station) => {
    const forecast = forecastFor(station)
    return `${station.id}:${station.latitude}:${station.longitude}:${station.totalDocks}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.serviceStatus}:${forecast.emptyRisk}:${forecast.fullRisk}:${forecast.predictedBikes}:${forecast.predictedDocks}:${forecast.baselineStatus}`
  })
  .join('|')}`)

watch(stationSignature, () => renderMarkers())
watch(() => props.selectedId, () => {
  if (props.selectedId) stationQuery.value = ''
  renderMarkers()
  focusSelectedStation()
})
watch(() => props.district, async () => {
  stationQuery.value = ''
  await nextTick()
  fitCurrentScope()
})
watch([() => props.dataMode, () => props.horizon], () => renderMarkers())

onMounted(() => { void initialiseMap() })
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  markerById.clear()
  leafletMap?.remove()
  leafletMap = null
  hotspotLayer = null
  hotspotRenderer = null
})
</script>

<template>
  <section class="map-panel geographic-map-panel panel overflow-hidden">
    <div class="map-heading flex items-start justify-between gap-3 px-4 pb-3 pt-4">
      <div>
        <p class="section-kicker"><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:map-point-wave-outline'" /> 站點地圖</p>
        <h2 class="mt-1 text-xl font-bold text-ink">{{ isLive ? `${horizon} 分鐘站況` : `${horizon} 分鐘預測` }}</h2>
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
        <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-base font-bold text-accent-strong transition-colors hover:border-accent-strong hover:bg-panel-muted" :aria-pressed="showAllStations" @click="toggleStationScope"><Icon class="text-lg" :icon="showAllStations ? 'solar:filter-outline' : 'solar:map-point-outline'" /> {{ stationScopeActionLabel }}</button>
        <button type="button" class="map-reset inline-flex min-h-11 items-center gap-1.5 rounded-md border border-accent-strong bg-accent-strong px-2.5 py-1.5 text-base font-bold text-on-accent transition-colors hover:border-accent hover:bg-accent" :aria-label="`重新對焦${district || '新北市全域'}`" :title="`重新對焦${district || '新北市全域'}`" @click="fitCurrentScope"><Icon class="text-lg" icon="solar:map-arrow-left-outline" /> <span class="map-reset-label">重新對焦</span></button>
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

    <div class="geographic-map map-height relative z-0 isolate mx-3.5 min-h-112 overflow-hidden rounded-lg border border-line bg-map" role="region" :aria-label="mapAriaLabel">
      <div ref="mapElement" class="map-canvas map-height min-h-112 w-full" />
      <p v-if="!mappedStations.length" class="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-3 text-base font-bold text-ink">目前沒有可定位的站點資料。</p>
    </div>
    <div class="map-caption grid gap-2 px-4 pt-3">
      <p class="inline-flex items-center gap-1.5 text-base font-semibold text-muted"><Icon class="text-xl text-accent-strong" icon="solar:cursor-square-outline" /> 點選站點查看詳情</p>
      <p v-if="baselineNotice" class="flex flex-wrap items-start gap-1.5 text-base font-semibold" :class="hasBaselineLoadError ? 'text-warning' : 'text-muted'">
        <Icon class="mt-0.5 shrink-0 text-xl" :class="hasBaselineLoadError ? 'text-warning' : 'text-accent-strong'" :icon="hasBaselineLoadError ? 'solar:danger-triangle-outline' : 'solar:info-circle-outline'" />
        <span>{{ baselineNotice }}</span>
        <button v-if="hasBaselineLoadError" type="button" class="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong bg-transparent px-2 py-1 text-base font-bold text-accent-strong transition-colors hover:border-accent-strong hover:bg-panel-muted hover:text-ink" @click="emit('retryBaseline')"><Icon class="text-lg" icon="solar:refresh-circle-outline" /> 重新比對</button>
      </p>
      <div class="flex flex-wrap gap-x-3 gap-y-1.5 text-base font-semibold text-muted" aria-label="風險方向圖例">
        <span v-if="riskProximityClusters.length" class="inline-flex items-center gap-1.5"><i class="h-3 w-5 shrink-0 rounded-full border" :style="{ backgroundColor: `${HOTSPOT_FILL}24`, borderColor: HOTSPOT_STROKE }" />粉紅底｜300 公尺鄰近群</span>
        <template v-if="hasVisibleStableStations">
          <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: STABLE_MARKER_COLORS.balanced }" />綠｜穩定均衡</span>
          <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: STABLE_MARKER_COLORS['bike-heavy'] }" />紫｜可借 ≥ 2/3</span>
          <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: STABLE_MARKER_COLORS['dock-heavy'] }" />藍綠｜可還 ≥ 2/3</span>
        </template>
        <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: MARKER_COLORS['empty-risk'] }" />紅｜缺車風險</span>
        <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: MARKER_COLORS['full-risk'] }" />藍｜缺位風險</span>
        <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: MARKER_COLORS['service-review'] }" />灰｜服務異常</span>
        <span v-if="isLive && !hasBaselineLoadError && hasVisibleInventoryOnlyStations" class="inline-flex min-w-0 items-center gap-1.5 leading-snug"><i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong" :style="{ backgroundColor: MARKER_COLORS['inventory-only'] }" />黃｜沒有基線</span>
      </div>
    </div>
    <div class="h-4" aria-hidden="true" />
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
