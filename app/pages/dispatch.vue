<script setup lang="ts">
import { Icon } from '@iconify/vue'

const replay = useReplayDashboard()
const dashboard = computed(() => replay.dashboardForDistrict())
const proposedCount = computed(() => dashboard.value?.dispatches.filter(item => item.status === 'proposed').length || 0)

function accept(dispatchId: string) {
  replay.acceptDispatch(dispatchId)
}

onMounted(() => {
  void replay.loadScenario()
})
</script>

<template>
  <div class="subpage">
    <section class="subpage-hero panel dispatch-hero">
      <div>
        <p class="section-kicker"><Icon icon="solar:routing-2-outline" /> 人工覆核後再派車</p>
        <h2>{{ proposedCount }} 筆待覆核補車建議</h2>
        <p>建議量由歷史風險、庫存與站點距離產生；指派只示範值班人員的接受狀態，不會連動真實車隊。</p>
      </div>
      <div class="dispatch-hero-stat"><Icon icon="solar:shield-check-outline" /><span>需人工覆核</span></div>
    </section>
    <div v-if="replay.pending && !dashboard" class="loading-board"><Icon icon="svg-spinners:3-dots-fade" />正在載入歷史調度情境…</div>
    <div v-else-if="replay.error && !dashboard" class="loading-board error-board"><Icon icon="solar:danger-triangle-outline" />{{ replay.error }}</div>
    <DispatchList v-else-if="dashboard" :dispatches="dashboard.dispatches" :stations="dashboard.stations" @select="navigateTo('/stations/' + $event)" @accept="accept" />
  </div>
</template>
