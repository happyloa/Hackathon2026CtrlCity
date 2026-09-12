<script setup lang="ts">
import { CheckCircle2, ChevronDown, TriangleAlert, Wrench } from '@lucide/vue'
import { FROZEN_STATION_POLICY } from '~/shared/parameters.mjs'
import { displayStationName, type StationRisk } from '~/shared/ops'
import type { FrozenMetric } from '~/composables/useFrozenStations'

const props = defineProps<{
  stations: StationRisk[]
  frozenStations?: { stationId: string; metric: FrozenMetric; stuckValue: number }[]
}>()

const emit = defineEmits<{ select: [stationId: string] }>()

const expanded = ref(false)
const panelContentId = useId()

/**
 * Client-side counterpart to `scripts/detect-frozen-stations.mjs`, loosened
 * for live monitoring: a station where one metric (bikes or docks) has sat
 * at one fixed reading from 0 through `FROZEN_STATION_POLICY.stuckValueCeiling`
 * for at least `minRunMinutes` while the other stayed positive -- more
 * likely a stuck sensor or an unreported closure than genuine chronic
 * demand. This is a candidate list to check, not a confirmed fault.
 */
const items = computed(() => {
  const stationLookup = new Map(props.stations.map(station => [station.id, station]))
  return (props.frozenStations ?? [])
    .map(entry => ({ station: stationLookup.get(entry.stationId), metric: entry.metric, stuckValue: entry.stuckValue }))
    .filter((item): item is { station: StationRisk; metric: FrozenMetric; stuckValue: number } => Boolean(item.station))
    .sort((left, right) => left.station.id.localeCompare(right.station.id))
})

const hasItems = computed(() => items.value.length > 0)
const hours = FROZEN_STATION_POLICY.minRunMinutes / 60
const ceiling = FROZEN_STATION_POLICY.stuckValueCeiling
</script>

<template>
  <section class="frozen-panel" :class="{ 'has-items': hasItems }" aria-label="疑似故障站點">
    <button class="frozen-trigger" type="button" :aria-expanded="expanded" :aria-controls="panelContentId" @click="expanded = !expanded">
      <span class="frozen-symbol"><component :is="hasItems ? Wrench : CheckCircle2" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /></span>
      <span class="frozen-heading">{{ hasItems ? '疑似故障站點' : '未偵測到疑似故障站點' }}<small>可借車或可還位持續卡在 0～{{ ceiling }} 台達 {{ hours }} 小時以上</small></span>
      <span class="frozen-figures"><span><strong>{{ items.length }}</strong> 站</span></span>
      <span class="frozen-action">{{ expanded ? '收合清單' : '查看清單' }}<ChevronDown style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" :class="{ 'is-expanded': expanded }" /></span>
    </button>
    <div v-if="expanded" :id="panelContentId" class="frozen-content">
      <p class="frozen-context">此清單找出可借車或可還位「連續 {{ hours }} 小時都卡在同一個 0～{{ ceiling }} 之間的讀數」的站點——比一般缺車／缺位更像是感測器卡住或站點未通報停用，僅供派人現場確認，不是確定故障。由每 5 分鐘的排程快照累積判定。</p>
      <div v-if="hasItems" class="divide-y divide-line border-t border-line">
        <button v-for="item in items" :key="item.station.id" type="button"
          class="flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-panel-muted"
          @click="emit('select', item.station.id)">
          <span class="grid size-10 shrink-0 place-items-center rounded-full bg-warning-surface text-h6 text-warning">
            <TriangleAlert style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1 text-body1 leading-6 text-ink">
            <strong class="block break-words font-bold">{{ displayStationName(item.station.name) }}</strong>
            <span class="mt-1 block text-muted">{{ item.station.district || '行政區未標示' }}</span>
          </span>
          <span class="ml-auto flex w-full items-center justify-between gap-2 text-body1 sm:w-auto sm:flex-col sm:items-end">
            <span class="text-muted">{{ item.metric === 'bikes' ? '可借車' : '可還位' }}持續為 <strong class="font-mono text-ink">{{ item.stuckValue }}</strong></span>
            <span class="text-muted">已持續 ≥{{ hours }} 小時</span>
          </span>
        </button>
      </div>
      <div v-else class="flex min-h-24 items-center justify-center gap-2 border-t border-line p-4 text-center text-body1 font-semibold text-positive">
        <CheckCircle2 class="icon-md" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />目前沒有符合的站點；需連續 {{ hours }} 小時卡在同一讀數才會列入。
      </div>
    </div>
  </section>
</template>

<style scoped>
.frozen-panel { border: 1px solid var(--line); border-left: 3px solid var(--positive); border-radius: 9px; background: var(--panel); overflow: hidden; }
.frozen-panel.has-items { border-color: color-mix(in srgb, var(--warning) 28%, var(--line)); border-left-color: var(--warning); background: color-mix(in srgb, var(--warning) 5%, var(--panel)); }
.frozen-trigger { display: flex; align-items: center; gap: 14px; padding: 11px 16px; width: 100%; text-align: left; }
.frozen-trigger:hover { background: color-mix(in srgb, var(--warning) 4%, transparent); }
.frozen-symbol { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 8px; color: var(--positive); background: var(--positive-surface); font-size: var(--icon-md); }
.has-items .frozen-symbol { color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
.frozen-heading { font-size: var(--type-body1); font-weight: 650; }
.frozen-heading small { display: block; font-size: var(--type-body2); font-weight: 400; color: var(--muted); margin-top: 2px; }
.frozen-figures { display: flex; flex-wrap: wrap; gap: 10px 24px; margin-left: 18px; color: var(--muted); font-size: var(--type-body2); }
.frozen-figures strong { margin-left: 9px; font-size: var(--type-h6); color: var(--ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.has-items .frozen-figures strong { color: var(--warning); }
.frozen-action { display: inline-flex; align-items: center; justify-content: end; gap: 9px; margin-left: auto; font-size: var(--type-body2); font-weight: 550; white-space: nowrap; }
.frozen-action svg { transition: transform .15s; }
.is-expanded { transform: rotate(180deg); }
.frozen-content { background: var(--panel); border-top: 1px solid var(--line); }
.frozen-content > .divide-y { max-height: 380px; overflow-y: auto; }
.frozen-context { padding: 14px 16px 10px; font-size: var(--type-body2); color: var(--muted); }
@media (max-width: 640px) { .frozen-trigger { padding: 14px; gap: 10px; flex-wrap: wrap; } .frozen-symbol { width: 32px; height: 32px; } .frozen-heading small { display: none; } .frozen-heading { font-size: var(--type-body2); } .frozen-figures { order: 4; width: 100%; margin-left: 42px; } }
</style>
