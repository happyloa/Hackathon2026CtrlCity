<script setup lang="ts">
import { Icon } from '@iconify/vue'
import impact from '~/data/operational-impact.json'

const props = defineProps<{
  asOf?: string
  dataMode: 'historical_replay' | 'live'
}>()

const holdout = impact.forecastHoldout.horizons['60']
const scenario = computed(() => {
  if (!props.asOf) return null
  return impact.dispatchSimulation.scenarios[props.asOf as keyof typeof impact.dispatchSimulation.scenarios] || null
})
const percent = (value: number) => `${(value * 100).toFixed(1)}%`
</script>

<template>
  <section class="panel overflow-hidden" aria-labelledby="evidence-title">
    <div class="p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p class="section-kicker text-base"><Icon icon="solar:chart-square-outline" /> 離線驗證</p>
          <h2 id="evidence-title" class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">預測與調度證據</h2>
        </div>
        <span class="self-start rounded-md border border-line-strong bg-panel-muted px-2 py-1 text-base font-bold text-accent">保留測試</span>
      </div>

      <div class="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
        <article class="min-w-0 bg-panel p-4">
          <span class="mb-2 block text-base font-semibold text-muted">60 分鐘預判</span>
          <strong class="block text-2xl font-bold leading-tight text-ink sm:text-3xl">{{ holdout.correctlyFlaggedSnapshots.toLocaleString() }}</strong>
          <p class="m-0 mt-2 text-base leading-6 text-muted">在 2026 年 6 月保留測試中，對 60 分鐘後的實際空／滿站快照正確標記 {{ percent(holdout.recall) }}。</p>
        </article>
        <article class="min-w-0 bg-panel p-4">
          <span class="mb-2 block text-base font-semibold text-muted">模型基線品質</span>
          <strong class="block text-2xl font-bold leading-tight text-ink sm:text-3xl">F1 {{ percent(holdout.f1) }}</strong>
          <p class="m-0 mt-2 text-base leading-6 text-muted">固定 217 站時間外測試；這是可解釋啟發式基線，不是經校準的事件機率。</p>
        </article>
        <article v-if="dataMode === 'historical_replay' && scenario" class="min-w-0 bg-panel p-4">
          <span class="mb-2 block text-base font-semibold text-muted">情境調度試算</span>
          <strong class="block text-2xl font-bold leading-tight text-ink sm:text-3xl">{{ scenario.immediatelyAddressedStations }} 站</strong>
          <p class="m-0 mt-2 text-base leading-6 text-muted">{{ scenario.feasibleMoves }} 筆可行搬運、共 {{ scenario.bikesMoved }} 台；當下空／滿站由 {{ scenario.beforeIssueStations }} 降至 {{ scenario.afterIssueStations }}（{{ percent(scenario.reductionRate) }}）。</p>
        </article>
        <article v-else-if="dataMode === 'live'" class="min-w-0 bg-panel p-4">
          <span class="mb-2 block text-base font-semibold text-muted">即時決策閉環</span>
          <strong class="block text-2xl font-bold leading-tight text-ink sm:text-3xl">人工覆核</strong>
          <p class="m-0 mt-2 text-base leading-6 text-muted">即時風險會轉成告警與搬運建議；確認與指派只保存在目前瀏覽器工作階段。</p>
        </article>
        <article v-else class="min-w-0 bg-panel p-4">
          <span class="mb-2 block text-base font-semibold text-muted">情境調度試算</span>
          <strong class="block text-2xl font-bold leading-tight text-ink sm:text-3xl">資料待確認</strong>
          <p class="m-0 mt-2 text-base leading-6 text-muted">目前回放時點沒有對應的效益產物，不以即時模式資訊替代。</p>
        </article>
      </div>

      <p class="m-0 mt-3 flex items-start gap-2 text-base font-semibold leading-6 text-muted"><Icon class="mt-1 shrink-0 text-lg text-info" icon="solar:info-circle-outline" /> 調度數字是歷史庫存反事實試算，不代表已在真實車隊執行或保證相同成效。</p>
    </div>
  </section>
</template>
