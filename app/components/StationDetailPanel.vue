<script setup lang="ts">
import { ArrowLeft, ArrowRight, Bike, ChartNoAxesColumn, CheckCheck, Info, MapPin, MapPinned, Share, X, Zap } from '@lucide/vue'
import { nearbyBorrowStations, nearbyReturnStations } from '~/shared/nearby-stations'
import { displayStationName, type DataMode, type HorizonKey, type StationHistoryPoint, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  station: StationRisk | null
  stations: StationRisk[]
  history: StationHistoryPoint[]
  horizon: HorizonKey
  dataMode?: DataMode
  contextQuery?: Record<string, string>
  docked?: boolean
}>()

const emit = defineEmits<{ close: []; select: [stationId: string] }>()

const panelRef = ref<HTMLElement | null>(null)
let previousBodyOverflow = ''
let returnFocusElement: HTMLElement | null = null
let pageScrollLocked = false
let viewportQuery: MediaQueryList | null = null
const isWideViewport = ref(import.meta.client && window.matchMedia('(min-width: 1101px)').matches)
const isDocked = computed(() => Boolean(props.docked) && isWideViewport.value)

function syncViewport(event: MediaQueryListEvent) {
  isWideViewport.value = event.matches
}

function setPageScrollLocked(locked: boolean) {
  if (locked === pageScrollLocked) return
  if (locked) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = previousBodyOverflow
  }
  pageScrollLocked = locked
}

/**
 * The panel always reads the 30-minute horizon regardless of what the
 * caller passes -- the homepage/map's `horizon` prop stays at 60 minutes
 * for `RiskMap`, but this drawer's own forecast reads should not follow
 * that. The prediction source (rule baseline vs. XGBoost) is unaffected;
 * that stays whatever `usePredictionMode` has selected.
 */
const detailHorizon: HorizonKey = '30'

const isLive = computed(() => props.dataMode === 'live')
const stationName = computed(() => displayStationName(props.station?.name || ''))
const forecast = computed(() => props.station?.forecast.horizons[detailHorizon])
const hasMatchedBaseline = computed(() => forecast.value?.baselineStatus === 'matched')
const riskLabel = computed(() => {
  const serviceStatus = props.station?.serviceStatus
  if (serviceStatus === 'official_inactive') return '官方標示停用'
  if (serviceStatus === 'suspected_unavailable') return '疑似異常'
  if (isLive.value) {
    const state = props.station?.currentState
    if (state === 'empty_now') return '目前無車'
    if (state === 'full_now') return '目前無位'
    if (forecast.value?.baselineStatus !== 'matched') return '僅即時庫存'
  }
  return ({ normal: '穩定', medium: '留意', high: '高風險', critical: '高度風險' }[forecast.value?.level || 'normal'])
})

/**
 * Solid pill fill: each semantic color's `-surface` token is that same
 * color's dark/light counterpart in the opposite theme (see `useTheme.ts`
 * and the `:root[data-theme="light"]` block), so pairing `bg-x`/`text-x-surface`
 * stays readable in both themes without a separate "on-x" token.
 */
const riskBadgeClass = computed(() => {
  if (props.station?.serviceStatus !== 'operational') {
    return 'inline-flex rounded-full bg-panel-muted px-2.5 py-0.5 text-base font-bold text-muted'
  }
  if (isLive.value && !hasMatchedBaseline.value) {
    return 'inline-flex rounded-full bg-warning px-2.5 py-0.5 text-base font-bold text-warning-surface'
  }
  if (forecast.value?.level === 'critical') {
    return 'inline-flex rounded-full bg-danger px-2.5 py-0.5 text-base font-bold text-danger-surface'
  }
  if (forecast.value?.level === 'high' || forecast.value?.level === 'medium') {
    return 'inline-flex rounded-full bg-warning px-2.5 py-0.5 text-base font-bold text-warning-surface'
  }
  return 'inline-flex rounded-full bg-positive px-2.5 py-0.5 text-base font-bold text-positive-surface'
})

const totalDockCount = computed(() => props.station?.totalDocks || 0)
const availableBikeCount = computed(() => props.station?.availableBikes || 0)

const donut = computed(() => {
  const total = Math.max(1, totalDockCount.value)
  const bikes = Math.min(availableBikeCount.value, total)
  const radius = 58
  const circumference = 2 * Math.PI * radius
  const bikeLength = (bikes / total) * circumference
  return { radius, circumference, bikeLength, dockLength: circumference - bikeLength }
})

