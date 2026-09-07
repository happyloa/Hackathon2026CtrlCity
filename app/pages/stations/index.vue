<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { stationOverviewStatus, type StationOverviewStatus } from '~/shared/station-overview'
type StationFilter = 'all' | StationOverviewStatus

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
]

useLivePolling(live.refresh, computed(() => true))

const dashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value))
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...(live.dashboard.value?.districts || []).map(district => ({ value: district, label: district })),
])
const alertLookup = computed(() => new Map((dashboard.value?.alerts || []).map(alert => [alert.stationId, alert])))
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
      const status = stationOverviewStatus(station, alertLookup.value.get(station.id))
      if (stationFilter.value !== 'all' && status !== stationFilter.value) return false
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
  }
})

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
  <div class="mx-auto w-full max-w-screen-3xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <WorkspaceContext mode="live" :district="selectedDistrict" :data-time="dashboard?.meta.asOf"
      :query="contextQuery" />

    <section class="panel grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] xl:items-end">
      <div>
        <p class="section-kicker">
          <Icon icon="solar:map-point-wave-outline" /> 即時站況
        </p>
        <h2 class="mt-1 text-2xl font-bold">站點總覽</h2>
      </div>
      <ModalPicker v-model="selectedDistrict" :label="selectionSource === 'location' ? '行政區（依位置）' : '行政區'" title="選擇行政區"
        :options="districtPickerOptions" />
      <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
    </section>

    <section class="panel grid gap-3 p-4 sm:p-5">
      <label
        class="flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-panel-muted px-3 text-ink focus-within:border-accent">
        <Icon class="shrink-0 text-xl text-accent" icon="solar:magnifer-outline" />
        <input v-model="stationQuery"
          class="min-w-0 flex-1 border-0 bg-transparent text-base outline-none placeholder:text-muted" type="search"
          placeholder="搜尋站名或行政區" aria-label="搜尋站點" />
      </label>
      <div class="flex flex-wrap gap-2" role="group" aria-label="站點狀態篩選">
        <button v-for="item in filterOptions" :key="item.value" type="button"
          class="min-h-11 rounded-lg border px-3 text-base font-bold transition-colors"
          :class="stationFilter === item.value ? 'border-accent bg-accent text-on-accent' : 'border-line bg-panel-muted text-muted hover:border-line-strong hover:text-ink'"
          :aria-pressed="stationFilter === item.value" @click="stationFilter = item.value">
          {{ item.label }} <span class="font-mono">{{ counts[item.value] }}</span>
        </button>
      </div>
    </section>

    <div v-if="live.error.value && dashboard" class="live-inline-error" role="alert">
      <Icon icon="solar:danger-triangle-outline" />{{ live.error.value }}
      <PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" />
    </div>
    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite">
      <Icon icon="svg-spinners:3-dots-fade" />正在載入站點…
    </div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert">
      <Icon icon="solar:danger-triangle-outline" />{{ live.error.value }}
      <PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" />
    </div>

    <StationOverviewList v-else-if="dashboard" :stations="filteredStations" :alerts="dashboard.alerts"
      :reset-key="`${selectedDistrict}|${stationFilter}|${stationQuery}`" @select="selectedStationId = $event" />
    <StationDetailPanel :station="selectedStation" :stations="dashboard?.stations || []" :history="[]" horizon="60"
      data-mode="live" :context-query="contextQuery" @close="selectedStationId = ''"
      @select="selectedStationId = $event" />

    <DisclosurePanel class="panel" title="分數怎麼看" description="展開查看排序方式" icon="solar:info-circle-outline">
      <p class="m-0 p-4 text-base leading-7 text-muted">優先分只用來排序：當下空滿 50、60 分鐘風險 25、庫存缺口 20、基線品質 5；55 分以上先看。</p>
    </DisclosurePanel>
  </div>
</template>
