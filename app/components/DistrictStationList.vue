<script setup lang="ts">
import { ArrowUpRight, Check, ChevronDown, CircleHelp, ListFilter, Search, Settings, TriangleAlert, Wrench } from '@lucide/vue'
import { displayStationName, type Alert, type StationRisk } from '~/shared/ops'
import { stationOverviewStatus } from '~/shared/station-overview'

const props = withDefaults(defineProps<{
  stations: StationRisk[]
  alerts: Alert[]
  frozenStations?: { stationId: string; metric: 'bikes' | 'docks'; stuckValue: number }[]
  pageSize?: number
  resetKey?: string
}>(), { pageSize: 12 })
const emit = defineEmits<{ select: [stationId: string] }>()
const alertLookup = computed(() => new Map(props.alerts.map(alert => [alert.stationId, alert])))
const frozenLookup = computed(() => new Map((props.frozenStations ?? []).map(entry => [entry.stationId, entry])))
function frozenInfo(station: StationRisk) { return frozenLookup.value.get(station.id) ?? null }
const groups = computed(() => {
  const result = new Map<string, StationRisk[]>()
  // Keep the incoming priority order within each district.
  for (const station of props.stations) {
    if (!result.has(station.district)) result.set(station.district, [])
    result.get(station.district)!.push(station)
  }
  return [...result].map(([district, stations]) => ({ district, stations,
    empty: stations.filter(station => statusFor(station) === 'empty').length,
    full: stations.filter(station => statusFor(station) === 'full').length,
  })).sort((a, b) => b.empty + b.full - a.empty - a.full || a.district.localeCompare(b.district, 'zh-Hant'))
})
const expanded = ref<Record<string, boolean>>({})
const visibleCounts = ref<Record<string, number>>({})
watch(() => props.resetKey, () => { expanded.value = {}; visibleCounts.value = {} })
function isOpen(district: string, index: number) { return expanded.value[district] ?? index < 2 }
function toggle(district: string, index: number) { expanded.value[district] = !isOpen(district, index) }
function visible(district: string) { return visibleCounts.value[district] ?? props.pageSize }
function showMore(district: string) { visibleCounts.value[district] = visible(district) + props.pageSize }
function statusFor(station: StationRisk) { return stationOverviewStatus(station, alertLookup.value.get(station.id)) }
function statusLabel(station: StationRisk) {
  const status = statusFor(station)
  if (status === 'service') return station.serviceStatus === 'official_inactive' ? '官方停用' : '服務異常'
  if (status === 'unknown') return '資料不足'
  if (status === 'stable') return '穩定'
  const condition = alertLookup.value.get(station.id)?.condition
  if (status === 'empty') return station.currentState === 'empty_now' || condition === 'empty_now' ? '目前無車' : '可能缺車'
  return station.currentState === 'full_now' || condition === 'full_now' ? '目前無位' : '可能缺位'
}
function statusIcon(station: StationRisk) {
  return { empty: TriangleAlert, full: TriangleAlert, stable: Check, unknown: CircleHelp, service: Settings }[statusFor(station)]
}
function priority(station: StationRisk) {
  const status = statusFor(station)
  if (status !== 'empty' && status !== 'full') return null
  const score = alertLookup.value.get(station.id)?.priorityScore
  return score == null ? null : Math.round(score)
}
function rowStyle(station: StationRisk) {
  const score = priority(station)
  return score == null ? {} : { '--priority-width': `${Math.min(100, Math.max(0, score))}%` }
}
</script>

