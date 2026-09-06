<script setup lang="ts">
import { Icon } from "@iconify/vue";
import { overrideStationsWithXgboost } from "~/shared/xgboost-overrides";

const route = useRoute();

const predictionMode = useState<"baseline" | "xgboost">(
  "prediction-mode",
  () => "baseline",
);
const xgboost = useXgboostPredictions();
const live = useLiveDashboard();
useLivePolling(live.refresh, computed(() => true));

watch(
  predictionMode,
  (mode) => {
    if (mode === "xgboost") void xgboost.load();
  },
  { immediate: true },
);

/** Site-wide (not scoped to any one district), so the floating warning carts
 * stay accurate no matter which page is open. */
const warningStations = computed(() => {
  const stations = live.dashboard.value?.stations;
  const asOf = live.dashboard.value?.meta.asOf;
  if (!stations || !asOf) return [];
  if (predictionMode.value === "baseline" || !xgboost.payload.value) return stations;
  return overrideStationsWithXgboost(
    stations,
    xgboost.payload.value.stations,
    asOf,
    xgboost.payload.value.generatedAt,
  );
});

/**
 * The warning cart lists stations across every district (it reads the
 * unscoped `live.dashboard`), but the homepage's own `dashboard` is filtered
 * to whichever district is selected there -- and clears `selectedStationId`
 * the moment it points at a station outside that filter. So a station from
 * a different district than the one currently selected on `/` would silently
 * get deselected right after navigating. Dropping `district` here (instead
 * of preserving it via `navigationQuery`) resets the homepage to "all
 * districts" so the picked station is always present in its dashboard.
 */
function goToStation(stationId: string) {
  void navigateTo({ path: "/", query: { station: stationId } });
}

const navigation = [
  { to: "/", label: "營運總覽", icon: "solar:radar-2-outline" },
  { to: "/stations", label: "站點總覽", icon: "solar:map-point-wave-outline" },
  { to: "/dispatch", label: "調度規劃", icon: "solar:routing-2-outline" },
];

/** Admin pages (`/admin/*`) are reached by direct URL, not the sidebar, so
 * they need their header label listed separately from `navigation`. */
const adminLabels: Record<string, string> = {
  "/admin/roi": "營運ROI",
  "/admin/adjustments": "營運調整",
};

const activeLabel = computed(
  () =>
    navigation.find((item) => item.to === route.path)?.label ||
    adminLabels[route.path] ||
    "站點資訊",
);
const navigationQuery = computed(() =>
  Object.fromEntries(
    ["district"]
      .map((key) => [key, route.query[key]])
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && Boolean(entry[1]),
      ),
  ),
);
const navigationTarget = (path: string) => ({
  path,
  query: navigationQuery.value,
});
</script>

<template>
  <div class="min-h-svh bg-canvas text-ink">
    <aside
      class="border-b border-line bg-panel lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-b-0"
    >
      <div
        class="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:block lg:px-5 lg:py-6"
      >
        <NuxtLink
          :to="navigationTarget('/')"
          class="inline-flex min-w-0 items-center gap-3 no-underline"
          aria-label="前往營運總覽"
        >
          <span
            class="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface text-xl text-accent"
            ><Icon icon="solar:wheel-angle-outline"
          /></span>
          <span class="min-w-0">
            <strong class="block truncate text-lg leading-6"
              >新北市 YouBike</strong
            >
            <span class="block text-base leading-6 text-muted">營運工作台</span>
          </span>
        </NuxtLink>
      </div>

      <nav
        class="flex gap-2 overflow-x-auto px-4 pb-3 sm:px-6 lg:mt-2 lg:flex-col lg:px-4 lg:pb-0"
        aria-label="主要導覽"
      >
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="navigationTarget(item.to)"
          class="inline-flex min-h-11 shrink-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-base font-semibold no-underline transition-colors"
          :class="
            route.path === item.to
              ? 'border-accent bg-accent text-on-accent shadow-sm'
              : 'text-muted hover:border-line hover:bg-surface hover:text-ink'
          "
          :aria-label="item.label"
          :aria-current="route.path === item.to ? 'page' : undefined"
          :title="item.label"
        >
          <Icon class="shrink-0 text-xl" :icon="item.icon" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="hidden lg:block lg:flex-1" />
      <div class="hidden border-t border-line px-5 py-5 lg:block">
        <div class="flex items-start gap-3">
          <span
            class="mt-2 size-2 shrink-0 rounded-full bg-positive"
            aria-hidden="true"
          />
          <div>
            <span class="block text-base text-muted">資料狀態</span>
            <strong class="mt-1 block text-base leading-6">官方即時站況</strong>
          </div>
        </div>
        <p class="mt-4 text-base leading-6 text-muted">
          僅提供分析與路線建議。
        </p>
      </div>
    </aside>

    <main class="min-w-0 lg:ml-64">
      <header class="border-b border-line bg-canvas">
        <div
          class="mx-auto flex w-full max-w-screen-2xl flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:py-5"
        >
          <div class="min-w-0">
            <p
              class="inline-flex items-center gap-2 text-base font-semibold tracking-wide text-accent"
            >
              新北市公共自行車
            </p>
            <h1 class="mt-1 text-2xl font-bold tracking-tight">
              {{ activeLabel }}
            </h1>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <div
              class="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface p-1 text-base font-bold"
              role="group"
              aria-label="預測模型"
            >
              <button
                type="button"
                class="min-h-9 rounded-md px-3 transition-colors"
                :class="predictionMode === 'baseline' ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'"
                @click="predictionMode = 'baseline'"
              >Baseline</button>
              <button
                type="button"
                class="min-h-9 rounded-md px-3 transition-colors"
                :class="predictionMode === 'xgboost' ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'"
                @click="predictionMode = 'xgboost'"
              >XGBoost</button>
            </div>
            <span
              class="inline-flex min-h-11 items-center gap-2 rounded-lg bg-surface px-3 text-base font-semibold text-muted"
              ><Icon
                class="text-xl text-accent"
                icon="solar:map-point-outline"
              />
              新北市</span
            >
          </div>
        </div>
        <p
          v-if="predictionMode === 'xgboost'"
          class="mx-auto w-full max-w-screen-2xl px-4 pb-3 text-base text-muted sm:px-6 lg:px-8"
        >
          <template v-if="xgboost.error.value">{{ xgboost.error.value }}</template>
          <template v-else-if="xgboost.pending.value">正在載入 XGBoost 推論結果…</template>
          <template v-else-if="xgboost.payload.value">
            XGBoost 快照產出於 {{ new Date(xgboost.payload.value.generatedAt).toLocaleString('zh-TW', { hour12: false }) }}，
            只涵蓋規則基線 F1≤60% 的站（{{ xgboost.payload.value.method.routing }}），其餘站仍用規則基線。
          </template>
        </p>
      </header>
      <slot />
    </main>
    <WarningCarts :stations="warningStations" @select="goToStation" />
  </div>
</template>
