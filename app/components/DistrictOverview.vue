<script setup lang="ts">
import { ArrowUpRight, ChevronDown, Map as MapIcon, MapPin, X } from '@lucide/vue'
import { districtAttentionTone, type DistrictSummary } from '~/shared/district-summary'
import districtShapes from '~/assets/data/ntpc-district-shapes.json'

const props = defineProps<{ summaries: DistrictSummary[]; selectedDistrict: string }>()
const emit = defineEmits<{ select: [district: string] }>()
const showAll = ref(false)
const hoveredDistrict = ref('')
const lookup = computed(() => new Map(props.summaries.map(item => [item.district, item])))
const totalStations = computed(() => props.summaries.reduce((sum, item) => sum + item.total, 0))
const featured = computed(() => {
  const result = props.summaries.slice(0, 3)
  const selected = lookup.value.get(props.selectedDistrict)
  if (selected && !result.some(item => item.district === selected.district)) result.splice(2, 1, selected)
  return result
})
const mapDistrict = computed(() => hoveredDistrict.value || props.selectedDistrict)
const mapSummary = computed(() => lookup.value.get(mapDistrict.value))
const mapLabel = computed(() => districtShapes.districts.find(item => item.name === mapDistrict.value))
const segments = [
  { key: 'empty', label: '缺車', color: 'var(--danger)' },
  { key: 'full', label: '缺位', color: 'var(--info)' },
  { key: 'stable', label: '穩定', color: 'var(--positive)' },
  { key: 'unknown', label: '資料不足', color: 'var(--warning)' },
  { key: 'service', label: '服務異常', color: 'var(--muted)' },
] as const
const legend = [
  { tone: 'quiet', label: '0%' }, { tone: 'low', label: '≤10%' },
  { tone: 'medium', label: '≤25%' }, { tone: 'high', label: '>25%' }, { tone: 'none', label: '資料不足' },
]
function choose(district: string) { emit('select', district === props.selectedDistrict ? '' : district) }
</script>

