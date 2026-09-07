<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { MapPinSearch } from '@lucide/vue'
import { stationSeverityFor, type SeverityLevel } from '~/shared/operational-policy.mjs'
import { displayStationName, type DataMode, type HorizonKey, type PredictionCoverage, type StationRisk } from '~/shared/ops'
import type { DispatchRouteStop, DispatchRouteStopAction } from '~/shared/dispatch-route-planner'
// font-gis's icon-font CSS mangles its `content: "\eb1d"` glyph codepoints
// somewhere in Vite's dev-time CSS-to-JS transform (verified: the parsed
// CSSOM rule ends up with an empty `content`), so the package is used via
// its SVG sprite instead -- same icon, no CSS unicode-escape involved.
import fontGisSprite from 'font-gis/dist/font-gis.svg?url'

const props = defineProps<{
  stations: StationRisk[]
  horizon: HorizonKey
  selectedId?: string
  dataMode?: DataMode
  district?: string
  /** Passing these renders the district picker above the search box (see index.vue). */
  districtOptions?: { value: string, label: string }[]
  districtSelectionSource?: string
  districtLocationMessage?: string
  profileCoverage?: PredictionCoverage | null
  profileError?: string
  /** The currently "observed" dispatch route's stops, drawn as coloured pins on top of everything else. */
  routeStops?: DispatchRouteStop[] | null
}>()

const emit = defineEmits<{ select: [stationId: string], retryBaseline: [], 'update:district': [district: string] }>()

type LeafletModule = typeof import('leaflet')
type LeafletMap = import('leaflet').Map
type LeafletMouseEvent = import('leaflet').LeafletMouseEvent

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
    : '  個需注意站點')
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
let overlay: HTMLCanvasElement | null = null
let resizeObserver: ResizeObserver | null = null
let redrawFrame = 0
const hoveredStationId = ref<string | null>(null)
const hoverPoint = ref<{ x: number, y: number } | null>(null)
const selectedStationPoint = ref<{ x: number, y: number } | null>(null)
const routeStopPoints = ref<{ x: number, y: number, stop: DispatchRouteStop }[]>([])
const hoveredRouteStationId = ref<string | null>(null)

// 薄荷綠 for pickup, 珊瑚紅 for dropoff -- matches RouteCard's pickup/dropoff
// colouring so the map and the route summary agree on what each colour means.
// "mixed" (a station serves both, whether in one visit or across two) gets
// its own colour rather than silently reusing one of the two.
const ROUTE_STOP_TEXT_CLASS: Record<DispatchRouteStopAction, string> = {
  pickup: 'text-[#3ecf8e]',
  dropoff: 'text-[#ff6f61]',
  mixed: 'text-[#a78bfa]',
}

interface RouteStopMarker {
  stationId: string
  x: number
  y: number
  action: DispatchRouteStopAction
  stops: DispatchRouteStop[]
}

/**
 * The heuristic planner inserts one dispatch at a time and never reorders
 * stops already placed, so it can send the vehicle back to a station it
 * already visited (see dispatch-route-planner.ts's docstring) -- typically
 * because the bikes being dropped off there weren't picked up yet at the
 * time of the earlier visit. Two stop entries at the same coordinate would
 * otherwise render as two pins stacked exactly on top of each other, which
 * reads as one stop and hides that a second trip is happening; grouping by
 * station and labelling every sequence number together keeps that visible.
 */
const routeStopMarkers = computed(() => {
  const byStation = new globalThis.Map<string, RouteStopMarker>()
  for (const entry of routeStopPoints.value) {
    const existing = byStation.get(entry.stop.stationId)
    if (existing) {
      existing.stops.push(entry.stop)
      if (existing.action !== entry.stop.action) existing.action = 'mixed'
    } else {
      byStation.set(entry.stop.stationId, {
        stationId: entry.stop.stationId,
        x: entry.x,
        y: entry.y,
        action: entry.stop.action,
        stops: [entry.stop],
      })
    }
  }
  return [...byStation.values()]
})

const hoveredRouteStopMarker = computed(() => hoveredRouteStationId.value
  ? routeStopMarkers.value.find(marker => marker.stationId === hoveredRouteStationId.value) ?? null
  : null)

function routeStopMarkerLabel(marker: RouteStopMarker) {
  return `路線第 ${marker.stops.map(stop => stop.sequence).join('、')} 站：${marker.stops[0]?.stationName ?? ''}`
}

function routeStopMarkerName(marker: RouteStopMarker) {
  return marker.stops[0]?.stationName ?? ''
}

function routeStopMarkerBikes(marker: RouteStopMarker, field: 'pickupBikes' | 'dropoffBikes') {
  return marker.stops.reduce((total, stop) => total + stop[field], 0)
}

// Stops are already in visiting order (see buildDispatchRoutePlans), so a
// polyline through them in the same order is the actual driving path -- if
// the route revisits a station later on, the line will too, on purpose.
const routeLinePoints = computed(() => routeStopPoints.value.map(entry => `${entry.x},${entry.y}`).join(' '))

