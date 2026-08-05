<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { HorizonKey } from '~/shared/ops'

const props = defineProps<{ asOf: string; horizon: HorizonKey; district?: string }>()
const pending = ref(false)
const briefing = ref<{ provider: string; headline: string; narrative: string; citedFacts: Array<{ label: string; value: string | number }> } | null>(null)
const errorMessage = ref('')

async function generate() {
  pending.value = true
  errorMessage.value = ''
  try {
    briefing.value = await $fetch('/api/v1/briefings', { method: 'POST', body: { asOf: props.asOf, horizonMinutes: Number(props.horizon), district: props.district || undefined } })
  } catch {
    errorMessage.value = '暫時無法產生調度簡報，請稍後再試。'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <section class="briefing-card">
    <div class="briefing-orb"><Icon icon="solar:magic-stick-3-outline" /></div>
    <div class="briefing-copy">
      <p class="section-kicker">生成式 AI 調度晨報</p>
      <h2>{{ briefing?.headline || '把已驗證的風險，整理成當班優先事項。' }}</h2>
      <p>{{ briefing?.narrative || '只使用目前畫面的資料與調度建議；不讓模型自行創造數字或派車量。' }}</p>
      <div v-if="briefing?.citedFacts?.length" class="fact-pills">
        <span v-for="fact in briefing.citedFacts" :key="`${fact.label}-${fact.value}`">{{ fact.label }}：<b>{{ fact.value }}</b></span>
      </div>
      <p v-if="errorMessage" class="error-copy">{{ errorMessage }}</p>
    </div>
    <button type="button" class="briefing-button" :disabled="pending" @click="generate">
      <Icon :icon="pending ? 'svg-spinners:3-dots-fade' : 'solar:stars-minimalistic-outline'" />
      {{ pending ? '整理中' : '產生本班簡報' }}
    </button>
  </section>
</template>
