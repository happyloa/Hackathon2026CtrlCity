<script setup lang="ts">
import { Info, LoaderCircle, RefreshCw, Search, TriangleAlert, X } from '@lucide/vue'
import { stationOverviewStatus, type StationOverviewStatus } from '~/shared/station-overview'
import { summarizeStationDistricts } from '~/shared/district-summary'
type StationFilter = 'all' | StationOverviewStatus | 'frozen'

const route = useRoute()
const router = useRouter()
const live = useLiveDashboard()
const selectedStationId = ref('')
const stationFilter = ref<StationFilter>('all')
const stationQuery = ref('')
const {
  selectedDistrict,
  selectionSource,
  locationMessage,
  syncDistrictFromContext,
} = useDistrictSelection({
  stations: () => live.dashboard.value?.stations,
  districts: () => live.dashboard.value?.districts,
  initialDistrict: () => typeof route.query.district === 'string' ? route.query.district : '',
})

const filterOptions: Array<{ value: StationFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'empty', label: '缺車' },
  { value: 'full', label: '缺位' },
  { value: 'stable', label: '穩定' },
  { value: 'unknown', label: '資料不足' },
  { value: 'service', label: '服務異常' },
  { value: 'frozen', label: '連續停滯' },
]

// The shared layout owns live polling for every operations page.
const districtSummaries = computed(() => summarizeStationDistricts(live.dashboard.value?.stations || [], live.dashboard.value?.alerts || []))
const asOfLabel = computed(() => live.dashboard.value ? new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(live.dashboard.value.meta.asOf)) : '尚未載入')

const dashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value))
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...(live.dashboard.value?.districts || []).map(district => ({ value: district, label: district })),
])
const alertLookup = computed(() => new Map((dashboard.value?.alerts || []).map(alert => [alert.stationId, alert])))
const frozenLookup = computed(() => new Map((dashboard.value?.frozenStations || []).map(entry => [entry.stationId, entry])))
const contextQuery = computed<Record<string, string>>(() => {
  const query: Record<string, string> = {}
  if (selectedDistrict.value) query.district = selectedDistrict.value
  return query
})
const selectedStation = computed(() => dashboard.value?.stations.find(station => station.id === selectedStationId.value) || null)

const filteredStations = computed(() => {
  const query = stationQuery.value.trim().toLocaleLowerCase('zh-TW')
  const rank: Record<StationOverviewStatus, number> = { empty: 0, full: 0, service: 1, unknown: 2, stable: 3 }
  return [...(dashboard.value?.stations || [])]
    .filter((station) => {
      if (stationFilter.value === 'frozen') {
        if (!frozenLookup.value.has(station.id)) return false
      } else if (stationFilter.value !== 'all') {
        const status = stationOverviewStatus(station, alertLookup.value.get(station.id))
        if (status !== stationFilter.value) return false
      }
      return !query || `${station.name} ${station.district}`.toLocaleLowerCase('zh-TW').includes(query)
    })
    .sort((left, right) => {
      const statusDifference = rank[stationOverviewStatus(left, alertLookup.value.get(left.id))] - rank[stationOverviewStatus(right, alertLookup.value.get(right.id))]
      if (statusDifference) return statusDifference
      const priorityDifference = (alertLookup.value.get(right.id)?.priorityScore || 0) - (alertLookup.value.get(left.id)?.priorityScore || 0)
      return priorityDifference || left.name.localeCompare(right.name, 'zh-Hant')
    })
})

const counts = computed(() => {
  const stations = dashboard.value?.stations || []
  return {
    all: stations.length,
    empty: stations.filter(station => stationOverviewStatus(station, alertLookup.value.get(station.id)) === 'empty').length,
    full: stations.filter(station => stationOverviewStatus(station, alertLookup.value.get(station.id)) === 'full').length,
    stable: stations.filter(station => stationOverviewStatus(station, alertLookup.value.get(station.id)) === 'stable').length,
    unknown: stations.filter(station => stationOverviewStatus(station, alertLookup.value.get(station.id)) === 'unknown').length,
    service: stations.filter(station => stationOverviewStatus(station, alertLookup.value.get(station.id)) === 'service').length,
    frozen: stations.filter(station => frozenLookup.value.has(station.id)).length,
  }
})

