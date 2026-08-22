<script setup lang="ts">
import { Icon } from '@iconify/vue'

const replay = useReplayDashboard()
const live = useLiveDashboard()
const route = useRoute()
const mode = computed(() => route.query.mode === 'historical_replay' ? 'historical_replay' : 'live')
const district = computed(() => typeof route.query.district === 'string' ? route.query.district : '')
const requestedAsOf = computed(() => typeof route.query.at === 'string' ? route.query.at : undefined)
useLivePolling(live.refresh, computed(() => mode.value === 'live'))
const dashboard = computed(() => mode.value === 'live'
  ? live.dashboardForDistrict(district.value)
  : replay.dashboardForDistrict(district.value))
const activePending = computed(() => mode.value === 'live' ? live.pending.value : replay.pending.value)
const activeError = computed(() => mode.value === 'live' ? live.error.value : replay.error.value)
const proposedCount = computed(() => dashboard.value?.dispatches.filter(item => item.status === 'proposed').length || 0)
const contextQuery = computed(() => Object.fromEntries(
  ['mode', 'at', 'district']
    .map(key => [key, route.query[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])),
))

function accept(dispatchId: string) {
  if (mode.value === 'live') live.acceptDispatch(dispatchId)
  else replay.acceptDispatch(dispatchId)
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
  <div class="subpage">
    <WorkspaceContext :mode="mode" :district="district" :data-time="dashboard?.meta.asOf" :query="contextQuery" />
    <section class="subpage-hero panel dispatch-hero">
      <div>
        <p class="section-kicker"><Icon icon="solar:routing-2-outline" /> {{ mode === 'live' ? '即時調度決策支援' : '歷史調度回放' }}</p>
        <h2>{{ proposedCount }} 筆待覆核搬運建議</h2>
        <p>建議量由{{ mode === 'live' ? '最新官方庫存、60 分鐘風險' : '歷史風險、庫存' }}與站點距離產生；指派只示範值班人員的接受狀態，不會連動真實車隊。</p>
      </div>
      <div class="dispatch-hero-stat"><Icon icon="solar:shield-check-outline" /><span>需人工覆核</span></div>
    </section>
    <div v-if="activeError && dashboard" class="live-inline-error" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ activeError }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <div v-if="activePending && !dashboard" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />{{ mode === 'live' ? '正在建立即時調度建議…' : '正在載入歷史調度情境…' }}</div>
    <div v-else-if="activeError && !dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ activeError }}<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <DispatchList v-else-if="dashboard" :dispatches="dashboard.dispatches" :stations="dashboard.stations" @select="navigateTo({ path: '/stations/' + $event, query: contextQuery })" @accept="accept" />
  </div>
</template>
