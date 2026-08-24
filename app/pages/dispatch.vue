<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans, DEFAULT_DISPATCH_ROUTE_POLICY } from '~/shared/dispatch-route-planner'

const route = useRoute()
const router = useRouter()
const live = useLiveDashboard()
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

useLivePolling(live.refresh, computed(() => true))

const dashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value))
const planning = computed(() => dashboard.value
  ? buildDispatchRoutePlans(dashboard.value.dispatches, dashboard.value.stations)
  : { routes: [], unplannedDispatches: [] })
const contextQuery = computed<Record<string, string>>(() => {
  const query: Record<string, string> = {}
  if (selectedDistrict.value) query.district = selectedDistrict.value
  return query
})
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...(live.dashboard.value?.districts || []).map(district => ({ value: district, label: district })),
])

watch(selectedDistrict, (district) => {
  if (!import.meta.client) return
  const current = typeof route.query.district === 'string' ? route.query.district : ''
  if (district !== current) void router.replace({ query: district ? { district } : {} })
}, { immediate: true })

watch(() => route.query.district, (district) => {
  const nextDistrict = typeof district === 'string' ? district : ''
  syncDistrictFromContext(nextDistrict)
})
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <WorkspaceContext mode="live" :district="selectedDistrict" :data-time="dashboard?.meta.asOf" :query="contextQuery" />

    <section class="panel grid gap-4 p-4 sm:p-5 lg:grid-cols-3 lg:items-end">
      <div class="min-w-0 lg:col-span-2">
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 搬運建議</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">{{ planning.routes.length }} 條多站路線</h2>
      </div>
      <ModalPicker v-model="selectedDistrict" :label="selectionSource === 'location' ? '行政區（依位置）' : '行政區'" title="選擇行政區" :options="districtPickerOptions" />
      <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
    </section>

    <section class="panel flex flex-wrap gap-2 p-4 text-base font-semibold text-muted" aria-label="路線規則">
      <span class="rounded-md bg-panel-muted px-3 py-2">高風險優先</span>
      <span class="rounded-md bg-panel-muted px-3 py-2">每車 {{ DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity }} 台 · 保留 15% · {{ DEFAULT_DISPATCH_ROUTE_POLICY.maximumAdjacentTaskDistanceKm }} km 內合併</span>
    </section>

    <div v-if="live.error.value && dashboard" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ live.error.value }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />正在建立即時路線建議…</div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ live.error.value }}<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <RoutePlanList v-else-if="dashboard" :dispatches="dashboard.dispatches" :stations="dashboard.stations" :context-query="contextQuery" @select="navigateTo({ path: '/stations/' + $event, query: contextQuery })" />
  </div>
</template>