function clearFilters() { stationQuery.value = ''; stationFilter.value = 'all'; selectedDistrict.value = '' }

watch(selectedDistrict, (district) => {
  const current = typeof route.query.district === 'string' ? route.query.district : ''
  if (import.meta.client && district !== current) void router.replace({ query: district ? { district } : {} })
  selectedStationId.value = ''
}, { immediate: true })

watch(() => route.query.district, (district) => {
  const nextDistrict = typeof district === 'string' ? district : ''
  syncDistrictFromContext(nextDistrict)
})
</script>

<template>
  <div class="stations-page">
    <div class="stations-source"><p>從行政區掌握風險，再查看每一站的即時庫存。</p><div><span><i :class="{ stale: live.error.value }" />{{ live.error.value ? '更新暫時中斷' : '官方即時資料' }}<time>{{ asOfLabel }}</time></span><button type="button" :disabled="live.pending.value" @click="live.refresh({ manual: true })"><LoaderCircle v-if="live.pending.value" :size="15" class="stations-spin" aria-hidden="true" /><RefreshCw v-else :size="15" aria-hidden="true" />{{ live.pending.value ? '更新中' : '更新資料' }}</button></div></div>
    <div v-if="live.error.value && dashboard" class="live-inline-error" role="alert"><TriangleAlert :size="18" aria-hidden="true" />{{ live.error.value }}<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite"><LoaderCircle :size="22" class="stations-spin" aria-hidden="true" />正在載入站點與行政區匯總…</div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert"><TriangleAlert :size="22" aria-hidden="true" />{{ live.error.value }}<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <template v-else-if="dashboard">
      <DistrictOverview :summaries="districtSummaries" :selected-district="selectedDistrict" @select="selectedDistrict = $event" />
      <section class="stations-filters" aria-label="站點篩選">
        <div class="stations-search-row">
          <label class="stations-search"><span>搜尋站點</span><div><Search :size="18" aria-hidden="true" /><input v-model="stationQuery" type="search" placeholder="搜尋站名或行政區" aria-label="搜尋站點" /></div></label>
          <div class="stations-district"><ModalPicker v-model="selectedDistrict" :label="selectionSource === 'location' ? '行政區（依位置）' : '行政區'" title="選擇行政區" :options="districtPickerOptions" /></div>
          <button v-if="selectedDistrict || stationFilter !== 'all' || stationQuery" class="stations-clear" type="button" @click="clearFilters"><X :size="15" aria-hidden="true" />清除篩選</button>
        </div>
        <div class="stations-filter-bottom"><div class="stations-status-filters" role="group" aria-label="站點狀態篩選"><button v-for="item in filterOptions" :key="item.value" type="button" :class="{ active: stationFilter === item.value }" :aria-pressed="stationFilter === item.value" @click="stationFilter = item.value">{{ item.label }}<b>{{ counts[item.value] }}</b></button></div><span>{{ selectedDistrict || '全市' }} · 含 60 分鐘預測</span></div>
        <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
      </section>
      <DistrictStationList :stations="filteredStations" :alerts="dashboard.alerts" :frozen-stations="dashboard.frozenStations" :reset-key="`${selectedDistrict}|${stationFilter}|${stationQuery}`" @select="selectedStationId = $event" />
      <DisclosurePanel class="panel stations-method" title="匯總與分數怎麼看" description="查看統計範圍與計算方式" icon="solar:info-circle-outline">
        <div><p><Info :size="16" aria-hidden="true" />區域摘要固定以全市資料計算；搜尋與狀態篩選只影響下方站點清單。</p><p>需關注站點包含目前或 60 分鐘內可能缺車／缺位的站點。地圖以這些站點占該區總站數的比例著色；服務異常與資料不足另行標示。</p><p>平均風險為有可用預測、且正常營運站點的 60 分鐘模型風險平均（0–100），沒有預測時顯示「—」。預測高風險站數沿用模型的高風險／極高風險分級。</p><p>站點優先分用來安排處理順序：當下空滿 50、60 分鐘風險 25、庫存缺口 20、基線品質 5；與模型風險分數不同。</p></div>
      </DisclosurePanel>
    </template>
    <StationDetailPanel :station="selectedStation" :stations="dashboard?.stations || []" :history="[]" horizon="60" data-mode="live" :context-query="contextQuery" @close="selectedStationId = ''" @select="selectedStationId = $event" />
  </div>
