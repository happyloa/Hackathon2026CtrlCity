<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { ALERT_PRIORITY_THRESHOLDS } from '~/shared/operational-policy.mjs'

type RiskFilter = 'all' | 'empty' | 'full' | 'service'

const route = useRoute()
const router = useRouter()
const live = useLiveDashboard()
const selectedDistrict = ref(typeof route.query.district === 'string' ? route.query.district : '')
const riskFilter = ref<RiskFilter>('all')
const riskFilterOptions: Array<{ value: RiskFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'empty', label: '缺車' },
  { value: 'full', label: '缺位' },
  { value: 'service', label: '服務異常' },
]

useLivePolling(live.refresh, computed(() => true))

const dashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value))
const contextQuery = computed<Record<string, string>>(() => {
  const query: Record<string, string> = {}
  if (selectedDistrict.value) query.district = selectedDistrict.value
  return query
})
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...(live.dashboard.value?.districts || []).map(district => ({ value: district, label: district })),
])
const inventoryAlerts = computed(() => (dashboard.value?.alerts || []).filter((alert) => {
  if (alert.condition === 'unavailable' || riskFilter.value === 'service') return false
  if (riskFilter.value === 'empty') return alert.condition === 'empty_now' || alert.condition === 'empty_forecast'
  if (riskFilter.value === 'full') return alert.condition === 'full_now' || alert.condition === 'full_forecast'
  return true
}))
const serviceAlerts = computed(() => (dashboard.value?.alerts || []).filter(alert => alert.condition === 'unavailable'))
const showInventory = computed(() => riskFilter.value !== 'service')
const showService = computed(() => riskFilter.value === 'all' || riskFilter.value === 'service')

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

    <section class="panel grid gap-4 p-4 sm:p-5 2xl:grid-cols-2 2xl:items-end">
      <div class="min-w-0">
        <p class="section-kicker text-base"><Icon icon="solar:bell-bing-outline" /> 官方即時分析</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">庫存風險與服務狀態分開判讀</h2>
        <p class="mt-2 max-w-3xl text-base leading-7 text-muted">庫存風險可納入搬運規劃；官方停用或疑似設備異常僅供查驗，不會產生調度路線。</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <ModalPicker v-model="selectedDistrict" label="行政區" title="選擇行政區" :options="districtPickerOptions" />
        <div class="grid min-w-0 gap-1.5 text-base font-bold text-muted">
          <span>風險類型</span>
          <div class="grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface p-1" role="group" aria-label="風險類型篩選">
            <button v-for="item in riskFilterOptions" :key="item.value" class="min-h-11 rounded-md px-2 text-base font-semibold transition-colors" :class="riskFilter === item.value ? 'bg-accent text-on-accent shadow-sm' : 'text-muted hover:bg-panel hover:text-ink'" type="button" :aria-pressed="riskFilter === item.value" @click="riskFilter = item.value">{{ item.label }}</button>
          </div>
        </div>
      </div>
    </section>

    <section class="flex items-start gap-3 rounded-lg border border-line bg-panel-muted p-4 text-base leading-6 text-muted">
      <Icon class="mt-1 shrink-0 text-xl text-info" icon="solar:info-circle-outline" />
      <p class="m-0"><strong class="text-ink">優先分數不是發生機率。</strong> 由 60 分鐘風險 25 分、當下空／滿 50 分、庫存缺口 20 分、資料品質 5 分組成；當下已空／滿一定高於純預測告警。{{ ALERT_PRIORITY_THRESHOLDS.immediate }} 分以上立即關注，{{ ALERT_PRIORITY_THRESHOLDS.high }}～{{ ALERT_PRIORITY_THRESHOLDS.immediate - 1 }} 分列為高優先。</p>
    </section>

    <div v-if="live.error.value && dashboard" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ live.error.value }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />正在取得官方即時資料…</div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ live.error.value }}<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>

    <template v-else-if="dashboard">
      <AlertList
        v-if="showInventory"
        :alerts="inventoryAlerts"
        :stations="dashboard.stations"
        :title="`庫存風險 ${inventoryAlerts.length} 站`"
        empty-message="目前沒有符合條件的缺車或缺位風險。"
        @select="navigateTo({ path: '/stations/' + $event, query: contextQuery })"
      />
      <AlertList
        v-if="showService"
        kind="service"
        :alerts="serviceAlerts"
        :stations="dashboard.stations"
        :title="`服務狀態異常 ${serviceAlerts.length} 站`"
        empty-message="目前沒有官方停用或疑似服務異常站點。"
        @select="navigateTo({ path: '/stations/' + $event, query: contextQuery })"
      />
    </template>
  </div>
</template>
