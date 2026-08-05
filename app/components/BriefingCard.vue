<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { BriefingFact, DashboardSummary, HorizonKey } from '~/shared/ops'

const props = defineProps<{
  asOf: string
  horizon: HorizonKey
  district?: string
  facts?: BriefingFact[]
  summary?: DashboardSummary
}>()

const pending = ref(false)
const briefing = ref<{
  provider: string
  headline: string
  narrative: string
  citedFacts: Array<{ label: string; value: string | number }>
} | null>(null)

function generate() {
  pending.value = true

  window.setTimeout(() => {
    const citedFacts = (props.facts || []).slice(0, 4).map(fact => ({
      label: fact.label,
      value: fact.value,
    }))
    const place = props.district || '新北市'
    const highRisk = props.summary?.highRiskNext60m || 0
    const dispatches = props.summary?.recommendedMoves || 0

    briefing.value = {
      provider: 'template',
      headline: place + '未來 ' + props.horizon + ' 分鐘調度重點',
      narrative: highRisk
        ? '目前有 ' + highRisk + ' 個高風險站點，建議先由調度人員覆核 ' + dispatches + ' 筆補車建議，再依現場車況執行。'
        : '目前沒有高風險站點；請持續監控即時庫存與下一個來源更新時點。',
      citedFacts,
    }
    pending.value = false
  }, 180)
}
</script>

<template>
  <section class="briefing-card">
    <div class="briefing-orb"><Icon icon="solar:magic-stick-3-outline" /></div>
    <div class="briefing-copy">
      <p class="section-kicker">受控規則摘要</p>
      <h2>{{ briefing?.headline || '把已驗證的風險，整理成當班優先事項。' }}</h2>
      <p>{{ briefing?.narrative || '只使用目前畫面的資料與調度建議；不讓摘要自行創造數字或派車量。' }}</p>
      <div v-if="briefing?.citedFacts?.length" class="fact-pills">
        <span v-for="fact in briefing.citedFacts" :key="fact.label + '-' + fact.value">{{ fact.label }}：<b>{{ fact.value }}</b></span>
      </div>
    </div>
    <button type="button" class="briefing-button" :disabled="pending" @click="generate">
      <Icon :icon="pending ? 'svg-spinners:3-dots-fade' : 'solar:stars-minimalistic-outline'" />
      {{ pending ? '整理中' : '產生交班摘要' }}
    </button>
  </section>
</template>