<template>
  <section class="station-groups" aria-labelledby="station-list-title">
    <header class="station-list-heading"><div><h2 id="station-list-title"><ListFilter :size="18" aria-hidden="true" />分區站點明細</h2><p aria-live="polite">{{ stations.length }} 個符合條件的站點 · {{ groups.length }} 個行政區</p></div><span>缺車／缺位較多的區域優先</span></header>
    <div v-if="!groups.length" class="station-list-empty" role="status"><Search :size="24" aria-hidden="true" /><strong>找不到符合條件的站點</strong><span>請調整搜尋文字、行政區或站點狀態。</span></div>
    <section v-for="(group, index) in groups" :key="group.district" class="station-district-group">
      <header class="station-district-header">
        <button type="button" class="station-district-toggle" :aria-expanded="isOpen(group.district, index)" :aria-controls="`station-district-${group.district}`" @click="toggle(group.district, index)"><ChevronDown :size="19" :class="{ collapsed: !isOpen(group.district, index) }" aria-hidden="true" /><strong>{{ group.district }}</strong><span>{{ group.stations.length }} 站</span><span class="station-group-counts"><b data-status="empty">缺車 {{ group.empty }}</b><b data-status="full">缺位 {{ group.full }}</b></span><small>{{ isOpen(group.district, index) ? '收合' : '展開站點' }}</small></button>
        <NuxtLink :to="{ path: '/dispatch', query: { district: group.district } }" class="station-district-dispatch" :aria-label="`前往${group.district}調度規劃`">此區調度<ArrowUpRight :size="15" aria-hidden="true" /></NuxtLink>
      </header>
      <div v-if="isOpen(group.district, index)" :id="`station-district-${group.district}`">
        <div class="station-table-heading" aria-hidden="true"><span>站點名稱</span><span>站點狀態</span><span>可借車 / 可還位</span><span>優先分</span><span>站點資料</span></div>
        <article v-for="station in group.stations.slice(0, visible(group.district))" :key="station.id" class="station-row" :data-status="statusFor(station)" :style="rowStyle(station)">
          <button class="station-row-name" type="button" @click="emit('select', station.id)"><component :is="statusIcon(station)" :size="17" aria-hidden="true" /><strong>{{ displayStationName(station.name) }}</strong><span v-if="frozenInfo(station)" class="station-row-frozen-badge" title="疑似連續停滯"><Wrench :size="13" aria-hidden="true" /><span class="sr-only">疑似連續停滯</span></span></button>
          <span class="station-row-status">{{ statusLabel(station) }}</span>
          <div class="station-row-inventory"><span><b>{{ station.availableBikes }}</b><small> 車</small></span><i>/</i><span><b>{{ station.availableDocks }}</b><small> 位</small></span></div>
          <span class="station-row-score"><b v-if="priority(station) !== null">{{ priority(station) }}<small> 分</small></b><span v-else aria-label="無適用優先分">—</span></span>
          <button type="button" class="station-row-detail" :aria-label="`查看${displayStationName(station.name)}詳細資料`" @click="emit('select', station.id)">詳細<ArrowUpRight :size="14" aria-hidden="true" /></button>
        </article>
        <footer v-if="group.stations.length > visible(group.district)" class="station-group-more"><span>已顯示 {{ Math.min(group.stations.length, visible(group.district)) }} / {{ group.stations.length }} 站</span><button type="button" @click="showMore(group.district)">再顯示 {{ Math.min(pageSize, group.stations.length - visible(group.district)) }} 站<ChevronDown :size="15" aria-hidden="true" /></button></footer>
      </div>
    </section>
  </section>
</template>

