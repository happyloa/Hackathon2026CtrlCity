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
  <details class="panel evidence-panel">
    <summary class="evidence-summary">
      <span><Icon icon="solar:chart-square-outline" /> 可驗證的方案效益</span>
      <span class="evidence-summary-copy">查看保留測試與反事實試算</span>
      <Icon class="evidence-summary-arrow" icon="solar:alt-arrow-down-outline" />
    </summary>
    <div class="evidence-content">
    <div class="panel-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:chart-square-outline" /> 可驗證的方案效益</p>
        <h2 id="evidence-title">從「有預測」進一步說明能改善什麼</h2>
      </div>
      <span class="evidence-badge">離線保留測試</span>
    </div>

    <div class="evidence-grid">
      <article>
        <span>60 分鐘預判</span>
        <strong>{{ holdout.correctlyFlaggedSnapshots.toLocaleString() }}</strong>
        <p>在 2026 年 6 月保留測試中，對 60 分鐘後的實際空／滿站快照正確標記 {{ percent(holdout.recall) }}。</p>
      </article>
      <article>
        <span>模型基線品質</span>
        <strong>F1 {{ percent(holdout.f1) }}</strong>
        <p>固定 217 站時間外測試；這是可解釋啟發式基線，不是經校準的事件機率。</p>
      </article>
      <article v-if="dataMode === 'historical_replay' && scenario">
        <span>情境調度試算</span>
        <strong>{{ scenario.immediatelyAddressedStations }} 站</strong>
        <p>{{ scenario.feasibleMoves }} 筆可行搬運、共 {{ scenario.bikesMoved }} 台；當下空／滿站由 {{ scenario.beforeIssueStations }} 降至 {{ scenario.afterIssueStations }}（{{ percent(scenario.reductionRate) }}）。</p>
      </article>
      <article v-else-if="dataMode === 'live'">
        <span>即時決策閉環</span>
        <strong>人工覆核</strong>
        <p>即時風險會轉成告警與搬運建議；確認與指派只保存在目前瀏覽器工作階段。</p>
      </article>
      <article v-else>
        <span>情境調度試算</span>
        <strong>資料待確認</strong>
        <p>目前回放時點沒有對應的效益產物，不以即時模式資訊替代。</p>
      </article>
    </div>

    <p class="evidence-note"><Icon icon="solar:info-circle-outline" /> 調度數字是歷史庫存反事實試算，不代表已在真實車隊執行或保證相同成效。</p>
    </div>
  </details>
</template>

<style scoped>
.evidence-panel { overflow: hidden; }
.evidence-summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 13px 16px; color: var(--ink); cursor: pointer; list-style: none; font-size: 16px; font-weight: 800; }
.evidence-summary::-webkit-details-marker { display: none; }
.evidence-summary > span:first-child { display: inline-flex; align-items: center; gap: 7px; }
.evidence-summary > span:first-child svg { color: var(--teal-dark); font-size: 20px; }
.evidence-summary-copy { color: var(--muted); font-weight: 650; text-align: right; }
.evidence-summary-arrow { color: var(--teal-dark); font-size: 19px; transition: transform .18s ease; }
.evidence-panel[open] .evidence-summary { border-bottom: 1px solid var(--line); }
.evidence-panel[open] .evidence-summary-arrow { transform: rotate(180deg); }
.evidence-content { padding: 18px 20px 20px; }
.evidence-badge { align-self: flex-start; padding: 5px 8px; color: var(--teal-dark); background: var(--surface-muted); border: 1px solid var(--line-strong); border-radius: 5px; font-size: 16px; font-weight: 800; }
.evidence-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.evidence-grid article { min-width: 0; padding: 16px; background: var(--panel); }
.evidence-grid article + article { border-left: 1px solid var(--line); }
.evidence-grid span { display: block; margin-bottom: 6px; color: var(--muted); font-size: 16px; font-weight: 750; }
.evidence-grid strong { display: block; color: var(--ink); font-size: clamp(24px, 2.2vw, 34px); line-height: 1.1; }
.evidence-grid p { margin: 9px 0 0; color: var(--muted); font-size: 16px; line-height: 1.55; }
.evidence-note { display: flex; align-items: flex-start; gap: 7px; margin: 12px 0 0; color: var(--muted); font-size: 16px; font-weight: 650; }
.evidence-note svg { flex: 0 0 auto; margin-top: 2px; color: var(--blue); font-size: 19px; }
:global(html[data-theme='dark'] .evidence-badge) { color: var(--teal); background: var(--surface-muted); }
@media (max-width: 900px) { .evidence-grid { grid-template-columns: 1fr; }.evidence-grid article + article { border-top: 1px solid var(--line); border-left: 0; } }
@media (max-width: 620px) { .evidence-summary { grid-template-columns: minmax(0, 1fr) auto; }.evidence-summary-copy { display: none; }.evidence-content { padding: 16px; } }
</style>