const forecastHeadline = computed(() => {
  if (!isLive.value) return `${detailHorizon} 分鐘後`
  if (props.station?.serviceStatus === 'official_inactive') return '官方標示停用，不納入調度'
  if (props.station?.serviceStatus !== 'operational') return '服務狀態異常'
  if (!hasMatchedBaseline.value) return '未對照歷史基線'
  return `${detailHorizon} 分鐘歷史基線推估`
})

const forecastDescription = computed(() => {
  if (!isLive.value) return `預測 ${forecast.value?.predictedBikes} 車／${forecast.value?.predictedDocks} 位`
  if (props.station?.serviceStatus !== 'operational') return `現況 ${props.station?.availableBikes} 車／${props.station?.availableDocks} 位`
  if (!hasMatchedBaseline.value) return `現況 ${props.station?.availableBikes} 車／${props.station?.availableDocks} 位`
  return `推估 ${forecast.value?.predictedBikes} 車／${forecast.value?.predictedDocks} 位`
})

const forecastCaption = computed(() => {
  if (props.station?.serviceStatus === 'official_inactive') {
    return '官方標示停用，不納入預測與路線。'
  }
  if (props.station?.serviceStatus !== 'operational') return '請查看官方公告或現場狀態。'
  if (isLive.value && !hasMatchedBaseline.value) return '找不到可用的歷史資料，目前只顯示即時庫存。'
  const score = Math.round((forecast.value?.riskScore || 0) * 100)
  const sample = forecast.value?.sampleSize || 0
  const coverage = forecast.value?.baselineCoverage === 'sufficient' ? '歷史樣本充足' : '歷史樣本較少'
  return `風險 ${score}／100 · ${coverage} · ${sample} 筆樣本`
})

const baselineComparison = computed(() => {
  const value = forecast.value
  if (!isLive.value || !hasMatchedBaseline.value || !value || value.baselineBikes === null || value.baselineDocks === null) return null

  const differences = [
    { label: '可借車', value: value.predictedBikes - value.baselineBikes, unit: '台' },
    { label: '可還位', value: value.predictedDocks - value.baselineDocks, unit: '位' },
  ]
    .filter(item => item.value !== 0)
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))

  const primary = differences[0]
  const delta = primary
    ? `${detailHorizon} 分鐘推估${primary.value < 0 ? '低於' : '高於'}歷史基線 ${Math.abs(primary.value)} ${primary.unit}。`
    : `${detailHorizon} 分鐘推估與歷史基線接近。`

  return {
    baselineBikes: value.baselineBikes,
    baselineDocks: value.baselineDocks,
    predictedBikes: value.predictedBikes,
    predictedDocks: value.predictedDocks,
    sampleSize: value.sampleSize,
    score: Math.round(value.riskScore * 100),
    delta,
  }
})

const chartProjections = computed(() => {
  const station = props.station
  if (!station) return []
  return (['30', '60'] as HorizonKey[]).map((item) => {
    const value = station.forecast.horizons[item]
    return { label: `+${item}m`, bikes: value.predictedBikes, docks: value.predictedDocks }
  })
})
const needsReturnGuidance = computed(() => {
  const station = props.station
  const stationForecast = forecast.value
  return station?.serviceStatus === 'operational'
    && Boolean(stationForecast)
    && (station.currentState === 'full_now' || (stationForecast?.fullRisk || 0) >= (stationForecast?.alertThreshold || 1))
})
const returnStations = computed(() => {
  const station = props.station
  return station ? nearbyReturnStations(station, props.stations, detailHorizon) : []
})
const needsBorrowGuidance = computed(() => {
  const station = props.station
  const stationForecast = forecast.value
  return station?.serviceStatus === 'operational'
    && Boolean(stationForecast)
    && (station.currentState === 'empty_now' || (stationForecast?.emptyRisk || 0) >= (stationForecast?.alertThreshold || 1))
})
const borrowStations = computed(() => {
  const station = props.station
  return station ? nearbyBorrowStations(station, props.stations, detailHorizon) : []
})
const detailTarget = computed(() => ({
  path: `/stations/${props.station?.id || ''}`,
  query: props.contextQuery || {},
}))

function closePanel() {
  emit('close')
}

function onPanelKeydown(event: KeyboardEvent) {
  if (!props.station) return
  if (event.key !== 'Escape') return
  event.preventDefault()
  closePanel()
}