function forecastFor(station: StationRisk) {
  return station.forecast.horizons[props.horizon]
}

/**
 * The map's severity colour never depends on the forecast horizon -- it is
 * judged purely by current available bikes/docks, same as everywhere else
 * severity is decided (shared/operational-policy). The `horizon` prop only
 * affects the baseline-coverage caption above the map.
 */
function severityFor(station: StationRisk) {
  return stationSeverityFor(station)
}

function isActionable(station: StationRisk) {
  return severityFor(station) !== 'normal'
}

// ── Neighbour-group expansion ────────────────────────────────────────────
//
// Clicking a blob answers "this area is served by which stations", distinct
// from the colour blending above (see "鄰近群不是著色單位" in CONTEXT.md).
// This is a direct, non-transitive radius query around the click's actual
// geographic point -- every operational station within NEIGHBOUR_GROUP_RADIUS_METERS
// of *that point*, not a chain of overlapping station-to-station neighbourhoods
// (which, transitively, could sprawl to a hundred-plus stations across a dense
// area and stop meaning "this area").
const NEIGHBOUR_GROUP_RADIUS_METERS = 500

const clickedGroupPoint = ref<{ x: number, y: number } | null>(null)
const clickedGroupMemberIds = ref<globalThis.Set<string> | null>(null)
const clickedGroupStations = computed(() => {
  const members = clickedGroupMemberIds.value
  if (!members) return []
  return allMappedStations.value.filter(station => members.has(station.id))
})

function closeClickedGroup() {
  clickedGroupPoint.value = null
  clickedGroupMemberIds.value = null
}

function selectFromClickedGroup(stationId: string) {
  emit('select', stationId)
  closeClickedGroup()
}

// ── Soft-blend overlay ───────────────────────────────────────────────────
//
// Stations are painted individually onto a canvas overlaid on the Leaflet
// map; the "neighbourhood" a dispatcher reads is whatever emerges from the
// overlap of those soft-edged blobs, not a precomputed shape (see the
// "鄰近群不是著色單位" entry in CONTEXT.md). Leaflet itself only supplies the
// basemap tiles and screen-coordinate conversion.
//
// Parameters below come from the throwaway prototype at commit 6e52619,
// validated against the full 1,526-station dataset -- see
// .scratch/dispatch-homepage-redesign/issues/02-map-soft-blend-rendering.md.

const BLEND_RADIUS_METERS = 500
const BASE_LAYER_PEAK_ALPHA = 0.10

// ── Station markers ──────────────────────────────────────────────────────
//
// The blend layer answers "which area is struggling"; it was never meant to
// answer "which dot is which station" (see "站點標記" in CONTEXT.md, and
// docs/adr/0001-station-markers-above-zoom-threshold.md for why this exists
// alongside the blend instead of replacing it). Below a district-level zoom
// the ~1,600 stations would still overlap into unreadable clutter -- the same
// density problem the blend was built to avoid -- so markers only appear once
// zoomed in far enough to see them apart. Tune the threshold by changing
// MARKER_MIN_ZOOM.
const MARKER_MIN_ZOOM = 13
const MARKER_RADIUS_PIXELS = 6

type Severity = SeverityLevel

const SEVERITY_RGB: Record<Severity, [number, number, number]> = {
  service_disruption: [156, 163, 175],
  full: [34, 211, 238],
  empty: [239, 68, 68],
  near_empty: [249, 115, 22],
  low: [234, 179, 8],
  normal: [34, 197, 94],
}

// Light-to-dark paint order: later entries cover earlier ones, so empty
// (red) is always drawn last and never gets buried under a lighter colour.
const UPPER_LAYER_ORDER: Exclude<Severity, 'normal'>[] = ['service_disruption', 'low', 'full', 'near_empty', 'empty']
const UPPER_LAYER_PEAK_ALPHA: Record<Exclude<Severity, 'normal'>, number> = {
  service_disruption: 0.22,
  low: 0.20,
  full: 0.36,
  near_empty: 0.36,
  empty: 0.36,
}

const SEVERITY_LEGEND: { severity: Severity, label: string }[] = [
  { severity: 'service_disruption', label: '服務異常' },
  { severity: 'full', label: '滿柱・可還車位 0' },
  { severity: 'empty', label: '完全缺車・可借車數 0' },
  { severity: 'near_empty', label: '近端缺車・可借車數 < 2' },
  { severity: 'low', label: '偏低・低於總車格一半' },
  { severity: 'normal', label: '正常' },
]

function metersPerPixel(latitude: number, zoom: number) {
  return (156543.03392 * Math.cos(latitude * Math.PI / 180)) / 2 ** zoom
}

