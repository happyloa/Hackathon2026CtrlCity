<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DispatchRecommendation, StationRisk } from '~/shared/ops'

const props = defineProps<{
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  compact?: boolean
}>()

const emit = defineEmits<{ accept: [dispatchId: string]; select: [stationId: string] }>()

const stationLookup = computed(() => new Map(props.stations.map(station => [station.id, station])))
const visibleDispatches = computed(() => props.compact ? props.dispatches.slice(0, 4) : props.dispatches)
const nameFor = (id: string) => stationLookup.value.get(id)?.name || '未命名站點'
</script>

<template>
  <section class="panel dispatch-panel">
    <div class="panel-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:routing-2-outline" /> 調度建議</p>
        <h2>先處理這些搬運任務</h2>
      </div>
      <NuxtLink v-if="compact" to="/dispatch" class="text-link">調度工作台 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </div>

    <div v-if="visibleDispatches.length" class="dispatch-list">
      <article v-for="dispatch in visibleDispatches" :key="dispatch.id" class="dispatch-row">
        <div class="dispatch-route">
          <button type="button" @click="emit('select', dispatch.fromStationId)">{{ nameFor(dispatch.fromStationId) }}</button>
          <span><Icon icon="solar:arrow-right-outline" /></span>
          <button type="button" @click="emit('select', dispatch.toStationId)">{{ nameFor(dispatch.toStationId) }}</button>
        </div>
        <div class="dispatch-meta">
          <span><b>{{ dispatch.bikeCount }}</b> 台</span>
          <small>{{ dispatch.distanceKm.toFixed(1) }} km · 優先 {{ Math.round(dispatch.priorityScore) }}</small>
        </div>
        <button
          type="button"
          class="assign-button"
          :class="{ assigned: dispatch.status !== 'proposed' }"
          :disabled="dispatch.status !== 'proposed'"
          @click="emit('accept', dispatch.id)"
        >
          {{ dispatch.status === 'proposed' ? '指派任務' : '已指派' }}
        </button>
      </article>
    </div>
    <div v-else class="empty-state"><Icon icon="solar:check-circle-outline" />目前沒有可行的搬運建議。</div>
  </section>
</template>
