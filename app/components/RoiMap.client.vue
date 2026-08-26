<script setup lang="ts">
import type { RoiCell, RoiStation } from '~/composables/useOperationalRoi'

export interface RoiMapPoint {
  station: RoiStation
  index: number
  cell: RoiCell | null
}

const props = withDefaults(defineProps<{
  points: RoiMapPoint[]
  selectedId?: string
  metric?: 'emptyRate' | 'fullRate'
}>(), {
  selectedId: '',
  metric: 'emptyRate',
})

const emit = defineEmits<{ select: [stationId: string] }>()

type LeafletModule = typeof import('leaflet')
type LeafletMap = import('leaflet').Map
type LeafletLayerGroup = import('leaflet').LayerGroup

const mapElement = ref<HTMLElement | null>(null)
let leaflet: LeafletModule | null = null
let map: LeafletMap | null = null
let markerLayer: LeafletLayerGroup | null = null

/**
 * A fixed scale rather than one normalised to the visible points, so the same
 * colour always means the same failure rate whichever district is selected.
 */
const BANDS = [
  { limit: 0.02, colour: '#22c55e', label: '< 2%' },
  { limit: 0.05, colour: '#84cc16', label: '2–5%' },
  { limit: 0.10, colour: '#facc15', label: '5–10%' },
  { limit: 0.20, colour: '#fb923c', label: '10–20%' },
  { limit: Number.POSITIVE_INFINITY, colour: '#ef4444', label: '> 20%' },
]

function colourFor(rate: number | null): string {
  if (rate === null) return '#52525b'
  return BANDS.find(band => rate < band.limit)!.colour
}

/** Bigger stations get a bigger dot so capacity is legible alongside the rate. */
function radiusFor(totalDocks: number): number {
  return Math.max(4, Math.min(11, 3 + Math.sqrt(totalDocks)))
}

const mapped = computed(() => props.points.filter(point =>
  Number.isFinite(point.station.latitude) && Number.isFinite(point.station.longitude)))

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

// Refitting on every repaint would throw away the operator's pan and zoom each
// time they change slot or pick a station, so the view is only refitted when
// the set of plotted stations actually changes.
let fittedKey = ''

function render() {
  if (!leaflet || !map || !markerLayer) return
  markerLayer.clearLayers()

  const bounds: [number, number][] = []
  for (const point of mapped.value) {
    const rate = point.cell ? point.cell[props.metric] : null
    const isSelected = point.station.id === props.selectedId
    const marker = leaflet.circleMarker([point.station.latitude, point.station.longitude], {
      radius: isSelected ? radiusFor(point.station.totalDocks) + 4 : radiusFor(point.station.totalDocks),
      color: isSelected ? '#ffffff' : 'rgba(0,0,0,0.45)',
      weight: isSelected ? 3 : 1,
      fillColor: colourFor(rate),
      fillOpacity: 0.85,
    })
    // `.geographic-map .leaflet-tooltip` renders strong/span as blocks, so the
    // markup matches the operations map instead of using <br>.
    marker.bindTooltip(
      `<strong>${point.station.district} ${point.station.name}</strong>`
      + `<span>車柱 ${point.station.totalDocks}</span>`
      + (point.cell
        ? `<span>缺車 ${percent(point.cell.emptyRate)} · 滿柱 ${percent(point.cell.fullRate)}</span>`
          + `<span>平均可借 ${point.cell.meanBikes} · 可還 ${point.cell.meanDocks}</span>`
          + `<span>樣本 ${point.cell.observations.toLocaleString()}</span>`
        : '<span>此時段無觀測</span>'),
      { direction: 'top', opacity: 1 },
    )
    marker.on('click', () => emit('select', point.station.id))
    marker.addTo(markerLayer)
    bounds.push([point.station.latitude, point.station.longitude])
  }

  const key = mapped.value.map(point => point.station.id).join('|')
  if (bounds.length && key !== fittedKey) {
    fittedKey = key
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 })
  }
}

onMounted(async () => {
  leaflet = await import('leaflet')
  if (!mapElement.value) return

  map = leaflet.map(mapElement.value, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  }).setView([25.0106, 121.4626], 11)

  // Same source as the operations map; `.geographic-map` darkens the tiles so
  // the two pages read as one product.
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map)

  markerLayer = leaflet.layerGroup().addTo(map)
  render()
})

onBeforeUnmount(() => {
  map?.remove()
  map = null
  markerLayer = null
})

watch(() => [props.points, props.selectedId, props.metric], () => render(), { deep: false })
</script>

<template>
  <div>
    <!--
      `relative z-0 isolate` keeps Leaflet's own stacking (panes at 400,
      controls at 1000) inside this element. Without it those values compete in
      the root stacking context and paint over the teleported modal pickers.
    -->
    <div
      ref="mapElement"
      class="geographic-map relative z-0 isolate h-104 w-full overflow-hidden rounded-lg border border-line bg-map"
      role="application"
      aria-label="站點統計地圖"
    />
    <div class="mt-2 flex flex-wrap items-center gap-3 text-base text-muted">
      <span class="font-bold">{{ metric === 'emptyRate' ? '缺車率' : '滿柱率' }}</span>
      <span v-for="band in BANDS" :key="band.label" class="inline-flex items-center gap-1.5">
        <span class="inline-block size-3 rounded-full" :style="{ backgroundColor: band.colour }" />
        {{ band.label }}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block size-3 rounded-full" style="background-color: #52525b" /> 無觀測
      </span>
      <span class="ml-auto">圓點大小代表總車柱數 · 共 {{ mapped.length.toLocaleString() }} 站</span>
    </div>
  </div>
</template>
