<script setup lang="ts">
import { BellRing, CheckCircle2, ChevronDown, Info, TriangleAlert } from '@lucide/vue'
import { refillAmountFor } from '~/shared/operational-policy.mjs'
import { shortageWarningsFor } from '~/shared/shortage-warnings'
import { displayStationName, type DashboardSummary, type HorizonKey, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  stations: StationRisk[]
  asOf: string
  summary: DashboardSummary
  realtimeLowBikes?: { atLeast30: string[]; atLeast60: string[] }
}>()

const emit = defineEmits<{ select: [stationId: string] }>()

type RealtimeTabKey = 'rt30' | 'rt60'
type TabKey = HorizonKey | RealtimeTabKey

interface TabDef {
  key: TabKey
  kind: 'forecast' | 'realtime'
  label: string
  minutes: number
}

const FORECAST_TABS: { key: HorizonKey; label: string }[] = [
  { key: '30', label: '預測 30 分鐘' },
  { key: '60', label: '預測 60 分鐘' },
]

const TABS: TabDef[] = [
  ...FORECAST_TABS.map(tab => ({ ...tab, kind: 'forecast' as const, minutes: Number(tab.key) })),
  { key: 'rt30', kind: 'realtime', label: '即時缺車 ≥30 分鐘', minutes: 30 },
  { key: 'rt60', kind: 'realtime', label: '即時缺車 ≥60 分鐘', minutes: 60 },
]

const activeTab = ref<TabKey>('30')
const activeTabDef = computed(() => TABS.find(tab => tab.key === activeTab.value) ?? TABS[0]!)

/**
 * A station only belongs here once its forecast for this horizon is
 * "empty_forecast" -- the same threshold `buildLiveOperations` uses for the
 * dispatch route. A station that has already run out comes back as
 * "empty_now" instead and is excluded, because that's not a warning anymore,
 * it's something to dispatch for right now.
 */
function forecastWarningsFor(horizon: HorizonKey) {
  const alerts = shortageWarningsFor(props.stations, props.asOf, horizon)
  const stationLookup = new Map(props.stations.map(station => [station.id, station]))
  return alerts
    .map((alert) => {
      const station = stationLookup.get(alert.stationId)!
      const predictedBikes = Math.max(0, station.forecast.horizons[horizon].predictedBikes)
      return {
        station,
        // Round only for display; feeding the raw forecast (not the rounded
        // display value) into refillAmountFor keeps this exactly aligned
        // with the dispatch route's own gap calculation.
        predictedBikesDisplay: Math.round(predictedBikes),
        refillBikes: refillAmountFor(station, predictedBikes),
      }
    })
    .sort((left, right) => right.refillBikes - left.refillBikes || left.station.id.localeCompare(right.station.id))
}

/**
 * Real-time counterpart to the forecast tabs above: stations the browser's
 * own rolling snapshot buffer (`useLiveRiskProfiles.ts`) has observed with
 * available bikes continuously below the threshold for at least this many
 * minutes -- not a prediction, a direct read of what has already happened
 * this session. Empty until this page has stayed open long enough to build
 * up that much history.
 */
function realtimeWarningsFor(key: RealtimeTabKey) {
  const ids = key === 'rt30' ? props.realtimeLowBikes?.atLeast30 : props.realtimeLowBikes?.atLeast60
  const stationLookup = new Map(props.stations.map(station => [station.id, station]))
  return (ids ?? [])
    .map(id => stationLookup.get(id))
    .filter((station): station is StationRisk => Boolean(station))
    .sort((left, right) => left.availableBikes - right.availableBikes || left.id.localeCompare(right.id))
}

const forecastByHorizon = computed(() => Object.fromEntries(
  FORECAST_TABS.map(({ key }) => [key, forecastWarningsFor(key)]),
) as Record<HorizonKey, ReturnType<typeof forecastWarningsFor>>)
const realtimeByTab = computed(() => ({
  rt30: realtimeWarningsFor('rt30'),
  rt60: realtimeWarningsFor('rt60'),
}) as Record<RealtimeTabKey, ReturnType<typeof realtimeWarningsFor>>)

const countsByTab = computed(() => Object.fromEntries(
  TABS.map(tab => [tab.key, tab.kind === 'forecast'
    ? forecastByHorizon.value[tab.key as HorizonKey].length
    : realtimeByTab.value[tab.key as RealtimeTabKey].length]),
) as Record<TabKey, number>)

