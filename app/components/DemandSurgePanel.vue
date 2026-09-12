<script setup lang="ts">
import { AlertTriangle, CalendarClock, ChevronDown, ShieldAlert } from '@lucide/vue'
import { displayStationName, type StationRisk } from '~/shared/ops'

const props = defineProps<{ stations: StationRisk[] }>()
const emit = defineEmits<{ select: [stationId: string] }>()

const { impacts, nextPhase } = useDemandSurgeImpacts(() => props.stations)

const expanded = ref(true)
const panelContentId = useId()
const hasShortfall = computed(() => impacts.value.some(item => !item.canAbsorb))

function formatClock(value: string): string {
  const [, time] = value.split('T')
  return time ?? value
}
</script>

<template>
  <section v-if="impacts.length" class="surge-panel" :class="{ 'has-shortfall': hasShortfall }" aria-label="即將到來的人潮高峰補位評估">
    <button class="surge-trigger" type="button" :aria-expanded="expanded" :aria-controls="panelContentId" @click="expanded = !expanded">
      <span class="surge-symbol">
        <component :is="hasShortfall ? ShieldAlert : CalendarClock" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
      </span>
      <span class="surge-heading">即將到來的人潮高峰<small>活動階段開始前 60 分鐘起持續評估鄰近站補位能力</small></span>
      <span class="surge-count">{{ impacts.length }} 筆</span>
      <span class="surge-action">{{ expanded ? '收合' : '查看' }}
        <ChevronDown style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" :class="{ 'is-expanded': expanded }" />
      </span>
    </button>
    <div v-if="expanded" :id="panelContentId" class="surge-content">
      <p class="surge-context">
        預估借／還車量以該站總車位數估算（系統無借還車次數歷史，僅此為透明的保守估計；活動實際人潮可能更高），
        鄰站可調度量為鄰近 500 公尺內營運中站點在保留自身安全庫存後，還能再支援的可借車輛（借車潮）或可還空位（還車潮）。
        調度規劃頁面已將缺口納入路線建議。
      </p>
      <div class="divide-y divide-line border-t border-line">
        <button v-for="item in impacts" :key="`${item.eventId}:${item.phaseIndex}:${item.stationId}`" type="button"
          class="flex w-full flex-wrap items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-panel-muted"
          @click="emit('select', item.stationId)">
          <span class="grid size-10 shrink-0 place-items-center rounded-full text-h6"
            :class="item.canAbsorb ? 'bg-positive-surface text-positive' : 'bg-warning-surface text-warning'">
            <component :is="item.canAbsorb ? CalendarClock : AlertTriangle" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1 text-body1 leading-6 text-ink">
            <strong class="block break-words font-bold">{{ displayStationName(item.stationName) }}</strong>
            <span class="mt-1 block text-muted">{{ item.district || '行政區未標示' }} · {{ item.eventName }} · {{ item.phaseLabel }} {{ formatClock(item.triggerAt) }}
              <span class="font-semibold" :class="item.tier === '30min' ? 'text-danger' : 'text-warning'">
                （{{ item.tier === '30min' ? '30' : '60' }} 分鐘內）
              </span>
            </span>
            <span class="mt-1 block text-muted">{{ item.reasons[0] }}</span>
          </span>
          <span class="ml-auto flex w-full items-center justify-between gap-2 text-body1 sm:w-auto sm:flex-col sm:items-end">
            <span class="text-muted">{{ item.effect === 'borrow_surge' ? '預估借車量' : '預估還車量' }} <strong class="font-mono text-ink">{{ item.estimatedDemand }}</strong> 台</span>
            <span class="text-muted">鄰站可調度 <strong class="font-mono text-ink">{{ item.neighbourSpareCapacity }}</strong> {{ item.effect === 'borrow_surge' ? '台車' : '個位' }}</span>
            <span v-if="!item.canAbsorb" class="font-semibold text-warning">缺口 {{ item.shortfall }}</span>
          </span>
        </button>
      </div>
    </div>
  </section>
  <p v-else-if="nextPhase" class="surge-quiet" role="status">
    <CalendarClock style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
    目前沒有進入評估視窗的活動；最近一場「{{ nextPhase.eventName }}」的{{ nextPhase.phaseLabel }}預計 {{ formatClock(nextPhase.triggerAt) }} 開始，
    還有 {{ nextPhase.leadMinutes }} 分鐘——開始前 60 分鐘內才會在此顯示評估結果。
  </p>
</template>

<style scoped>
.surge-panel {
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  background: var(--panel);
  overflow: hidden;
}

.surge-panel.has-shortfall {
  border-color: color-mix(in srgb, var(--warning) 28%, var(--line));
  border-left-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 5%, var(--panel));
}

.surge-trigger {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 16px;
  width: 100%;
  text-align: left;
}

.surge-symbol {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: var(--icon-md);
}

.has-shortfall .surge-symbol {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}

.surge-heading {
  font-size: var(--type-body1);
  font-weight: 650;
}

.surge-heading small {
  display: block;
  font-size: var(--type-body2);
  font-weight: 400;
  color: var(--muted);
  margin-top: 2px;
}

.surge-count {
  margin-left: 18px;
  font-size: var(--type-h6);
  font-weight: 650;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.surge-action {
  display: inline-flex;
  align-items: center;
  justify-content: end;
  gap: 9px;
  margin-left: auto;
  font-size: var(--type-body2);
  font-weight: 550;
  white-space: nowrap;
}

.surge-action svg {
  transition: transform .15s;
}

.is-expanded {
  transform: rotate(180deg);
}

.surge-content {
  background: var(--panel);
  border-top: 1px solid var(--line);
}

.surge-content > .divide-y {
  max-height: 380px;
  overflow-y: auto;
}

.surge-context {
  padding: 14px 16px 10px;
  font-size: var(--type-body2);
  color: var(--muted);
}

.surge-quiet {
  display: flex;
  align-items: start;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
  color: var(--muted);
  font-size: var(--type-body2);
}

.surge-quiet svg {
  flex-shrink: 0;
  margin-top: 2px;
}

@media (max-width: 640px) {
  .surge-trigger {
    padding: 14px;
    gap: 10px;
    flex-wrap: wrap;
  }

  .surge-heading small {
    display: none;
  }
}
</style>