<style scoped>
.station-groups { display: grid; gap: 14px; }.station-list-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }.station-list-heading h2 { display: flex; align-items: center; gap: 7px; font-size: var(--type-body1); font-weight: 650; }.station-list-heading h2 svg { color: var(--accent); }.station-list-heading p, .station-list-heading > span { color: var(--muted); font-size: var(--type-body2); }.station-list-heading p { margin-top: 3px; }
.station-district-group { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }.station-district-header { display: flex; align-items: center; gap: 16px; padding-right: 16px; }.station-district-toggle { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; padding: 15px 16px; min-height: 62px; text-align: left; }.station-district-toggle > svg { flex-shrink: 0; color: var(--muted); }.station-district-toggle > svg.collapsed { transform: rotate(-90deg); }.station-district-toggle > strong { font-size: var(--type-body1); font-weight: 650; white-space: nowrap; }.station-district-toggle > span { font-size: var(--type-body2); color: var(--muted); }.station-district-toggle > small { margin-left: auto; color: var(--muted); font-size: var(--type-body2); }.station-group-counts { display: flex; gap: 12px; margin-left: 10px; }.station-group-counts b { font-weight: 500; }.station-group-counts [data-status="empty"] { color: var(--danger); }.station-group-counts [data-status="full"] { color: var(--info); }.station-district-dispatch { display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 38px; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 6px; font-size: var(--type-body2); color: var(--ink); text-decoration: none; white-space: nowrap; }.station-district-dispatch:hover { border-color: var(--accent); color: var(--accent); }
.station-table-heading, .station-row { display: grid; grid-template-columns: minmax(200px, 1fr) 110px 160px 85px 80px; align-items: center; gap: 12px; padding: 10px 20px; }.station-table-heading { font-size: var(--type-body2); color: var(--muted); background: color-mix(in srgb, var(--panel-muted) 40%, var(--panel)); border-top: 1px solid var(--line); }.station-table-heading > span:nth-child(n+3) { text-align: right; }.station-table-heading > span:last-child { text-align: center; }
.station-row { --status-color: var(--muted); --priority-width: 0%; min-height: 66px; border-top: 1px solid var(--line); border-left: 3px solid transparent; background: linear-gradient(to right, color-mix(in srgb, var(--status-color) 8%, transparent) 0%, color-mix(in srgb, var(--status-color) 8%, transparent) var(--priority-width), transparent var(--priority-width)); }.station-row[data-status="empty"] { --status-color: var(--danger); border-left-color: var(--danger); }.station-row[data-status="full"] { --status-color: var(--info); border-left-color: var(--info); }.station-row[data-status="unknown"] { --status-color: var(--warning); }.station-row[data-status="stable"] { --status-color: var(--positive); }.station-row-name { display: flex; align-items: center; gap: 10px; min-height: 44px; text-align: left; min-width: 0; }.station-row-name > svg { flex-shrink: 0; color: var(--status-color); }.station-row-name strong { font-size: var(--type-body2); font-weight: 550; overflow-wrap: anywhere; }.station-row-name:hover strong { text-decoration: underline; text-underline-offset: 3px; }.station-row-frozen-badge { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--warning); }.station-row-status { color: var(--status-color); font-size: var(--type-body2); }.station-row-inventory { display: flex; justify-content: end; align-items: baseline; gap: 10px; font-size: var(--type-body2); font-variant-numeric: tabular-nums; }.station-row-inventory b { font-weight: 550; }.station-row-inventory small { font-size: var(--type-body2); color: var(--muted); }.station-row-inventory i { font-style: normal; color: var(--muted); }.station-row-score { text-align: right; font-variant-numeric: tabular-nums; }.station-row-score b { display: inline-block; min-width: 55px; text-align: center; padding: 3px 6px; border: 1px solid color-mix(in srgb, var(--status-color) 40%, var(--line)); border-radius: 5px; color: var(--status-color); font-size: var(--type-body1); font-weight: 600; }.station-row-score small { font-size: var(--type-body2); font-weight: 400; }.station-row-score > span { color: var(--muted); }.station-row-detail { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 40px; border: 1px solid var(--line-strong); border-radius: 6px; font-size: var(--type-body2); }.station-row-detail:hover { border-color: var(--accent); color: var(--accent); }.station-group-more { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: var(--type-body2); }.station-group-more button { min-height: 40px; display: flex; align-items: center; gap: 6px; color: var(--accent); font-size: var(--type-body2); }
.station-list-empty { display: grid; place-items: center; gap: 10px; padding: 44px 20px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); color: var(--muted); text-align: center; }.station-list-empty strong { color: var(--ink); font-size: var(--type-body1); }.station-list-empty > span { font-size: var(--type-body2); }
@media (max-width: 1000px) { .station-table-heading, .station-row { grid-template-columns: minmax(160px, 1fr) 80px 120px 64px 65px; gap: 8px; padding-right: 12px; padding-left: 12px; }.station-row-inventory { gap: 6px; } }
@media (max-width: 740px) { .station-list-heading > span { display: none; }.station-district-header { padding-right: 10px; gap: 4px; }.station-district-toggle { flex-wrap: wrap; column-gap: 7px; row-gap: 2px; padding: 12px; }.station-district-toggle strong { font-size: var(--type-body1); }.station-district-toggle > small { display: none; }.station-group-counts { flex-basis: 100%; padding-left: 26px; margin-left: 0; }.station-table-heading { display: none; }.station-row { grid-template-columns: minmax(0,1fr) auto auto; gap: 7px 10px; padding: 12px; }.station-row-name { grid-column: 1 / 4; min-height: 32px; }.station-row-status { grid-column: 1; grid-row: 2; }.station-row-inventory { grid-column: 1; grid-row: 3; justify-content: start; }.station-row-score { grid-column: 2; grid-row: 2 / 4; }.station-row-detail { grid-column: 3; grid-row: 2 / 4; padding: 4px 9px; }.station-row-name strong { font-size: var(--type-body1); }.station-group-more { padding: 8px 12px; } }
</style>
