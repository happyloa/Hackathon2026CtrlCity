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

const isLive = computed(() => props.dataMode === 'live')
const mappedStations = computed(() => props.stations.filter(station => station.latitude !== null && station.longitude !== null))
const bounds = computed(() => {
  const latitudes = mappedStations.value.map(station => station.latitude as number)
  const longitudes = mappedStations.value.map(station => station.longitude as number)
  return {
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLng: Math.min(...longitudes),
    maxLng: Math.max(...longitudes),
  }
})

function clamp(value: number) {
  return Math.max(3, Math.min(97, value))
}

function coordinates(station: StationRisk) {
  const { minLat, maxLat, minLng, maxLng } = bounds.value
  const latitude = station.latitude || minLat
  const longitude = station.longitude || minLng
  const x = ((longitude - minLng) / Math.max(maxLng - minLng, 0.0001)) * 100
  const y = 100 - ((latitude - minLat) / Math.max(maxLat - minLat, 0.0001)) * 100
  return { left: `${clamp(x)}%`, top: `${clamp(y)}%` }
}

function markerTone(station: StationRisk) {
  if (station.currentState === 'unavailable') return 'unavailable'
  if (isLive.value) {
    if (station.currentState === 'empty_now') return 'empty'
    if (station.currentState === 'full_now') return 'full'
    return 'normal'
  }
  if (station.currentState === 'empty_now' || station.currentState === 'full_now') return 'critical'
  return station.forecast.horizons[props.horizon].level
}

function markerLabel(station: StationRisk) {
  if (!isLive.value) return `${station.name}，${station.forecast.horizons[props.horizon].level} 風險`
  const state = station.currentState === 'empty_now'
    ? '目前無車可借'
    : station.currentState === 'full_now'
      ? '目前無位可還'
      : station.currentState === 'unavailable'
        ? '暫停或無資料'
        : `可借 ${station.availableBikes} 車、可還 ${station.availableDocks} 位`
  return `${station.name}，${state}`
}

const riskCount = computed(() => isLive.value
  ? mappedStations.value.filter(station => station.currentState !== 'normal').length
  : mappedStations.value.filter(station => ['high', 'critical'].includes(markerTone(station))).length)
</script>

<template>
  <section class="panel map-panel" :class="{ 'live-map-panel': isLive }">
    <div class="panel-heading map-heading">
      <div>
        <p class="section-kicker"><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:map-point-wave-outline'" /> {{ isLive ? '即時站況地圖' : '空間風險圖' }}</p>
        <h2>{{ isLive ? '官方資料的目前庫存分布' : `下一個 ${horizon} 分鐘的庫存風險` }}</h2>
      </div>
      <span class="risk-summary"><b>{{ riskCount }}</b> {{ isLive ? '站需要留意' : '站優先處理' }}</span>
    </div>

    <div class="risk-map" role="region" :aria-label="isLive ? '新北市各站點即時庫存分布圖' : '新北市各站點庫存風險分布圖'">
      <div class="map-water map-water-a" />
      <div class="map-water map-water-b" />
      <div class="map-grid-lines" />
      <span class="district-label label-danshui">淡水</span>
      <span class="district-label label-banqiao">板橋</span>
      <span class="district-label label-xindian">新店</span>
      <span class="district-label label-sanchong">三重</span>
      <button
        v-for="station in mappedStations"
        :key="station.id"
        class="station-marker"
        :class="[`marker-${markerTone(station)}`, { selected: station.id === selectedId }]"
        :style="coordinates(station)"
        type="button"
        :aria-label="markerLabel(station)"
        @click="emit('select', station.id)"
      >
        <span />
      </button>

      <div v-if="isLive" class="map-legend" aria-label="即時站況圖例">
        <span><i class="legend-dot normal" />正常</span>
        <span><i class="legend-dot empty" />無車可借</span>
        <span><i class="legend-dot full" />無位可還</span>
        <span><i class="legend-dot unavailable" />暫停</span>
      </div>
      <div v-else class="map-legend" aria-label="風險圖例">
        <span><i class="legend-dot normal" />穩定</span>
        <span><i class="legend-dot medium" />觀察</span>
        <span><i class="legend-dot high" />高風險</span>
        <span><i class="legend-dot critical" />立即處理</span>
      </div>
    </div>
  </section>
</template>
