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
const resultClasses = {
  empty: '',
  visible: 'mt-4 border-t border-line pt-4',
} as const
let activeController: AbortController | null = null
let requestSequence = 0
const reviewContextKey = computed(() => JSON.stringify({
  asOf: props.asOf,
  district: props.district || '全新北市',
  horizon: props.horizon,
  summary: {
    recommendedMoves: props.summary.recommendedMoves,
    inventoryAlerts: props.summary.inventoryAlerts,
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
        district: props.district || '全新北市',
        horizonMinutes: Number(props.horizon),
        summary: {
          recommendedMoves: props.summary.recommendedMoves,
          inventoryAlerts: props.summary.inventoryAlerts,
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
      throw new Error(response.ok ? 'AI 回覆格式有誤。' : 'AI 說明暫時無法使用。')
    }
    if (sequence !== requestSequence) return
    if (!response.ok || !validReview(payload)) throw new Error('AI 說明暫時無法使用。')
    result.value = payload.data
  } catch (cause) {
    if (sequence !== requestSequence) return
    error.value = cause instanceof DOMException && cause.name === 'AbortError'
      ? '等候時間過久，請再試一次。'
      : cause instanceof Error ? cause.message : 'AI 說明暫時無法使用。'
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
  <section v-if="enabled" class="mb-4 rounded-lg border border-line border-l-4 border-l-accent bg-panel-muted p-4" aria-labelledby="agent-review-title">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:chat-round-dots-outline" /> AWS AgentCore</p>
        <h2 id="agent-review-title" class="m-0 mt-1 text-lg font-bold text-ink">AI 站況摘要</h2>
      </div>
      <button type="button" class="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md border border-accent bg-accent px-3 text-base font-bold text-on-accent transition-colors hover:bg-accent-strong sm:w-auto" :disabled="pending" @click="requestReview">
        <Icon :icon="pending ? 'svg-spinners:3-dots-fade' : 'solar:chat-round-check-outline'" />
        {{ pending ? '整理中' : (result ? '重新整理' : '產生摘要') }}
      </button>
    </div>

    <div role="status" aria-live="polite" :aria-busy="pending" :class="result || error ? resultClasses.visible : resultClasses.empty">
      <p v-if="error" class="m-0 flex items-center gap-2 text-base font-semibold leading-6 text-danger"><Icon class="shrink-0 text-lg" icon="solar:danger-triangle-outline" />{{ error }}</p>
      <template v-else-if="result">
        <h3 class="m-0 text-lg font-bold text-ink">{{ result.headline }}</h3>
        <p class="m-0 mt-2 text-base leading-6 text-muted">{{ result.narrative }}</p>
        <ul v-if="result.cautions.length" class="m-0 mt-3 grid list-disc gap-1 pl-5 text-base leading-6 text-ink">
          <li v-for="item in result.cautions" :key="item">{{ item }}</li>
        </ul>
        <div v-if="result.citations.length" class="mt-3 flex flex-wrap gap-2">
          <span v-for="citation in result.citations" :key="`${citation.label}-${citation.source || ''}`" class="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-base text-ink">
            <Icon icon="solar:document-text-outline" />{{ citation.label }}<small v-if="citation.source">{{ citation.source }}</small>
          </span>
        </div>
      </template>
    </div>
  </section>
</template>