watch([() => props.station?.id, isDocked], ([stationId, docked], previousValues) => {
  if (!import.meta.client) return
  const previousId = previousValues?.[0]
  if (stationId && !previousId) {
    returnFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  setPageScrollLocked(Boolean(stationId) && !docked)
  if (stationId) void nextTick(() => {
    if (panelRef.value) {
      if (stationId !== previousId) panelRef.value.scrollTop = 0
      panelRef.value.focus({ preventScroll: !docked })
    }
  })
  if (!stationId && previousId) {
    void nextTick(() => returnFocusElement?.focus())
  }
}, { immediate: true })

onMounted(() => {
  viewportQuery = window.matchMedia('(min-width: 1101px)')
  isWideViewport.value = viewportQuery.matches
  viewportQuery.addEventListener('change', syncViewport)
  document.addEventListener('keydown', onPanelKeydown)
})
onBeforeUnmount(() => {
  viewportQuery?.removeEventListener('change', syncViewport)
  document.removeEventListener('keydown', onPanelKeydown)
  if (import.meta.client) setPageScrollLocked(false)
})
</script>

<template>
  <Teleport to="body" :disabled="isDocked">
    <Transition name="detail-drawer">
      <div v-if="station"
        class="station-detail-layer pointer-events-none fixed inset-0 z-50 flex min-h-0 items-end justify-end p-3 sm:items-stretch sm:p-0"
        :class="{ 'station-detail-layer--docked': isDocked, 'station-detail-layer--adaptive': docked }">
        <aside ref="panelRef"
          class="station-detail pointer-events-auto max-h-full w-full overflow-y-auto rounded-xl border border-line bg-panel p-4 pb-6 text-ink shadow-2xl outline-none sm:h-svh sm:max-w-lg sm:rounded-none sm:border-y-0 sm:border-r-0 sm:p-5"
          role="dialog" aria-modal="false" aria-labelledby="station-detail-title" tabindex="-1">
          <button type="button"
            class="mb-3 inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-line bg-panel-muted px-3 text-sm font-semibold text-ink transition-colors hover:border-accent-strong hover:bg-accent-strong hover:text-on-accent"
            :aria-label="isDocked ? '返回搬運路線' : '關閉站點詳情'" @click="closePanel">
            <ArrowLeft v-if="isDocked" style="width: 1em; height: 1em" class="text-xl" aria-hidden="true" />
            <X v-else style="width: 1em; height: 1em" class="text-xl" aria-hidden="true" />
            <span v-if="docked">{{ isDocked ? '返回搬運路線' : '關閉站點詳情' }}</span>
          </button>
          <div class="flex flex-wrap items-center justify-between gap-2 text-base font-bold text-muted"><span>{{ isLive
            ? '即時站況' : '歷史站況' }}</span><span :class="riskBadgeClass">{{ riskLabel }}</span></div>
          <h3 id="station-detail-title" class="mt-2 text-2xl font-bold tracking-tight text-ink">{{ stationName }}</h3>
          <p class="mt-1 flex items-center gap-1 text-base text-muted">
            <MapPin class="size-4 shrink-0 text-accent-strong" :stroke-width="2" /> {{ station.district ||
              '行政區未提供' }} · {{ station.city }}
          </p>

          <div class="mt-4 flex flex-col items-center gap-3 rounded-md border border-line bg-panel-muted p-4">
            <svg class="size-36" viewBox="0 0 140 140" role="img"
              :aria-label="`可借車 ${station.availableBikes} 台，可還位 ${station.availableDocks} 位，總車柱 ${station.totalDocks}`">
              <circle cx="70" cy="70" :r="donut.radius" fill="none" class="stroke-panel" stroke-width="14" />
              <circle cx="70" cy="70" :r="donut.radius" fill="none" class="stroke-accent" stroke-width="14"
                stroke-linecap="round" :stroke-dasharray="`${donut.bikeLength} ${donut.circumference}`"
                transform="rotate(-90 70 70)" />
              <circle cx="70" cy="70" :r="donut.radius" fill="none" class="stroke-danger" stroke-width="14"
                stroke-linecap="round" :stroke-dasharray="`${donut.dockLength} ${donut.circumference}`"
                :stroke-dashoffset="-donut.bikeLength" transform="rotate(-90 70 70)" />
              <text x="70" y="66" text-anchor="middle" class="fill-ink text-3xl font-extrabold">{{
                station.availableBikes }}</text>
              <text x="70" y="88" text-anchor="middle" class="fill-muted text-sm font-semibold">{{
                station.availableBikes }} 車／{{ station.totalDocks }} 位</text>
            </svg>
            <div class="grid w-full grid-cols-2 gap-2 text-center">
              <div><span class="text-base font-bold text-muted">可借車</span><strong
                  class="block font-mono text-xl text-accent">{{ station.availableBikes }}</strong></div>
              <div><span class="text-base font-bold text-muted">可還位</span><strong
                  class="block font-mono text-xl text-danger">{{ station.availableDocks }}</strong></div>
            </div>
          </div>

          <DisclosurePanel v-if="totalDockCount > 0" class="mt-3 rounded-md border border-line"
            title="車柱狀態" :description="`共 ${totalDockCount} 格`">
            <div class="grid grid-cols-4 gap-1.5 p-3 sm:grid-cols-6">
              <span v-for="slot in totalDockCount" :key="slot" class="grid place-items-center rounded-md p-1.5"
                :class="slot <= availableBikeCount ? 'bg-positive-surface text-positive' : 'bg-panel text-danger'">
                <Bike v-if="slot <= availableBikeCount" class="size-5" :stroke-width="2" />
                <Share v-else class="size-5" :stroke-width="2" />
              </span>
            </div>
          </DisclosurePanel>

          <StationPopularityChart :station="station" />

          <DisclosurePanel v-if="baselineComparison"
            class="mt-3 rounded-md border border-line border-l-4 border-l-accent-strong"
            :title="`${detailHorizon} 分鐘預估`"
            :description="`風險 ${baselineComparison.score}／100 · ${baselineComparison.sampleSize} 筆`">
            <div class="p-3">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div class="grid min-w-0 gap-0.5 rounded-md border border-line bg-panel p-2"><span
                    class="text-base font-bold text-muted">現在</span><strong
                    class="font-mono text-base leading-5 text-ink">{{ station.availableBikes }} 車／{{
                      station.availableDocks }} 位</strong></div>
                <div class="grid min-w-0 gap-0.5 rounded-md border border-line bg-panel p-2"><span
                    class="text-base font-bold text-muted">歷史基線</span><strong
                    class="font-mono text-base leading-5 text-ink">{{ baselineComparison.baselineBikes }} 車／{{
                      baselineComparison.baselineDocks }} 位</strong></div>
                <div class="grid min-w-0 gap-0.5 rounded-md border border-line bg-panel p-2"><span
                    class="text-base font-bold text-muted">{{ detailHorizon }} 分鐘</span><strong
                    class="font-mono text-base leading-5 text-ink">{{ baselineComparison.predictedBikes }} 車／{{
                      baselineComparison.predictedDocks }} 位</strong></div>
              </div>
              <p class="mt-2 text-base font-extrabold leading-6 text-accent-strong">{{ baselineComparison.delta }}</p>
            </div>
          </DisclosurePanel>

          <div v-if="!baselineComparison" class="mt-4 grid gap-1 rounded-md border border-line bg-panel-muted p-3">
            <span class="inline-flex items-center gap-1.5 text-base font-extrabold text-accent-strong">
              <component :is="isLive ? Zap : ChartNoAxesColumn" style="width: 1em; height: 1em" class="text-lg" aria-hidden="true" /> {{
                forecastHeadline }}
            </span>
            <strong class="text-lg text-ink">{{ forecastDescription }}</strong>
            <small class="text-base leading-6 text-muted">{{ forecastCaption }}</small>
          </div>

          <section v-if="needsReturnGuidance"
            class="mt-3 rounded-md border border-line border-l-4 border-l-info bg-panel-muted p-3" aria-label="附近替代還車站">
            <div class="flex items-center justify-between gap-2 text-base font-extrabold text-ink">
              <span class="inline-flex items-center gap-1.5">
                <MapPinned class="size-4 text-info" :stroke-width="2" /> 替代還車站
              </span>
              <small class="text-base font-bold text-muted">600m 內</small>
            </div>
            <div v-if="returnStations.length" class="mt-2 grid gap-1.5">
              <button v-for="option in returnStations" :key="option.stationId"
                class="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel px-2 py-2 text-left text-base text-ink transition-colors hover:border-accent-strong hover:bg-surface"
                type="button" @click="emit('select', option.stationId)">
                <span class="grid min-w-0 gap-0.5"><b class="truncate">{{ option.name }}</b><small
                    class="text-base text-muted">{{ option.distanceMeters }}m · {{ option.district }}</small></span>
                <strong class="shrink-0 font-mono text-base text-info">{{ option.availableDocks }} 位</strong>
              </button>
            </div>
            <p v-else class="mt-2 text-base text-muted">600m 內沒有合適的替代站。</p>
          </section>

          <section v-if="needsBorrowGuidance"
            class="mt-3 rounded-md border border-line border-l-4 border-l-accent bg-panel-muted p-3" aria-label="附近替代借車站">
            <div class="flex items-center justify-between gap-2 text-base font-extrabold text-ink">
              <span class="inline-flex items-center gap-1.5">
                <Bike class="size-4 text-accent" :stroke-width="2" /> 替代借車站
              </span>
              <small class="text-base font-bold text-muted">600m 內</small>
            </div>
            <div v-if="borrowStations.length" class="mt-2 grid gap-1.5">
              <button v-for="option in borrowStations" :key="option.stationId"
                class="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel px-2 py-2 text-left text-base text-ink transition-colors hover:border-accent-strong hover:bg-surface"
                type="button" @click="emit('select', option.stationId)">
                <span class="grid min-w-0 gap-0.5"><b class="truncate">{{ option.name }}</b><small
                    class="text-base text-muted">{{ option.distanceMeters }}m · {{ option.district }}</small></span>
                <strong class="shrink-0 font-mono text-base text-accent">{{ option.availableBikes }} 台</strong>
              </button>
            </div>
            <p v-else class="mt-2 text-base text-muted">600m 內沒有合適的替代站。</p>
          </section>

          <DisclosurePanel v-if="!isLive" class="mt-3 rounded-md border border-line" title="最近 6 小時庫存趨勢">
            <div class="m-3">
              <div class="flex flex-wrap items-center justify-between gap-2 text-base font-bold text-muted">
                <span>歷史＋基線推估</span><i class="inline-flex items-center gap-1.5 not-italic"><b
                    class="h-2.5 w-2.5 rounded-full bg-accent" />可借車 <b
                    class="ml-1 h-2.5 w-2.5 rounded-full bg-warning" />可還位</i>
              </div>
              <ForecastChart :history="history" :station-name="stationName" :capacity="station.totalDocks"
                :projections="chartProjections" />
            </div>
          </DisclosurePanel>

          <DisclosurePanel v-if="forecast?.reasons.length || station.qualityFlags.length"
            class="mt-3 rounded-md border border-line" title="判斷依據">
            <div class="grid gap-2 p-3">
              <span v-for="reason in forecast?.reasons" :key="reason"
                class="flex items-start gap-1.5 text-base leading-6 text-muted">
                <CheckCheck style="width: 1em; height: 1em" class="mt-0.5 shrink-0 text-lg text-accent-strong" aria-hidden="true" /> {{ reason }}
              </span>
              <span v-for="flag in station.qualityFlags" :key="flag"
                class="flex items-start gap-1.5 text-base leading-6 text-warning">
                <Info style="width: 1em; height: 1em" class="mt-0.5 shrink-0 text-lg" aria-hidden="true" /> {{ flag }}
              </span>
            </div>
          </DisclosurePanel>
          <NuxtLink v-if="!isLive" :to="detailTarget"
            class="mt-4 inline-flex items-center gap-1 text-base font-bold text-accent transition-colors hover:text-accent-strong">
            開啟完整站點視圖
            <ArrowRight style="width: 1em; height: 1em" class="text-lg" aria-hidden="true" />
          </NuxtLink>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.station-detail-layer--docked {
  position: relative;
  inset: auto;
  z-index: auto;
  display: block;
  padding: 0;
}

.station-detail-layer--docked .station-detail {
  height: clamp(38rem, calc(100svh - 8rem), 52rem);
  max-width: none;
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: none;
  overscroll-behavior: contain;
}

.detail-drawer-enter-active .station-detail,
.detail-drawer-leave-active .station-detail {
  transition: transform 160ms ease;
}

.detail-drawer-enter-from .station-detail,
.detail-drawer-leave-to .station-detail {
  transform: translateX(100%);
}

.station-detail-layer--docked.detail-drawer-enter-from .station-detail,
.station-detail-layer--docked.detail-drawer-leave-to .station-detail {
  transform: none;
}

@media (max-width: 1100px) {
  .station-detail-layer--adaptive {
    align-items: end;
    justify-content: center;
    padding: 12px;
  }
  .station-detail-layer--adaptive .station-detail {
    height: min(72svh, 720px);
    max-width: 48rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    overscroll-behavior: contain;
    padding-bottom: max(24px, env(safe-area-inset-bottom));
  }
  .station-detail-layer--adaptive.detail-drawer-enter-from .station-detail,
  .station-detail-layer--adaptive.detail-drawer-leave-to .station-detail {
    transform: translateY(100%);
  }
}

@media (max-width: 639px) {

  .detail-drawer-enter-from .station-detail,
  .detail-drawer-leave-to .station-detail {
    transform: translateY(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .detail-drawer-enter-active .station-detail,
  .detail-drawer-leave-active .station-detail { transition: none; }
}
</style>
