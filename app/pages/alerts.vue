<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { AlertStatus } from '~/shared/ops'

const replay = useReplayDashboard()
const live = useLiveDashboard()
const route = useRoute()
const mode = computed(() => route.query.mode === 'historical_replay' ? 'historical_replay' : 'live')
const district = computed(() => typeof route.query.district === 'string' ? route.query.district : '')
const requestedAsOf = computed(() => typeof route.query.at === 'string' ? route.query.at : undefined)
const status = ref<'all' | AlertStatus>('all')
const statusOptions: Array<{ value: 'all' | AlertStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '待確認' },
  { value: 'acknowledged', label: '已確認' },
]
useLivePolling(live.refresh, computed(() => mode.value === 'live'))

const dashboard = computed(() => mode.value === 'live'
  ? live.dashboardForDistrict(district.value)
  : replay.dashboardForDistrict(district.value))
const activePending = computed(() => mode.value === 'live' ? live.pending.value : replay.pending.value)
const activeError = computed(() => mode.value === 'live' ? live.error.value : replay.error.value)
const filteredAlerts = computed(() => dashboard.value?.alerts.filter(alert => status.value === 'all' || alert.status === status.value) || [])
const contextQuery = computed(() => Object.fromEntries(
  ['mode', 'at', 'district']
    .map(key => [key, route.query[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])),
))

function acknowledge(alertId: string) {
  if (mode.value === 'live') live.acknowledge(alertId)
  else replay.acknowledge(alertId)
}

function retryDashboard() {
  if (mode.value === 'live') void live.refresh({ manual: true })
  else void replay.loadScenario(requestedAsOf.value)
}

watch([mode, requestedAsOf], ([nextMode, nextAsOf]) => {
  if (nextMode === 'historical_replay') void replay.loadScenario(nextAsOf)
}, { immediate: true })
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <WorkspaceContext :mode="mode" :district="district" :data-time="dashboard?.meta.asOf" :query="contextQuery" />
    <section class="panel flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
      <div class="min-w-0">
        <p class="section-kicker text-base"><Icon icon="solar:bell-bing-outline" /> {{ mode === 'live' ? '官方即時風險' : '歷史持續異常' }}</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">先確認風險，再安排人員處置。</h2>
        <p class="mt-2 max-w-3xl text-base leading-7 text-muted">{{ mode === 'live' ? '即時空／滿站由官方庫存偵測；已對照基線的站點另計算 60 分鐘風險。' : '告警來自所選歷史回放時點，可用來重現值班判斷。' }}確認狀態只存在於目前 Demo 瀏覽器工作階段。</p>
      </div>
      <div class="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface p-1 lg:w-80" role="group" aria-label="告警狀態篩選">
        <button v-for="item in statusOptions" :key="item.value" class="min-h-11 rounded-md px-2 text-base font-semibold transition-colors" :class="status === item.value ? 'bg-accent text-on-accent shadow-sm' : 'text-muted hover:bg-panel hover:text-ink'" type="button" :aria-pressed="status === item.value" @click="status = item.value">{{ item.label }}</button>
      </div>
    </section>
    <div v-if="activeError && dashboard" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ activeError }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <div v-if="activePending && !dashboard" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />{{ mode === 'live' ? '正在取得官方即時資料…' : '正在載入歷史調度情境…' }}</div>
    <div v-else-if="activeError && !dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ activeError }}<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <AlertList v-else-if="dashboard" :alerts="filteredAlerts" :stations="dashboard.stations" @select="navigateTo({ path: '/stations/' + $event, query: contextQuery })" @acknowledge="acknowledge" />
  </div>
</template>