const expanded = ref(false)
const warningContentId = useId()
const forecastAvailable = computed(() => Object.fromEntries(FORECAST_TABS.map(({ key }) => [key, props.stations.some(station => station.serviceStatus === 'operational' && station.forecast.horizons[key].baselineStatus === 'matched')])) as Record<HorizonKey, boolean>)
const hasForecast = computed(() => FORECAST_TABS.some(({ key }) => forecastAvailable.value[key]))
const hasWarnings = computed(() => TABS.some(tab => countsByTab.value[tab.key] > 0))
</script>

<template>
  <section class="warning-panel" :class="{ 'has-warnings': hasWarnings, 'forecast-unavailable': !hasForecast && !hasWarnings }" aria-label="缺車通報">
    <button class="warning-trigger" type="button" :aria-expanded="expanded" :aria-controls="warningContentId" @click="expanded = !expanded">
      <span class="warning-symbol"><component :is="!hasForecast && !hasWarnings ? Info : hasWarnings ? BellRing : CheckCircle2" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /></span>
      <span class="warning-heading">{{ !hasForecast && !hasWarnings ? '預測暫不可用' : hasWarnings ? '缺車通報' : '已對照站點無缺車通報' }}<small>{{ hasForecast ? '預測缺車 · 不含目前空站' : '目前僅顯示即時庫存' }}</small></span>
      <span class="warning-figures"><span><b>預測 30</b> 分鐘 <strong>{{ forecastAvailable['30'] ? countsByTab['30'] : '—' }}</strong> 站</span><span><b>預測 60</b> 分鐘 <strong>{{ forecastAvailable['60'] ? countsByTab['60'] : '—' }}</strong> 站</span><span><b>即時 ≥30</b> 分鐘 <strong>{{ countsByTab['rt30'] }}</strong> 站</span><span><b>即時 ≥60</b> 分鐘 <strong>{{ countsByTab['rt60'] }}</strong> 站</span></span>
      <span class="warning-action">{{ expanded ? '收合清單' : '查看通報' }}<ChevronDown style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" :class="{ 'is-expanded': expanded }" /></span>
    </button>
    <div v-if="expanded" :id="warningContentId" class="warning-content">
      <p class="warning-context">「預測」為各時點分別估算，站點可能重疊；「即時缺車」是此頁面持續開啟期間，直接觀測到可借車數持續偏低的站點，需要開啟足夠時間才會出現。目前空站另列於上方營運摘要。</p>
      <div class="flex flex-wrap gap-2 px-4 pb-3 pt-1" role="group" aria-label="缺車通報分類">
        <button v-for="tab in TABS" :key="tab.key" type="button" :aria-pressed="activeTab === tab.key"
          class="min-h-9 rounded-md border px-3 text-body1 font-semibold transition-colors" :class="activeTab === tab.key
            ? 'border-accent-strong bg-accent text-on-accent'
            : 'border-line bg-panel-muted text-muted hover:border-accent-strong'" @click="activeTab = tab.key">
          {{ tab.label }}（{{ tab.kind === 'forecast' && !forecastAvailable[tab.key as HorizonKey] ? '—' : countsByTab[tab.key] }}）
        </button>
      </div>

      <div v-if="activeTabDef.kind === 'forecast'">
        <div v-if="forecastByHorizon[activeTabDef.key as HorizonKey].length" class="divide-y divide-line border-t border-line">
          <button v-for="item in forecastByHorizon[activeTabDef.key as HorizonKey]" :key="item.station.id" type="button"
            class="flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-panel-muted"
            @click="emit('select', item.station.id)">
            <span class="grid size-10 shrink-0 place-items-center rounded-full bg-warning-surface text-h6 text-warning">
              <TriangleAlert style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1 text-body1 leading-6 text-ink">
              <strong class="block break-words font-bold">{{ displayStationName(item.station.name) }}</strong>
              <span class="mt-1 block text-muted">{{ item.station.district || '行政區未標示' }}</span>
            </span>
            <span class="ml-auto flex w-full items-center justify-between gap-2 text-body1 sm:w-auto sm:flex-col sm:items-end">
              <span class="text-muted">預估可借車 <strong class="font-mono text-ink">{{ item.predictedBikesDisplay }}</strong> 台</span>
              <span class="text-muted">建議補 <strong class="font-mono text-ink">{{ item.refillBikes }}</strong> 台</span>
            </span>
          </button>
        </div>
        <div v-else class="flex min-h-24 items-center justify-center gap-2 border-t border-line p-4 text-center text-body1 font-semibold text-positive">
          <component class="icon-md" :is="forecastAvailable[activeTabDef.key as HorizonKey] ? CheckCircle2 : Info" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />{{ forecastAvailable[activeTabDef.key as HorizonKey] ? '這個時點已對照的站點，沒有預測缺車情形。' : '這個時點沒有可用預測，請先查看即時站況。' }}
        </div>
      </div>
      <div v-else>
        <div v-if="realtimeByTab[activeTabDef.key as RealtimeTabKey].length" class="divide-y divide-line border-t border-line">
          <button v-for="station in realtimeByTab[activeTabDef.key as RealtimeTabKey]" :key="station.id" type="button"
            class="flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-panel-muted"
            @click="emit('select', station.id)">
            <span class="grid size-10 shrink-0 place-items-center rounded-full bg-warning-surface text-h6 text-warning">
              <TriangleAlert style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1 text-body1 leading-6 text-ink">
              <strong class="block break-words font-bold">{{ displayStationName(station.name) }}</strong>
              <span class="mt-1 block text-muted">{{ station.district || '行政區未標示' }}</span>
            </span>
            <span class="ml-auto flex w-full items-center justify-between gap-2 text-body1 sm:w-auto sm:flex-col sm:items-end">
              <span class="text-muted">目前可借車 <strong class="font-mono text-ink">{{ station.availableBikes }}</strong> 台</span>
              <span class="text-muted">已持續 ≥{{ activeTabDef.minutes }} 分鐘</span>
            </span>
          </button>
        </div>
        <div v-else class="flex min-h-24 items-center justify-center gap-2 border-t border-line p-4 text-center text-body1 font-semibold text-positive">
          <CheckCircle2 class="icon-md" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />這個條件目前沒有符合的站點；此清單需頁面持續開啟並累積至少 {{ activeTabDef.minutes }} 分鐘的即時快照才會出現。
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.warning-panel { border: 1px solid var(--line); border-left: 3px solid var(--positive); border-radius: 9px; background: var(--panel); overflow: hidden; }
.warning-panel.has-warnings { border-color: color-mix(in srgb, var(--warning) 28%, var(--line)); border-left-color: var(--warning); background: color-mix(in srgb, var(--warning) 5%, var(--panel)); }
.warning-panel.forecast-unavailable { border-left-color: var(--muted); }
.forecast-unavailable .warning-symbol { color: var(--muted); background: var(--panel-muted); }
.warning-trigger { display: flex; align-items: center; gap: 14px; padding: 11px 16px; width: 100%; text-align: left; }
.warning-trigger:hover { background: color-mix(in srgb, var(--warning) 4%, transparent); }
.warning-symbol { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 8px; color: var(--positive); background: var(--positive-surface); font-size: var(--icon-md); }
.has-warnings .warning-symbol { color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
.warning-heading { font-size: var(--type-body1); font-weight: 650; }
.warning-heading small { display: block; font-size: var(--type-body2); font-weight: 400; color: var(--muted); margin-top: 2px; }
.warning-figures { display: flex; flex-wrap: wrap; gap: 10px 24px; margin-left: 18px; color: var(--muted); font-size: var(--type-body2); }
.warning-figures > span { white-space: nowrap; }
.warning-figures b { font-weight: 500; }
.warning-figures strong { margin-left: 9px; font-size: var(--type-h6); color: var(--ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.has-warnings .warning-figures strong { color: var(--warning); }
.warning-action { display: inline-flex; align-items: center; justify-content: end; gap: 9px; margin-left: auto; font-size: var(--type-body2); font-weight: 550; white-space: nowrap; }
.warning-action svg { transition: transform .15s; }
.is-expanded { transform: rotate(180deg); }
.warning-content { background: var(--panel); border-top: 1px solid var(--line); }
.warning-content > .divide-y { max-height: 380px; overflow-y: auto; }
.warning-context { padding: 14px 16px 10px; font-size: var(--type-body2); color: var(--muted); }
@media (max-width: 640px) { .warning-trigger { padding: 14px; gap: 10px; flex-wrap: wrap; } .warning-symbol { width: 32px; height: 32px; } .warning-heading small { display: none; } .warning-heading { font-size: var(--type-body2); } .warning-figures { order: 4; width: 100%; margin-left: 42px; gap: 12px; } .warning-figures strong { margin-left: 3px; } }
</style>