<template>
  <section class="district-overview" aria-label="行政區匯總">
    <div class="district-overview-main">
      <header class="district-overview-heading">
        <div><p class="district-eyebrow"><MapPin :size="15" aria-hidden="true" />全市營運概況</p><h2>行政區匯總 <span>{{ summaries.length }} 區 · {{ totalStations.toLocaleString() }} 站</span></h2></div>
        <button v-if="selectedDistrict" class="district-clear" type="button" @click="emit('select', '')">全部行政區<X :size="15" aria-hidden="true" /></button>
      </header>
      <p class="district-intro">缺車／缺位站數較多的區域優先顯示。選擇行政區，查看下方站點。</p>
      <div class="district-featured">
        <button v-for="summary in featured" :key="summary.district" type="button" class="district-card"
          :class="{ 'is-selected': summary.district === selectedDistrict }" :data-tone="districtAttentionTone(summary)"
          :aria-pressed="summary.district === selectedDistrict" :aria-label="`${summary.district}，${summary.total} 站，缺車或缺位 ${summary.attentionCount} 站，篩選此區`" @click="choose(summary.district)">
          <span class="district-card-title"><strong>{{ summary.district }}</strong><ArrowUpRight :size="17" aria-hidden="true" /></span>
          <span class="district-card-count"><b>{{ summary.attentionCount }}</b><span>站需關注<small>共 {{ summary.total }} 站</small></span></span>
          <span class="district-card-metrics"><span>60 分鐘平均風險<strong>{{ summary.averageRisk === null ? '—' : summary.averageRisk.toFixed(1) }}<small v-if="summary.averageRisk !== null"> / 100</small></strong></span><span>預測高風險<strong>{{ summary.forecastStations ? summary.highRiskStations : '—' }}<small> 站</small></strong></span></span>
          <span class="district-status-bar" aria-hidden="true"><i v-for="segment in segments" :key="segment.key" :style="{ width: `${summary.counts[segment.key] / summary.total * 100}%`, background: segment.color }" /></span>
          <span class="district-card-now"><span>目前空站 <b>{{ summary.emptyNow }}</b> · 滿站 <b>{{ summary.fullNow }}</b></span><span>{{ summary.district === selectedDistrict ? '已選取' : '查看站點' }}</span></span>
        </button>
      </div>
      <div class="district-legend"><span v-for="segment in segments" :key="segment.key"><i :style="{ background: segment.color }" />{{ segment.label }}</span></div>
      <button class="district-expand" type="button" :aria-expanded="showAll" aria-controls="district-all-list" @click="showAll = !showAll"><span>{{ showAll ? '收合行政區' : `查看全部 ${summaries.length} 個行政區` }}</span><ChevronDown :size="17" :class="{ rotated: showAll }" aria-hidden="true" /></button>
      <div v-if="showAll" id="district-all-list" class="district-all-list" role="group" aria-label="選擇行政區">
        <button v-for="summary in summaries" :key="summary.district" type="button" :data-tone="districtAttentionTone(summary)" :aria-pressed="summary.district === selectedDistrict" :class="{ 'is-selected': summary.district === selectedDistrict }" @click="choose(summary.district)"><span><i />{{ summary.district }}</span><b>{{ summary.attentionCount }}<small> / {{ summary.total }} 站</small></b></button>
      </div>
    </div>
    <aside class="district-map-panel" aria-label="區域地圖概覽">
      <header><h3><MapIcon :size="16" aria-hidden="true" />區域地圖概覽</h3><span>缺車／缺位站占比</span></header>
      <div class="district-map-focus" aria-live="polite"><template v-if="mapSummary"><strong>{{ mapSummary.district }}</strong><span>{{ mapSummary.attentionCount }} / {{ mapSummary.total }} 站 · {{ (mapSummary.attentionRate * 100).toFixed(1) }}%</span></template><template v-else><strong>{{ mapDistrict || '新北市' }}</strong><span>{{ mapDistrict ? '尚無站點資料' : '點選區域篩選站點' }}</span></template></div>
      <svg :viewBox="districtShapes.viewBox" class="district-map" role="group" aria-label="新北市行政區界，點選有站點資料的行政區以篩選">
        <path v-for="shape in districtShapes.districts" :key="shape.code" :d="shape.path" :data-tone="districtAttentionTone(lookup.get(shape.name))" :class="{ selected: shape.name === selectedDistrict, hovered: shape.name === hoveredDistrict }"
          role="button" :tabindex="lookup.has(shape.name) ? 0 : -1" :aria-disabled="!lookup.has(shape.name)" :aria-pressed="shape.name === selectedDistrict"
          :aria-label="`${shape.name}，${lookup.has(shape.name) ? `缺車或缺位 ${lookup.get(shape.name)!.attentionCount} 站，點選篩選` : '尚無站點資料'}`"
          @mouseenter="hoveredDistrict = shape.name" @mouseleave="hoveredDistrict = ''" @focus="hoveredDistrict = shape.name" @blur="hoveredDistrict = ''"
          @click="lookup.has(shape.name) && choose(shape.name)" @keydown.enter.prevent="lookup.has(shape.name) && choose(shape.name)" @keydown.space.prevent="lookup.has(shape.name) && choose(shape.name)"><title>{{ shape.name }}</title></path>
        <g v-if="mapLabel" pointer-events="none"><rect :x="mapLabel.x - 29" :y="mapLabel.y - 11" width="58" height="22" rx="4" /><text :x="mapLabel.x" :y="mapLabel.y + 4" text-anchor="middle">{{ mapLabel.name }}</text></g>
      </svg>
      <div class="district-map-legend"><span v-for="item in legend" :key="item.tone" :data-tone="item.tone"><i />{{ item.label }}</span></div>
      <a href="https://data.gov.tw/dataset/7441" target="_blank" rel="noopener noreferrer" class="district-map-source">區界：內政部國土測繪中心 · 開放資料授權 1.0</a>
    </aside>
  </section>
</template>

