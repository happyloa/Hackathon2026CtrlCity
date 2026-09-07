<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans } from '~/shared/dispatch-route-planner'
import type { DispatchRecommendation, StationRisk } from '~/shared/ops'

const props = defineProps<{
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  compact?: boolean
  maxItems?: number
  embedded?: boolean
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ select: [stationId: string] }>()
const planning = computed(() => buildDispatchRoutePlans(props.dispatches, props.stations))
const visibleRoutes = computed(() => props.compact
  ? planning.value.routes.slice(0, props.maxItems || 1)
  : planning.value.routes)
const allRoutesTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))
</script>

<template>
  <section :class="embedded ? 'overflow-hidden border-0 bg-transparent shadow-none' : 'panel overflow-hidden'">
    <header v-if="!embedded" class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 多站路線</p>
        <h2 class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ planning.routes.length }} 條建議路線</h2>
      </div>
      <NuxtLink v-if="compact" :to="allRoutesTarget" class="text-link min-h-11 text-base">查看規劃 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </header>

    <div v-if="visibleRoutes.length" class="divide-y divide-line">
      <RouteCard v-for="(route, routeIndex) in visibleRoutes" :key="route.id" :route="route" :index="routeIndex" @select="emit('select', $event)" />
    </div>
    <div v-else class="flex min-h-24 items-center justify-center gap-2 p-4 text-center text-base font-semibold text-positive"><Icon class="text-lg" icon="solar:check-circle-outline" />目前沒有可行的搬運路線。</div>

    <p v-if="planning.unplannedDispatches.length" class="m-0 border-t border-line bg-panel-muted p-4 text-base leading-6 text-muted"><Icon class="mr-1 inline text-warning" icon="solar:shield-warning-outline" />另有 {{ planning.unplannedDispatches.length }} 筆受距離、容量或安全量限制，未排入路線。</p>
  </section>
</template>
