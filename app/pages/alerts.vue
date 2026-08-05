<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { AlertStatus } from '~/shared/ops'

const replay = useReplayDashboard()
const status = ref<'all' | AlertStatus>('all')
const statusOptions: Array<{ value: 'all' | AlertStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '待確認' },
  { value: 'acknowledged', label: '已確認' },
]

const dashboard = computed(() => replay.dashboardForDistrict())
const filteredAlerts = computed(() => dashboard.value?.alerts.filter(alert => status.value === 'all' || alert.status === status.value) || [])

function acknowledge(alertId: string) {
  replay.acknowledge(alertId)
}

onMounted(() => {
  void replay.loadScenario()
})
</script>

<template>
  <div class="subpage">
    <section class="subpage-hero panel">
      <div>
        <p class="section-kicker"><Icon icon="solar:bell-bing-outline" /> 持續異常管理</p>
        <h2>先確認風險，再安排人員處置。</h2>
        <p>告警與確認狀態僅存在於目前 Demo 瀏覽器工作階段，不會送出真實營運指令。</p>
      </div>
      <div class="segmented" role="group" aria-label="告警狀態篩選">
        <button v-for="item in statusOptions" :key="item.value" type="button" :class="{ active: status === item.value }" @click="status = item.value">{{ item.label }}</button>
      </div>
    </section>
    <div v-if="replay.pending && !dashboard" class="loading-board"><Icon icon="svg-spinners:3-dots-fade" />正在載入歷史調度情境…</div>
    <div v-else-if="replay.error && !dashboard" class="loading-board error-board"><Icon icon="solar:danger-triangle-outline" />{{ replay.error }}</div>
    <AlertList v-else-if="dashboard" :alerts="filteredAlerts" :stations="dashboard.stations" @select="navigateTo('/stations/' + $event)" @acknowledge="acknowledge" />
  </div>
</template>
