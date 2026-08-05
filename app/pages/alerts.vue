<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { AlertStatus, ApiEnvelope, DashboardArtifact } from '~/shared/ops'

const status = ref<'all' | AlertStatus>('all')
const statusOptions: Array<{ value: 'all' | AlertStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '待確認' },
  { value: 'acknowledged', label: '已確認' },
]
const { data: payload, refresh } = await useFetch<ApiEnvelope<DashboardArtifact>>('/api/v1/command-center')
const dashboard = computed(() => payload.value?.data)
const filteredAlerts = computed(() => dashboard.value?.alerts.filter(alert => status.value === 'all' || alert.status === status.value) || [])

async function acknowledge(alertId: string) {
  await $fetch(`/api/v1/alerts/${alertId}/ack`, { method: 'POST' })
  await refresh()
}
</script>

<template>
  <div class="subpage">
    <section class="subpage-hero panel">
      <div>
        <p class="section-kicker"><Icon icon="solar:bell-bing-outline" /> 持續異常與預測告警</p>
        <h2>先確認異常，再決定是否派車。</h2>
        <p>告警只根據已知庫存、時間序列與風險規則建立；站點不可用會獨立標示。</p>
      </div>
      <div class="segmented" role="group" aria-label="告警狀態篩選">
        <button v-for="item in statusOptions" :key="item.value" type="button" :class="{ active: status === item.value }" @click="status = item.value">{{ item.label }}</button>
      </div>
    </section>
    <AlertList v-if="dashboard" :alerts="filteredAlerts" :stations="dashboard.stations" @select="navigateTo(`/stations/${$event}`)" @acknowledge="acknowledge" />
  </div>
</template>
