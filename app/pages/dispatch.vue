<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { ApiEnvelope, DashboardArtifact } from '~/shared/ops'

const { data: payload, refresh } = await useFetch<ApiEnvelope<DashboardArtifact>>('/api/v1/command-center')
const dashboard = computed(() => payload.value?.data)
const proposedCount = computed(() => dashboard.value?.dispatches.filter(item => item.status === 'proposed').length || 0)

async function accept(dispatchId: string) {
  await $fetch(`/api/v1/dispatches/${dispatchId}/accept`, { method: 'POST' })
  await refresh()
}
</script>

<template>
  <div class="subpage">
    <section class="subpage-hero panel dispatch-hero">
      <div>
        <p class="section-kicker"><Icon icon="solar:routing-2-outline" /> 人工覆核的建議派車</p>
        <h2>{{ proposedCount }} 筆任務等待指派。</h2>
        <p>每筆建議都保留來源、目的、台數、距離與理由；系統不會自動派車。</p>
      </div>
      <div class="dispatch-hero-stat"><Icon icon="solar:shield-check-outline" /><span>約束檢查已通過</span></div>
    </section>
    <DispatchList v-if="dashboard" :dispatches="dashboard.dispatches" :stations="dashboard.stations" @select="navigateTo(`/stations/${$event}`)" @accept="accept" />
  </div>
</template>
