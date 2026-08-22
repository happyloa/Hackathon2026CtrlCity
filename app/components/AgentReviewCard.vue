<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { BriefingFact, DashboardSummary, HorizonKey } from '~/shared/ops'

const props = defineProps<{
  asOf: string
  horizon: HorizonKey
  district?: string
  facts?: BriefingFact[]
  summary: DashboardSummary
}>()

type ReviewResult = {
  headline: string
  narrative: string
  cautions: string[]
  citations: Array<{ label: string, source?: string }>
}

const config = useRuntimeConfig()
const enabled = computed(() => String(config.public.agentEnabled) === 'true')
const endpoint = computed(() => String(config.public.agentReviewEndpoint || '/api/v1/agent-review'))
const pending = ref(false)
const error = ref('')
const result = ref<ReviewResult | null>(null)
let activeController: AbortController | null = null
let requestSequence = 0
const reviewContextKey = computed(() => JSON.stringify({
  asOf: props.asOf,
  district: props.district || '新北市',
  horizon: props.horizon,
  summary: {
    recommendedMoves: props.summary.recommendedMoves,
    persistentAlerts: props.summary.persistentAlerts,
    emptyNow: props.summary.emptyNow,
    fullNow: props.summary.fullNow,
  },
  facts: (props.facts || []).slice(0, 8),
}))

function validReview(value: unknown): value is { data: ReviewResult } {
  if (!value || typeof value !== 'object') return false
  const data = (value as { data?: unknown }).data
  if (!data || typeof data !== 'object') return false
  const review = data as Partial<ReviewResult>
  return typeof review.headline === 'string'
    && typeof review.narrative === 'string'
    && Array.isArray(review.cautions)
    && Array.isArray(review.citations)
}

async function requestReview() {
  if (!enabled.value || pending.value) return
  pending.value = true
  error.value = ''
  const sequence = ++requestSequence
  const controller = new AbortController()
  activeController = controller
  const timeout = window.setTimeout(() => controller.abort(), 25_000)

  try {
    const response = await fetch(endpoint.value, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        asOf: props.asOf,
        district: props.district || '新北市',
        horizonMinutes: Number(props.horizon),
        summary: {
          recommendedMoves: props.summary.recommendedMoves,
          persistentAlerts: props.summary.persistentAlerts,
          emptyNow: props.summary.emptyNow,
          fullNow: props.summary.fullNow,
        },
        facts: (props.facts || []).slice(0, 8).map(fact => ({
          label: fact.label,
          value: fact.value,
          stationId: fact.stationId,
          alertId: fact.alertId,
          dispatchId: fact.dispatchId,
        })),
      }),
    })
    const responseText = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(responseText)
    } catch {
      throw new Error(response.ok ? 'AWS AgentCore 回傳格式無法讀取。' : 'AWS AgentCore 暫時無法完成覆核。')
    }
    if (sequence !== requestSequence) return
    if (!response.ok || !validReview(payload)) throw new Error('AWS AgentCore 暫時無法完成覆核。')
    result.value = payload.data
  } catch (cause) {
    if (sequence !== requestSequence) return
    error.value = cause instanceof DOMException && cause.name === 'AbortError'
      ? '覆核逾時，請稍後再試。'
      : cause instanceof Error ? cause.message : '覆核暫時無法使用。'
  } finally {
    window.clearTimeout(timeout)
    if (sequence === requestSequence) {
      activeController = null
      pending.value = false
    }
  }
}

watch(reviewContextKey, () => {
  requestSequence += 1
  activeController?.abort()
  activeController = null
  pending.value = false
  result.value = null
  error.value = ''
})

onBeforeUnmount(() => {
  requestSequence += 1
  activeController?.abort()
})
</script>

<template>
  <section v-if="enabled" class="agent-review" aria-labelledby="agent-review-title">
    <div class="agent-review-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:shield-check-outline" /> AWS AgentCore 覆核</p>
        <h2 id="agent-review-title">AI 調度覆核</h2>
        <p>只傳送畫面上的摘要事實；Agent 不重算風險，也不會自動派車。</p>
      </div>
      <button type="button" :disabled="pending" @click="requestReview">
        <Icon :icon="pending ? 'svg-spinners:3-dots-fade' : 'solar:chat-round-check-outline'" />
        {{ pending ? '覆核中' : (result ? '重新覆核' : '開始覆核') }}
      </button>
    </div>

    <div class="agent-review-result" role="status" aria-live="polite" :aria-busy="pending">
      <p v-if="error" class="agent-review-error"><Icon icon="solar:danger-triangle-outline" />{{ error }}</p>
      <template v-else-if="result">
        <h3>{{ result.headline }}</h3>
        <p>{{ result.narrative }}</p>
        <ul v-if="result.cautions.length">
          <li v-for="item in result.cautions" :key="item">{{ item }}</li>
        </ul>
        <div v-if="result.citations.length" class="agent-review-citations">
          <span v-for="citation in result.citations" :key="`${citation.label}-${citation.source || ''}`">
            <Icon icon="solar:document-text-outline" />{{ citation.label }}<small v-if="citation.source">{{ citation.source }}</small>
          </span>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.agent-review { margin-bottom: 14px; padding: 16px; background: var(--surface-muted); border: 1px solid var(--line); border-left: 3px solid var(--teal-dark); border-radius: 6px; }
.agent-review-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.agent-review h2, .agent-review h3 { margin: 0; color: var(--ink); }
.agent-review h2 { font-size: 18px; }.agent-review h3 { font-size: 17px; }
.agent-review-heading p:not(.section-kicker), .agent-review-result > p { margin: 6px 0 0; color: var(--muted); font-size: 16px; line-height: 1.55; }
.agent-review button { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 8px 11px; color: var(--on-accent); background: var(--teal-dark); border: 1px solid var(--teal-dark); border-radius: 5px; font: inherit; font-size: 16px; font-weight: 700; }
.agent-review button:disabled { cursor: wait; opacity: .72; }
.agent-review-result:not(:empty) { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.agent-review-result ul { display: grid; gap: 5px; margin: 10px 0 0; padding-left: 22px; color: var(--ink-soft); font-size: 16px; }
.agent-review-error { display: flex; align-items: center; gap: 6px; color: var(--red) !important; }
.agent-review-citations { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 11px; }
.agent-review-citations span { display: inline-flex; align-items: center; gap: 4px; padding: 5px 7px; color: var(--ink-soft); background: var(--panel); border: 1px solid var(--line); border-radius: 4px; font-size: 16px; }
.agent-review-citations small { color: var(--muted); font-size: 16px; }
@media (max-width: 620px) { .agent-review-heading { align-items: stretch; flex-direction: column; }.agent-review button { width: 100%; } }
</style>