<style scoped>
.district-overview { --area-quiet: #a7cbbf; --area-low: #82b7aa; --area-medium: #e2b970; --area-high: #e58e89; --area-none: #414754; display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 20px; align-items: start; }
:global([data-theme="light"]) .district-overview { --area-none: #e2e4e8; }
[data-tone="quiet"] { --tone: var(--area-quiet); }[data-tone="low"] { --tone: var(--area-low); }[data-tone="medium"] { --tone: var(--area-medium); }[data-tone="high"] { --tone: var(--area-high); }[data-tone="none"] { --tone: var(--area-none); }
.district-overview-heading, .district-card-title, .district-card-count, .district-card-now, .district-map-focus, .district-map-panel header, .district-expand, .district-clear { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.district-eyebrow { display: flex; align-items: center; gap: 6px; color: var(--accent); font-size: var(--type-body2); margin-bottom: 5px; }.district-overview-heading h2 { font-size: var(--type-h6); font-weight: 650; }.district-overview-heading h2 > span { color: var(--muted); font-size: var(--type-body2); font-weight: 400; margin-left: 8px; white-space: nowrap; }.district-intro { font-size: var(--type-body2); color: var(--muted); margin: 7px 0 16px; }.district-clear { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); min-height: 40px; padding: 6px 10px; font-size: var(--type-body2); flex-shrink: 0; }
.district-featured { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }.district-card { min-width: 0; display: block; text-align: left; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-top: 3px solid var(--tone); border-radius: 9px; }.district-card:hover, .district-card.is-selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--panel)); }.district-card-title strong { font-size: var(--type-body1); font-weight: 650; }.district-card-title svg { color: var(--muted); }.district-card-count { justify-content: start; gap: 10px; margin: 14px 0; }.district-card-count > b { font-size: var(--type-h3); line-height: 1.2; font-variant-numeric: tabular-nums; font-weight: 600; }.district-card-count > span { font-size: var(--type-body2); }.district-card-count small { display: block; font-size: var(--type-body2); color: var(--muted); }
.district-card-metrics { display: flex; justify-content: space-between; gap: 10px; font-size: var(--type-body2); color: var(--muted); }.district-card-metrics strong { display: block; color: var(--ink); font-size: var(--type-body1); font-weight: 550; margin-top: 3px; font-variant-numeric: tabular-nums; }.district-card-metrics strong small { font-size: var(--type-body2); color: var(--muted); font-weight: 400; }.district-status-bar { display: flex; height: 5px; overflow: hidden; border-radius: 4px; margin: 16px 0 10px; }.district-status-bar i { height: 100%; }.district-card-now { flex-wrap: wrap; gap: 3px; font-size: var(--type-body2); color: var(--muted); }.district-card-now > span:last-child { color: var(--accent); }.district-card-now b { font-weight: 600; color: var(--ink); }
.district-legend, .district-map-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: var(--type-body2); color: var(--muted); }.district-legend { margin: 12px 0; }.district-legend > span, .district-map-legend > span { display: inline-flex; align-items: center; gap: 4px; }.district-legend i, .district-map-legend i, .district-all-list i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; background: var(--tone); flex-shrink: 0; }
.district-expand { width: 100%; min-height: 40px; padding: 8px 0; border-top: 1px solid var(--line); font-size: var(--type-body2); color: var(--accent); }.rotated { transform: rotate(180deg); }.district-all-list { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; padding-top: 8px; }.district-all-list button { min-height: 44px; min-width: 0; display: flex; justify-content: space-between; gap: 6px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); font-size: var(--type-body2); }.district-all-list button > span { display: flex; align-items: center; gap: 5px; }.district-all-list b { font-weight: 600; }.district-all-list small { font-size: var(--type-body2); font-weight: 400; color: var(--muted); }.district-all-list .is-selected { border-color: var(--accent); }
.district-map-panel { padding: 14px 16px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }.district-map-panel header h3 { display: flex; align-items: center; gap: 6px; font-size: var(--type-body2); font-weight: 600; }.district-map-panel header > span { font-size: var(--type-body2); color: var(--muted); }.district-map-focus { margin-top: 8px; font-size: var(--type-body2); min-height: 20px; }.district-map-focus strong { font-weight: 500; }.district-map-focus > span { color: var(--muted); }.district-map { display: block; width: 100%; height: 225px; margin: 3px auto 7px; overflow: visible; }.district-map path { fill: var(--tone); stroke: var(--panel); stroke-width: .7; cursor: pointer; vector-effect: non-scaling-stroke; }.district-map path[aria-disabled="true"] { cursor: default; }.district-map path:hover, .district-map path.hovered, .district-map path:focus-visible, .district-map path.selected { stroke: var(--ink); stroke-width: 2; outline: none; }.district-map rect { fill: var(--ink); }.district-map text { fill: var(--panel); font-size: var(--marker-label-lg); font-weight: 600; }.district-map-legend { gap: 8px; font-size: var(--type-body2); }.district-map-source { display: block; margin-top: 8px; color: var(--muted); font-size: var(--type-body2); text-decoration: underline; text-underline-offset: 2px; }
@media (max-width: 1400px) { .district-overview { grid-template-columns: minmax(0, 1fr) 275px; gap: 16px; }.district-card { padding: 12px; }.district-card-metrics { flex-direction: column; gap: 8px; }.district-card-metrics > span { display: flex; justify-content: space-between; align-items: baseline; }.district-card-metrics strong {  margin: 0; }.district-card-now > span:last-child { display: none; } }
@media (max-width: 1150px) { .district-overview { grid-template-columns: 1fr; }.district-map-panel { display: none; }.district-card-metrics { flex-direction: row; }.district-card-metrics > span { display: block; }.district-card-now > span:last-child { display: inline; } }
@media (max-width: 680px) { .district-overview-heading { align-items: start; }.district-overview-heading h2 > span { display: block; margin: 3px 0 0; }.district-featured { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 3px; }.district-card { flex: 0 0 82%; scroll-snap-align: start; padding: 15px; }.district-card-metrics { flex-direction: row; }.district-all-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }.district-map-panel { display: block; }.district-map { height: 240px; }.district-legend { gap: 10px; } }
</style>
