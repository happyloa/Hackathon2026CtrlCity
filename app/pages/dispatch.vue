<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans, DEFAULT_DISPATCH_ROUTE_POLICY } from '~/shared/dispatch-route-planner'
import { DEFAULT_LIVE_OPERATION_POLICY } from '~/shared/live-operations'

const route = useRoute()
const router = useRouter()
const live = useLiveDashboard()
const selectedDistrict = ref(typeof route.query.district === 'string' ? route.query.district : '')

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
})

watch(() => route.query.district, (district) => {
  const nextDistrict = typeof district === 'string' ? district : ''
  if (selectedDistrict.value !== nextDistrict) selectedDistrict.value = nextDistrict
})
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <WorkspaceContext mode="live" :district="selectedDistrict" :data-time="dashboard?.meta.asOf" :query="contextQuery" />

    <section class="panel grid gap-4 p-4 sm:p-5 lg:grid-cols-3 lg:items-end">
      <div class="min-w-0 lg:col-span-2">
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 即時調度決策支援</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">{{ planning.routes.length }} 條多站建議路線</h2>
        <p class="mt-2 max-w-3xl text-base leading-7 text-muted">風險決定先後，庫存決定能搬多少，距離決定配對與合併成本；服務異常站不會進入規劃。</p>
      </div>
      <ModalPicker v-model="selectedDistrict" label="行政區" title="選擇行政區" :options="districtPickerOptions" />
    </section>

    <section class="panel grid gap-px overflow-hidden bg-line sm:grid-cols-2 xl:grid-cols-4" aria-label="路線規劃依據">
      <article class="bg-panel p-4">
        <span class="font-mono text-base font-bold text-accent">01</span>
        <h3 class="mt-1 text-lg font-bold">先通過資料條件</h3>
        <p class="mt-1 text-base leading-6 text-muted">服務異常直接排除；未來風險需有基線，當下空／滿可依官方庫存直接配對。</p>
      </article>
      <article class="bg-panel p-4">
        <span class="font-mono text-base font-bold text-accent">02</span>
        <h3 class="mt-1 text-lg font-bold">風險與供需配對</h3>
        <p class="mt-1 text-base leading-6 text-muted">高優先分先處理；相近條件下優先用滿站供應缺車站，並提高單次缺口覆蓋率。</p>
      </article>
      <article class="bg-panel p-4">
        <span class="font-mono text-base font-bold text-accent">03</span>
        <h3 class="mt-1 text-lg font-bold">庫存可行</h3>
        <p class="mt-1 text-base leading-6 text-muted">兩端皆保留 15% 安全量；單筆最多 {{ DEFAULT_LIVE_OPERATION_POLICY.maximumTransferBikes }} 台，每車 {{ DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity }} 台。</p>
      </article>
      <article class="bg-panel p-4">
        <span class="font-mono text-base font-bold text-accent">04</span>
        <h3 class="mt-1 text-lg font-bold">距離與多站合併</h3>
        <p class="mt-1 text-base leading-6 text-muted">距離作為配對成本，再合併 {{ DEFAULT_DISPATCH_ROUTE_POLICY.maximumAdjacentTaskDistanceKm }} 公里內需求；目前採直線估算。</p>
      </article>
    </section>

    <p class="m-0 flex items-start gap-2 rounded-lg border border-line bg-panel-muted p-3 text-base leading-6 text-muted"><Icon class="mt-1 shrink-0 text-lg text-info" icon="solar:info-circle-outline" />每次更新檢查前 {{ DEFAULT_LIVE_OPERATION_POLICY.maximumAlerts }} 筆可搬運高優先風險，最多輸出 {{ DEFAULT_LIVE_OPERATION_POLICY.maximumDispatches }} 筆站間建議；全部風險仍保留在告警中心。</p>

    <div v-if="live.error.value && dashboard" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ live.error.value }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />正在建立即時路線建議…</div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ live.error.value }}<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <RoutePlanList v-else-if="dashboard" :dispatches="dashboard.dispatches" :stations="dashboard.stations" :context-query="contextQuery" @select="navigateTo({ path: '/stations/' + $event, query: contextQuery })" />
  </div>
</template>
