<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { HorizonKey, StationRisk } from '~/shared/ops'

const props = defineProps<{ stations: StationRisk[] }>()
const emit = defineEmits<{ select: [stationId: string] }>()

const HORIZONS: { key: HorizonKey; label: string }[] = [
  { key: '30', label: 'Warning-30' },
  { key: '60', label: 'Warning-60' },
]

const openHorizon = ref<HorizonKey | null>(null)

function itemsFor(horizon: HorizonKey) {
  return props.stations
    .filter((station) => {
      const level = station.forecast.horizons[horizon]?.level
      return level === 'high' || level === 'critical'
    })
    .map((station) => {
      const forecast = station.forecast.horizons[horizon]!
      const isEmpty = forecast.emptyRisk >= forecast.fullRisk
      const safetyStock = Math.max(2, Math.ceil(station.totalDocks * .1))
      const predicted = isEmpty ? forecast.predictedBikes : forecast.predictedDocks
      const gap = Math.max(0, Math.ceil(safetyStock - predicted))
      return { station, level: forecast.level, isEmpty, gap, predicted }
    })
    .sort((left, right) => right.gap - left.gap)
}

const counts = computed(() => Object.fromEntries(HORIZONS.map(({ key }) => [key, itemsFor(key).length])) as Record<HorizonKey, number>)
const openItems = computed(() => openHorizon.value ? itemsFor(openHorizon.value) : [])

function toggle(horizon: HorizonKey) {
  openHorizon.value = openHorizon.value === horizon ? null : horizon
}

function pick(stationId: string) {
  emit('select', stationId)
  openHorizon.value = null
}
</script>

<template>
  <div class="warning-carts fixed top-20 right-3 z-40 flex flex-col items-end gap-2 sm:top-24 sm:right-6">
    <button v-for="horizon in HORIZONS" :key="horizon.key" type="button"
      class="nerv-badge relative w-44 overflow-hidden rounded-sm shadow-lg transition-transform hover:scale-105 sm:w-52"
      :class="counts[horizon.key] > 0 ? 'is-active' : 'is-idle'" role="alert"
      :aria-live="counts[horizon.key] > 0 ? 'assertive' : 'off'" @click="toggle(horizon.key)">
      <span class="absolute inset-0 pointer-events-none">
        <span class="absolute inset-0 bg-nerv-orange opacity-95" />
        <span class="absolute inset-0 nerv-scanlines opacity-20" />
      </span>
      <span class="relative block">
        <span class="nerv-stripe-row relative block h-2">
          <span class="nerv-stripe absolute inset-y-0 left-0 w-1/2 nerv-stripe-forward" />
          <span class="nerv-stripe absolute inset-y-0 right-0 w-1/2 nerv-stripe-reverse" />
        </span>
        <span class="relative flex items-center justify-center gap-1.5 border-y-2 border-black px-2 py-1.5">
          <!-- <Icon icon="solar:cart-large-2-bold" class="shrink-0 text-base text-black" /> -->
          <span class="truncate text-xs font-black uppercase tracking-[0.12em] text-black">{{ horizon.label }}</span>
          <span
            class="count-pill inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-black px-1 text-[11px] font-black text-white">{{
              counts[horizon.key] }}</span>
        </span>
        <span class="nerv-stripe-row relative block h-2">
          <span class="nerv-stripe absolute inset-y-0 left-0 w-1/2 nerv-stripe-forward" />
          <span class="nerv-stripe absolute inset-y-0 right-0 w-1/2 nerv-stripe-reverse" />
        </span>
      </span>
    </button>

    <Teleport to="body">
      <div v-if="openHorizon" class="fixed inset-0 z-50 flex justify-end bg-black/50" @click.self="openHorizon = null">
        <div class="hazard-panel flex h-full w-full max-w-sm flex-col bg-panel shadow-2xl">
          <div class="hazard-header flex items-center justify-between px-4 py-3">
            <span class="text-lg font-black uppercase tracking-widest text-black">
              {{HORIZONS.find(h => h.key === openHorizon)?.label}} 警報
            </span>
            <button type="button" class="rounded-full bg-black/10 p-1 text-black" @click="openHorizon = null">
              <Icon icon="solar:close-circle-bold" class="text-2xl" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-3">
            <p v-if="!openItems.length" class="p-4 text-center text-base text-muted">目前沒有站點觸發這個視野的警報。</p>
            <button v-for="item in openItems" :key="item.station.id" type="button"
              class="mb-2 flex w-full flex-col gap-1 rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-accent-strong"
              @click="pick(item.station.id)">
              <div class="flex items-center justify-between gap-2">
                <span class="font-bold">{{ item.station.district }} {{ item.station.name }}</span>
                <span class="rounded px-2 py-0.5 text-xs font-black uppercase"
                  :class="item.level === 'critical' ? 'bg-critical text-on-critical' : 'bg-warning text-on-warning'">{{
                  item.level }}</span>
              </div>
              <span class="text-base text-muted">
                {{ item.isEmpty ? '可借車' : '可還位' }}預估剩 {{ item.predicted }} 台
                <template v-if="item.gap > 0"> · 建議{{ item.isEmpty ? '補' : '拉' }} <strong class="text-ink">{{ item.gap
                    }}</strong> 台</template>
              </span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.bg-nerv-orange {
  background-color: #ff9900;
}

.nerv-scanlines {
  background: repeating-linear-gradient(0deg,
      transparent 0 3px,
      rgba(0, 0, 0, .42) 3px 6px);
}

.nerv-stripe-row {
  background: #000;
}

.nerv-stripe {
  background-image: repeating-linear-gradient(45deg, #000 0 7px, #ff9900 7px 12px);
  background-size: 200% 100%;
}

.nerv-stripe-forward {
  animation: nerv-stripe-scroll-forward 1.2s linear infinite;
}

.nerv-stripe-reverse {
  background-image: repeating-linear-gradient(135deg, #000 0 7px, #ff9900 7px 12px);
  animation: nerv-stripe-scroll-reverse 1.2s linear infinite;
}

.nerv-badge {
  border: 2px solid #000;
}

.nerv-badge.is-idle {
  opacity: .5;
  filter: grayscale(.6);
}

.nerv-badge.is-idle .nerv-stripe-forward,
.nerv-badge.is-idle .nerv-stripe-reverse {
  animation-play-state: paused;
}

.nerv-badge.is-active {
  animation: nerv-badge-pulse 1.6s ease-in-out infinite;
}

.nerv-badge .count-pill {
  border: 1.5px solid #ff9900;
}

.hazard-header {
  background: repeating-linear-gradient(135deg,
      #ff9900 0px,
      #ff9900 10px,
      #1a1a1a 10px,
      #1a1a1a 20px);
  border-top: 2px solid #000;
  border-bottom: 2px solid #000;
}

@keyframes nerv-stripe-scroll-forward {
  from {
    background-position: 0 0;
  }

  to {
    background-position: -24px 0;
  }
}

@keyframes nerv-stripe-scroll-reverse {
  from {
    background-position: 0 0;
  }

  to {
    background-position: 24px 0;
  }
}

@keyframes nerv-badge-pulse {

  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 153, 0, .55);
  }

  50% {
    box-shadow: 0 0 0 6px rgba(255, 153, 0, 0);
  }
}
</style>