</template>

<style scoped>
.stations-page { width: 100%; max-width: 1760px; margin: auto; padding: 20px 32px 32px; display: grid; gap: 22px; }
.stations-source, .stations-source > div, .stations-source > div > span, .stations-source button { display: flex; align-items: center; gap: 10px; }.stations-source { justify-content: space-between; flex-wrap: wrap; gap: 10px 20px; }.stations-source p { font-size: var(--type-body2); color: var(--muted); }.stations-source > div { gap: 16px; color: var(--muted); font-size: var(--type-body2); }.stations-source > div > span { flex-wrap: wrap; gap: 7px; }.stations-source i { display: inline-block; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }.stations-source i.stale { background: var(--warning); }.stations-source time { margin-left: 4px; font-variant-numeric: tabular-nums; }.stations-source button { min-height: 40px; padding: 7px 11px; border: 1px solid var(--line); background: var(--panel); border-radius: 6px; color: var(--ink); font-size: var(--type-body2); }
.stations-filters { border: 1px solid var(--line); background: var(--panel); border-radius: 9px; padding: 16px; }.stations-search-row { display: flex; align-items: end; gap: 16px; }.stations-search { flex: 1; min-width: 0; }.stations-search > span { display: block; font-size: var(--type-body2); color: var(--muted); margin-bottom: 6px; }.stations-search > div { display: flex; align-items: center; gap: 8px; min-height: 44px; border: 1px solid var(--line-strong); border-radius: 6px; padding: 8px 12px; }.stations-search svg { color: var(--muted); flex-shrink: 0; }.stations-search input { min-width: 0; width: 100%; border: 0; outline: none; background: transparent; font-size: var(--type-body2); }.stations-search > div:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }.stations-district { width: 240px; }.stations-district :deep(> div > span) { font-size: var(--type-body2); font-weight: 400; }.stations-district :deep(button) { font-size: var(--type-body2); min-height: 44px; }.stations-clear { display: flex; align-items: center; gap: 5px; color: var(--accent); min-height: 44px; font-size: var(--type-body2); white-space: nowrap; }
.stations-filter-bottom { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 14px; }.stations-filter-bottom > span { font-size: var(--type-body2); color: var(--muted); }.stations-status-filters { display: flex; flex-wrap: wrap; gap: 6px; }.stations-status-filters button { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 38px; padding: 6px 11px; font-size: var(--type-body2); border: 1px solid var(--line); border-radius: 6px; color: var(--muted); }.stations-status-filters b { font-size: var(--type-body2); font-weight: 500; font-variant-numeric: tabular-nums; }.stations-status-filters button.active { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }.stations-status-filters button:hover:not(.active) { border-color: var(--accent); color: var(--ink); }
.stations-method :deep(> button) { font-size: var(--type-body2); font-weight: 550; }.stations-method :deep(> button small) { font-size: var(--type-body2); }.stations-method :deep(p) { display: flex; align-items: start; gap: 8px; font-size: var(--type-body2); color: var(--muted); line-height: 1.8; margin-bottom: 6px; }.stations-method :deep(p svg) { flex-shrink: 0; margin-top: 4px; }.stations-method :deep(.disclosure-enter-to), .stations-method :deep(> div) { padding: 16px; }.stations-spin { animation: stations-spin 1s linear infinite; }@keyframes stations-spin { to { transform: rotate(360deg); } }
@media (max-width: 1000px) { .stations-page { padding: 20px; } }
@media (max-width: 680px) { .stations-page { padding: 16px; gap: 18px; }.stations-source > div { width: 100%; justify-content: space-between; }.stations-search-row { flex-wrap: wrap; gap: 12px; }.stations-search { flex-basis: 100%; }.stations-district { flex: 1; min-width: 170px; }.stations-status-filters { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }.stations-status-filters button { padding: 6px 7px; min-height: 42px; }.stations-filters { padding: 13px; } }
@media (prefers-reduced-motion: reduce) { .stations-spin { animation: none; } }
</style>