/** A soft-edged circle: full colour at the centre, fading to transparent at the radius. */
function paintBlob(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rgb: [number, number, number], peakAlpha: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  const [red, green, blue] = rgb
  gradient.addColorStop(0, `rgba(${red},${green},${blue},${peakAlpha})`)
  gradient.addColorStop(0.55, `rgba(${red},${green},${blue},${peakAlpha * 0.5})`)
  gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

/** A small solid dot marking one station's exact location, coloured by severity. */
function paintMarker(ctx: CanvasRenderingContext2D, x: number, y: number, rgb: [number, number, number]) {
  const [red, green, blue] = rgb
  ctx.beginPath()
  ctx.arc(x, y, MARKER_RADIUS_PIXELS, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(${red},${green},${blue},0.5)`
  ctx.fill()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = `rgb(${red},${green},${blue})`
  ctx.stroke()
}

// The last frame's projected stations, reused for hover/click hit-testing so
// pointer handlers don't reproject the whole visible set on every mousemove.
let lastVisible: { station: StationRisk, severity: Severity, x: number, y: number }[] = []
let lastRadiusPixels = 0
const HIT_TEST_TOLERANCE_PIXELS = 14

function stationAt(point: { x: number, y: number }) {
  let nearest: (typeof lastVisible)[number] | null = null
  let nearestDistance = HIT_TEST_TOLERANCE_PIXELS
  for (const entry of lastVisible) {
    const distance = Math.hypot(entry.x - point.x, entry.y - point.y)
    if (distance <= nearestDistance) {
      nearestDistance = distance
      nearest = entry
    }
  }
  return nearest
}

/**
 * Leaflet zooms by CSS-transforming its own tile/marker panes smoothly over
 * ~250ms, then snapping everything to exact pixel positions once the
 * animation settles (`zoomend`). Our canvas is redrawn only on that final
 * snap, computed at the target zoom -- so without this handler it would
 * jump to the new (correct) content immediately, then sit still while the
 * basemap keeps visibly animating underneath it, reading as a static mask
 * stuck on top for the remaining ~250ms. This mirrors the same "CSS
 * transform the raster during the animation, redraw crisply once it ends"
 * pattern Leaflet's own image/tile layers use, computed here with only
 * public Map APIs (`project`/`getSize`/`getZoomScale`) since the canvas
 * stays outside Leaflet's own panes -- it draws in container-point space,
 * not layer-point space, so it can be redrawn correctly on every pan frame
 * without needing pane-relative positioning.
 */
function onZoomAnim(event: import('leaflet').ZoomAnimEvent) {
  if (!leafletMap || !overlay) return
  const map = leafletMap
  const topLeftLatLng = map.containerPointToLatLng([0, 0])
  const scale = map.getZoomScale(event.zoom, map.getZoom())
  const targetCenterPixel = map.project(event.center, event.zoom)
  const referencePointPixel = map.project(topLeftLatLng, event.zoom)
  const newTopLeft = referencePointPixel.subtract(targetCenterPixel).add(map.getSize().divideBy(2))
  overlay.style.transition = 'transform 0.25s cubic-bezier(0,0,0.25,1)'
  overlay.style.transform = `translate3d(${newTopLeft.x}px, ${newTopLeft.y}px, 0) scale(${scale})`
}

function redrawOverlay() {
  if (!leafletMap || !overlay) return
  const map = leafletMap
  overlay.style.transition = 'none'
  overlay.style.transform = 'none'
  // While a route is being observed, or a station is selected (its
  // `MapPinSearch` pin drawn above the canvas), fade the severity blend so
  // it doesn't fight what's drawn on top of it for contrast -- but station
  // markers stay at full strength, since they're identity/location, not
  // decorative colour. That rules out a single CSS `opacity` on the whole
  // canvas (it would dim `paintMarker`'s pixels along with `paintBlob`'s);
  // instead the fade is applied per-call, only to blob alpha, below. Reads
  // `props.selectedId` rather than `selectedStationPoint` -- that ref is
  // only assigned later in this same function, so reading it here would lag
  // a frame behind the prop that actually just changed.
  overlay.style.opacity = '1'
  const blendFade = props.routeStops?.length || props.selectedId ? 0.45 : 1
  const size = map.getSize()
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)

  if (overlay.width !== size.x * devicePixelRatio || overlay.height !== size.y * devicePixelRatio) {
    overlay.width = size.x * devicePixelRatio
    overlay.height = size.y * devicePixelRatio
    overlay.style.width = `${size.x}px`
    overlay.style.height = `${size.y}px`
  }

  const ctx = overlay.getContext('2d')
  if (!ctx) return
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ctx.clearRect(0, 0, size.x, size.y)

  const radiusPixels = BLEND_RADIUS_METERS / metersPerPixel(map.getCenter().lat, map.getZoom())
  lastRadiusPixels = radiusPixels
  if (radiusPixels < 1) return

  // Only project stations near the viewport (padded by one radius) -- with
  // 1,526 stations, projecting the whole dataset every frame is wasted work.
  const pad = radiusPixels + 4
  const visible: { station: StationRisk, severity: Severity, x: number, y: number }[] = []
  for (const station of allMappedStations.value) {
    const point = map.latLngToContainerPoint([station.latitude as number, station.longitude as number])
    if (point.x < -pad || point.y < -pad || point.x > size.x + pad || point.y > size.y + pad) continue
    visible.push({ station, severity: severityFor(station), x: point.x, y: point.y })
  }
  lastVisible = visible

  ctx.globalCompositeOperation = 'source-over'

  // Base layer: every operational station gets exactly one green blob, so a
  // dense-but-healthy district never reads as more severe than a sparse one.
  for (const entry of visible) {
    if (entry.severity === 'service_disruption') continue
    paintBlob(ctx, entry.x, entry.y, radiusPixels, SEVERITY_RGB.normal, BASE_LAYER_PEAK_ALPHA * blendFade)
  }

  // Upper layers: grouped by severity, painted light-to-dark.
  const grouped = new globalThis.Map<Exclude<Severity, 'normal'>, { x: number, y: number }[]>()
  for (const entry of visible) {
    if (entry.severity === 'normal') continue
    const list = grouped.get(entry.severity) ?? []
    list.push({ x: entry.x, y: entry.y })
    grouped.set(entry.severity, list)
  }
  for (const severity of UPPER_LAYER_ORDER) {
    const list = grouped.get(severity)
    if (!list) continue
    const peakAlpha = UPPER_LAYER_PEAK_ALPHA[severity] * blendFade
    for (const point of list) paintBlob(ctx, point.x, point.y, radiusPixels, SEVERITY_RGB[severity], peakAlpha)
  }

  // Station markers: only once zoomed in past MARKER_MIN_ZOOM, drawn on top
  // of every blend layer so they stay visible regardless of what's underneath.
  if (map.getZoom() >= MARKER_MIN_ZOOM) {
    for (const entry of visible) paintMarker(ctx, entry.x, entry.y, SEVERITY_RGB[entry.severity])
  }

  // The selected-station indicator is a DOM pin (see the template), not a
  // canvas shape, so it can use a real icon; this just tracks where it goes.
  const selected = props.selectedId ? visible.find(entry => entry.station.id === props.selectedId) : undefined
  selectedStationPoint.value = selected ? { x: selected.x, y: selected.y } : null

  // The observed route's stops are DOM pins too (see the template), computed
  // independently of the padded `visible` list above so a stop just off-screen
  // still gets a real (if unseen) position rather than being dropped.
  routeStopPoints.value = (props.routeStops ?? []).flatMap((stop) => {
    const station = props.stations.find(candidate => candidate.id === stop.stationId)
    if (!station || station.latitude === null || station.longitude === null) return []
    const point = map.latLngToContainerPoint([station.latitude, station.longitude])
    return [{ x: point.x, y: point.y, stop }]
  })
}

// Leaflet's `_move()` -- called synchronously right when a zoom animation
// starts, already carrying the *target* zoom/center -- fires plain 'move'
// and 'zoom' events immediately, a full ~250ms before the animation Leaflet
// itself is running actually finishes. Letting those trigger a hard redraw
// snapped the overlay to the target content one frame in, undoing
// `onZoomAnim`'s transform after a single frame -- a visible flash of
// content in the wrong (untransformed-then-briefly-transformed) place.
// Suppressing redraws between 'zoomstart' and 'zoomend' leaves `onZoomAnim`
// as the only thing moving the overlay during the animation.
let isZoomAnimating = false

function scheduleRedraw() {
  if (isZoomAnimating) return
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  redrawFrame = requestAnimationFrame(() => {
    redrawFrame = 0
    redrawOverlay()
  })
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
    maxZoom: props.district ? 13 : 12,
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

const hoveredStation = computed(() => hoveredStationId.value
  ? allMappedStations.value.find(station => station.id === hoveredStationId.value) ?? null
  : null)
function severityLabelFor(station: StationRisk) {
  return SEVERITY_LEGEND.find(entry => entry.severity === severityFor(station))?.label ?? ''
}
const hoveredSeverityLabel = computed(() => hoveredStation.value ? severityLabelFor(hoveredStation.value) : '')

// The overlay canvas is `pointer-events: none` so panning/zooming keeps
// hitting Leaflet's own layers underneath; hover and click are handled here
// off Leaflet's own mouse events instead, hit-tested against the blend
// layer's last-painted station positions.
function onMapPointerMove(event: LeafletMouseEvent) {
  const hit = stationAt(event.containerPoint)
  hoveredStationId.value = hit?.station.id ?? null
  hoverPoint.value = hit ? { x: event.containerPoint.x, y: event.containerPoint.y } : null
  if (mapElement.value) mapElement.value.style.cursor = hit ? 'pointer' : ''
}

function onMapPointerLeave() {
  hoveredStationId.value = null
  hoverPoint.value = null
}

function onMapClick(event: LeafletMouseEvent) {
  const point = event.containerPoint
  // Below MARKER_MIN_ZOOM there's no visible marker to click precisely on --
  // the blob radius and the hover hit-tolerance are close in size at that
  // zoom, so treating every click as "the precise station" would make the
  // neighbour-group popup below unreachable. Only trust a precise hit once
  // the marker it's supposed to represent actually exists on screen.
  const showingMarkers = Boolean(leafletMap && leafletMap.getZoom() >= MARKER_MIN_ZOOM)
  const hit = showingMarkers ? stationAt(point) : null
  if (hit) {
    // A precise hit is the station marker itself -- that's an unambiguous
    // "I want this one station", so it wins outright instead of also opening
    // the broader neighbour-group popup underneath it.
    emit('select', hit.station.id)
    closeClickedGroup()
    return
  }

  // Anything within the blend radius of a station's blob counts as "clicked
  // that blob", which is a much larger target than the precise dot above.
  // Service-disrupted stations aren't offering service, so a click on their
  // grey blob shouldn't open the area popup at all.
  const covering = lastRadiusPixels > 0
    ? lastVisible.some(entry => entry.severity !== 'service_disruption'
      && Math.hypot(entry.x - point.x, entry.y - point.y) <= lastRadiusPixels)
    : false
  if (!covering || !leafletMap) {
    closeClickedGroup()
    return
  }

  const clickLatLng = leafletMap.containerPointToLatLng(point)
  const memberIds = new globalThis.Set<string>()
  for (const station of allMappedStations.value) {
    if (station.serviceStatus !== 'operational') continue
    if (clickLatLng.distanceTo([station.latitude!, station.longitude!]) <= NEIGHBOUR_GROUP_RADIUS_METERS) {
      memberIds.add(station.id)
    }
  }
  clickedGroupMemberIds.value = memberIds
  clickedGroupPoint.value = { x: point.x, y: point.y }
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
    scrollWheelZoom: true,
    zoomControl: true,
    minZoom: 11,
    maxZoom: 18,
  })
  leaflet.control.attribution({ position: 'bottomright', prefix: false }).addTo(leafletMap)
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(leafletMap)

  overlay = document.createElement('canvas')
  overlay.style.position = 'absolute'
  overlay.style.inset = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = '450'
  mapElement.value.appendChild(overlay)
  leafletMap.on('move zoom resize moveend', scheduleRedraw)
  leafletMap.on('zoomanim', onZoomAnim)
  leafletMap.on('zoomstart', () => { isZoomAnimating = true })
  leafletMap.on('zoomend', () => {
    isZoomAnimating = false
    scheduleRedraw()
  })
  leafletMap.on('mousemove', onMapPointerMove)
  leafletMap.on('mouseout', onMapPointerLeave)
  leafletMap.on('click', onMapClick)
  leafletMap.on('movestart zoomstart', closeClickedGroup)

  fitCurrentScope()
  scheduleRedraw()
  // A station picked before this component ever mounted (e.g. the warning
  // cart's ?station= deep link from another page) sets `selectedId` at
  // creation time, so the `watch(selectedId, ...)` below never fires for it
  // -- watchers only react to *changes*, not the starting value.
  focusSelectedStation()

  resizeObserver = new ResizeObserver(() => {
    leafletMap?.invalidateSize({ pan: false })
    scheduleRedraw()
  })
  resizeObserver.observe(mapElement.value)
}

const stationSignature = computed(() => `${hasBaselineLoadError.value}|${props.selectedId}|${allMappedStations.value
  .map(station => `${station.id}:${station.latitude}:${station.longitude}:${station.totalDocks}:${station.availableBikes}:${station.availableDocks}:${station.serviceStatus}`)
  .join('|')}`)

watch(stationSignature, () => scheduleRedraw())
watch(() => props.routeStops, () => scheduleRedraw())
watch(() => props.selectedId, () => {
  if (props.selectedId) stationQuery.value = ''
  focusSelectedStation()
})
watch(() => props.district, async () => {
  stationQuery.value = ''
  closeClickedGroup()
  await nextTick()
  fitCurrentScope()
})

onMounted(() => { void initialiseMap() })
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (redrawFrame) cancelAnimationFrame(redrawFrame)
  leafletMap?.remove()
  leafletMap = null
  overlay = null
  lastVisible = []
  selectedStationPoint.value = null
  routeStopPoints.value = []
  hoveredRouteStationId.value = null
  closeClickedGroup()
})
</script>

<template>
  <section class="map-panel geographic-map-panel panel overflow-hidden">
    <div class="map-heading flex items-start justify-between gap-3 px-4 pb-3 pt-4">
      <div>
        <p class="section-kicker text-xl">
          站點地圖
        </p>
        <h2 class="mt-1 text-xl font-bold text-ink">{{ isLive ? `${horizon} 分鐘站況` : `${horizon} 分鐘預測` }}</h2>
      </div>
      <div
        class="map-summary grid min-w-32 justify-items-end rounded-lg border border-line-strong bg-panel-muted px-2.5 py-2 font-bold leading-tight"
        :class="hasBaselineLoadError ? 'text-warning' : 'text-accent-strong'">
        <strong>{{ headerCount }} <span class="ms-2 text-base text-ink">{{ headerLabel }}</span></strong>

        <small v-if="isLive" class="mt-1 text-base font-semibold text-muted">{{ hasBaselineLoadError ? '基線暫不可用' :
          (profileCoverage ? `已對照 ${profileCoverage.matchedStations}／${profileCoverage.liveStations}` : '正在載入基線')
          }}</small>
      </div>
    </div>

    <div v-if="districtOptions" class="px-3.5 pb-3">
      <ModalPicker :model-value="district || ''" @update:model-value="emit('update:district', $event)"
        :label="districtSelectionSource === 'location' ? '行政區（依位置）' : '行政區'" title="選擇行政區" :options="districtOptions" />
      <span class="sr-only" role="status" aria-live="polite">{{ districtLocationMessage }}</span>
    </div>

    <div class="map-command-row flex items-center gap-2 px-3.5 pb-3" role="group" aria-label="地圖工具">
      <div
        class="map-search flex min-h-10 min-w-0 flex-1 basis-64 items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 text-ink"
        role="search">
        <Icon class="shrink-0 text-xl text-accent-strong" icon="solar:magnifer-outline" />
        <input v-model="stationQuery"
          class="min-w-0 w-full bg-transparent py-1.5 text-base text-ink outline-none placeholder:text-muted"
          type="text" inputmode="search" enterkeyhint="search" placeholder="搜尋站名或行政區" aria-label="搜尋站名或行政區" />
        <button v-if="stationQuery"
          class="grid h-8 w-8 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-accent-strong hover:text-on-accent"
          type="button" aria-label="清除站點搜尋" @click="stationQuery = ''">
          <Icon class="text-xl" icon="solar:close-circle-outline" />
        </button>
      </div>
      <div class="map-actions flex items-center gap-2">
        <!-- <button type="button"
          class="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-base font-bold text-accent-strong transition-colors hover:border-accent-strong hover:bg-panel-muted"
          :aria-pressed="showAllStations" @click="toggleStationScope">
          <Icon class="text-lg" :icon="showAllStations ? 'solar:filter-outline' : 'solar:map-point-outline'" /> {{
            stationScopeActionLabel }}
        </button> -->
        <button type="button"
          class="map-reset inline-flex min-h-11 items-center gap-1.5 rounded-md border border-accent-strong bg-accent-strong px-2.5 py-1.5 text-base font-bold text-on-accent transition-colors hover:border-accent hover:bg-accent"
          :aria-label="`重新對焦${district || '新北市全域'}`" :title="`重新對焦${district || '新北市全域'}`" @click="fitCurrentScope">
          <Icon class="text-lg" icon="solar:map-arrow-left-outline" /> <span class="map-reset-label">重新對焦</span>
        </button>
      </div>
    </div>

    <div v-if="stationQuery"
      class="map-search-results mx-3.5 mb-3 grid grid-cols-2 gap-1.5 rounded-lg border border-line bg-panel-muted p-2"
      role="region" aria-label="站點搜尋結果" aria-live="polite">
      <button v-for="station in searchResults" :key="station.id"
        class="flex min-h-13 items-center justify-between gap-2 rounded-md border border-line bg-panel px-2.5 py-2 text-left text-base text-ink transition-colors hover:border-accent-strong hover:bg-surface"
        type="button" @click="chooseSearchResult(station.id)">
        <span class="grid min-w-0 gap-0.5"><strong class="truncate">{{ displayStationName(station.name)
            }}</strong><small class="text-base text-muted">{{ station.district || '新北市' }}</small></span>
        <b class="shrink-0 whitespace-nowrap font-mono text-base text-accent-strong">{{ station.availableBikes }} 車／{{
          station.availableDocks }} 位</b>
      </button>
      <p v-if="!searchResults.length" class="col-span-full m-1 text-center text-base text-muted">找不到符合的站點。</p>
      <p v-else-if="mappedStations.length > searchResults.length"
        class="col-span-full m-1 text-center text-base text-muted">另有 {{ mappedStations.length - searchResults.length }}
        站，請輸入更完整的站名或行政區。</p>
    </div>

    <div
      class="geographic-map map-height relative z-0 isolate mx-3.5 min-h-240 overflow-hidden rounded-lg border border-line bg-map"
      role="region" :aria-label="mapAriaLabel">
      <div ref="mapElement" class="map-canvas map-height min-h-240 w-full" />

      <svg v-if="routeStopPoints.length > 1" class="map-route-line pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true">
        <polyline :points="routeLinePoints" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round"
          stroke-linejoin="round" />
      </svg>
      <MapPinSearch v-if="selectedStationPoint" class="map-selected-pin pointer-events-none absolute text-sky-500"
        :style="{ left: `${selectedStationPoint.x}px`, top: `${selectedStationPoint.y}px` }" :size="40"
        :stroke-width="2" aria-hidden="true" />
      <div v-for="marker in routeStopMarkers" :key="marker.stationId"
        class="map-route-stop-marker absolute cursor-pointer" :style="{ left: `${marker.x}px`, top: `${marker.y}px` }"
        role="img" :aria-label="routeStopMarkerLabel(marker)" @mouseenter="hoveredRouteStationId = marker.stationId"
        @mouseleave="hoveredRouteStationId = null" @click.stop="emit('select', marker.stationId)">
        <svg class="map-route-stop-pin block" :class="ROUTE_STOP_TEXT_CLASS[marker.action]" width="32" height="32">
          <use :href="`${fontGisSprite}#fg-location-poi`" />
        </svg>
        <!-- Always visible, not just on hover: a station visited twice in one
             route (see routeStopMarkers) would otherwise show as a single pin
             with no sign that stop 3 and stop 6 are the same place. -->
        <span
          class="map-route-stop-badge absolute rounded-full bg-[#111827] px-1 font-mono text-[11px] font-bold leading-[1.4] text-white">{{
            marker.stops.map(stop => stop.sequence).join('・')}}</span>
      </div>
      <div v-if="hoveredRouteStopMarker"
        class="map-route-stop-pill pointer-events-none absolute flex items-center gap-1.5 rounded-full border border-line-strong bg-panel px-3 py-1.5 text-base leading-none text-ink shadow-lg"
        :style="{ left: `${hoveredRouteStopMarker.x}px`, top: `${hoveredRouteStopMarker.y}px` }">
        <span
          class="grid size-5 shrink-0 place-items-center rounded-full bg-accent font-mono text-[11px] font-bold text-on-accent">{{
            hoveredRouteStopMarker.stops.map(stop => stop.sequence).join('・')}}</span>
        <strong class="truncate">{{ routeStopMarkerName(hoveredRouteStopMarker) }}</strong>
        <span class="whitespace-nowrap text-muted">
          <template v-if="routeStopMarkerBikes(hoveredRouteStopMarker, 'pickupBikes')">取 {{
            routeStopMarkerBikes(hoveredRouteStopMarker, 'pickupBikes') }} 台</template>
          <template
            v-if="routeStopMarkerBikes(hoveredRouteStopMarker, 'pickupBikes') && routeStopMarkerBikes(hoveredRouteStopMarker, 'dropoffBikes')">／</template>
          <template v-if="routeStopMarkerBikes(hoveredRouteStopMarker, 'dropoffBikes')">卸 {{
            routeStopMarkerBikes(hoveredRouteStopMarker, 'dropoffBikes') }} 台</template>
        </span>
      </div>
      <div v-if="hoveredStation && hoverPoint"
        class="map-hover-card pointer-events-none absolute grid gap-0.5 rounded-md border border-line-strong bg-panel px-2.5 py-2 text-base leading-snug text-ink shadow-lg"
        :style="{ left: `${hoverPoint.x}px`, top: `${hoverPoint.y}px` }">
        <strong class="truncate">{{ displayStationName(hoveredStation.name) }}</strong>
        <span class="text-muted">{{ hoveredStation.district || '新北市' }}・可借 {{ hoveredStation.availableBikes }}・可還 {{
          hoveredStation.availableDocks }}</span>
        <span class="text-muted">{{ hoveredSeverityLabel }}</span>
      </div>
      <div v-if="clickedGroupPoint && clickedGroupStations.length"
        class="map-group-card absolute grid max-w-72 gap-1.5 rounded-lg border border-line-strong bg-panel p-3 text-base leading-snug text-ink shadow-lg"
        :style="{ left: `${clickedGroupPoint.x}px`, top: `${clickedGroupPoint.y}px` }" @click.stop>
        <div class="flex items-start justify-between gap-2">
          <strong>這一帶由 {{ clickedGroupStations.length }} 站服務</strong>
          <button type="button"
            class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-accent-strong hover:text-on-accent"
            aria-label="關閉鄰近群清單" @click="closeClickedGroup">
            <Icon class="text-lg" icon="solar:close-circle-outline" />
          </button>
        </div>
        <ul class="grid max-h-56 gap-1 overflow-y-auto">
          <li v-for="station in clickedGroupStations" :key="station.id">
            <button type="button"
              class="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-panel-muted"
              @click="selectFromClickedGroup(station.id)">
              <span class="grid min-w-0 gap-0.5"><strong class="truncate">{{ displayStationName(station.name)
                  }}</strong>
                <small class="text-muted">{{ station.district || '新北市' }}・{{ severityLabelFor(station) }}</small></span>
              <b class="shrink-0 whitespace-nowrap font-mono text-accent-strong">{{ station.availableBikes }} 車</b>
            </button>
          </li>
        </ul>
      </div>
      <p v-if="!allMappedStations.length"
        class="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-3 text-base font-bold text-ink">
        目前沒有可定位的站點資料。</p>
    </div>
    <div class="map-caption grid gap-2 px-4 pt-3">
      <!-- <p class="inline-flex items-center gap-1.5 text-base font-semibold text-muted">
        <Icon class="text-xl text-accent-strong" icon="solar:info-circle-outline" />
        綠底代表有服務涵蓋，顏色越深表示越需要處置；放大到街道層級會看到逐站標記，點選標記查看該站資料；點選色斑其餘範圍會展開該處鄰近群的站點清單
      </p> -->
      <p v-if="baselineNotice" class="flex flex-wrap items-start gap-1.5 text-base font-semibold"
        :class="hasBaselineLoadError ? 'text-warning' : 'text-muted'">
        <Icon class="mt-0.5 shrink-0 text-xl" :class="hasBaselineLoadError ? 'text-warning' : 'text-accent-strong'"
          :icon="hasBaselineLoadError ? 'solar:danger-triangle-outline' : 'solar:info-circle-outline'" />
        <span>{{ baselineNotice }}</span>
        <button v-if="hasBaselineLoadError" type="button"
          class="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong bg-transparent px-2 py-1 text-base font-bold text-accent-strong transition-colors hover:border-accent-strong hover:bg-panel-muted hover:text-ink"
          @click="emit('retryBaseline')">
          <Icon class="text-lg" icon="solar:refresh-circle-outline" /> 重新比對
        </button>
      </p>
      <div v-if="routeStops && routeStops.length"
        class="flex flex-wrap gap-x-3 gap-y-1.5 text-base font-semibold text-muted" aria-label="路線觀察圖例">
        <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug">
          <i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong"
            style="background-color: #3ecf8e" />取車：薄荷綠
        </span>
        <span class="inline-flex min-w-0 items-center gap-1.5 leading-snug">
          <i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong"
            style="background-color: #ff6f61" />卸車：珊瑚紅
        </span>
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1.5 text-base font-semibold text-muted" aria-label="嚴重度圖例">
        <span v-for="entry in SEVERITY_LEGEND" :key="entry.severity"
          class="inline-flex min-w-0 items-center gap-1.5 leading-snug">
          <i class="h-2.5 w-2.5 shrink-0 rounded-full border border-line-strong"
            :style="{ backgroundColor: `rgb(${SEVERITY_RGB[entry.severity].join(',')})` }" />{{ entry.label }}
        </span>
      </div>
    </div>
    <div class="h-4" aria-hidden="true" />
  </section>
</template>

<style scoped>
.geographic-map-panel {
  container-type: inline-size;
}

/*
 * `.map-canvas`'s children (the blend/marker canvas, appended in
 * initialiseMap, inline style `zIndex: '450'`) and everything below share one
 * stacking context with `.geographic-map`'s other direct children -- Leaflet's
 * container is `position: relative` but never sets its own z-index, so it
 * doesn't start a new context. That means every DOM overlay below needs a
 * z-index above 450 or the canvas paints over it (pointer events still pass
 * through, since the canvas is `pointer-events: none`, so this only breaks
 * what's visible, not what's clickable). Only enough headroom to clear that
 * 450 and stay ordered among ourselves -- nothing here needs to fend off
 * Leaflet's own controls (z-index 1000, see the same note in
 * RoiMap.client.vue), so there is no reason to reach for a large number.
 */
.map-route-line,
.map-selected-pin,
.map-route-stop-marker {
  /* The line and the pins tie on purpose: DOM order (line first) puts the
     pins on top of the line's endpoints without needing a separate tier. */
  z-index: 451;
}

.map-hover-card,
.map-route-stop-pill {
  /* Tooltips read above a pin, not equal to it. */
  z-index: 452;
}

.map-group-card {
  /* The one overlay that can take focus (buttons, a scrollable list), so it
     wins over a passive tooltip if both ever end up stacked. */
  z-index: 453;
}

.map-hover-card {
  max-width: 14rem;
  transform: translate(-50%, calc(-100% - 12px));
}

.map-group-card {
  transform: translate(-50%, calc(-100% - 12px));
}

.map-selected-pin {
  /* Anchors the pin's point (near the bottom of its viewBox) at the
     station's coordinate, the same way a Leaflet marker icon does. */
  transform: translate(-50%, -96%);
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
}

.map-route-stop-marker {
  transform: translate(-50%, -96%);
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
}

.map-route-stop-badge {
  top: -4px;
  right: -6px;
  padding-inline: 0.25rem;
  white-space: nowrap;
}

.map-route-stop-pill {
  max-width: 16rem;
  transform: translate(-50%, calc(-100% - 32px));
}

@container (max-width: 760px) {
  .map-height {
    min-height: 48rem;
  }

  .map-command-row {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .map-search {
    flex-basis: 100%;
  }

  .map-actions {
    width: 100%;
  }

  .map-actions>button {
    flex: 1 1 0;
    justify-content: center;
  }

  .map-search-results {
    grid-template-columns: 1fr;
  }

  .map-caption {
    gap: 0.5rem 0.75rem;
    padding: 0.625rem 0.875rem 0;
  }

  .map-status-summary {
    margin-right: 0.875rem;
    margin-left: 0.875rem;
  }
}

@container (max-width: 480px) {
  .map-height {
    min-height: 36rem;
  }

  .map-heading {
    display: grid;
    align-items: start;
    gap: 10px;
  }

  .map-summary {
    width: 100%;
    min-width: 0;
    justify-items: start;
  }

  .map-command-row {
    padding-right: 0.625rem;
    padding-left: 0.625rem;
  }

  .map-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 3rem;
  }

  .map-actions>button {
    min-height: 2.75rem;
    padding: 0.375rem 0.4375rem;
  }

  .map-reset-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }

  .map-search-results {
    margin-right: 0.625rem;
    margin-left: 0.625rem;
  }
}
</style>
