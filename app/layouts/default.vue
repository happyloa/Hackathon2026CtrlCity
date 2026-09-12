<script setup lang="ts">
import { ChevronRight, CircleChevronLeft, CircleChevronRight, LayoutDashboard, MapPin, Moon, Route, Sun } from "@lucide/vue";

const browserStorage = useBrowserStorage();
const route = useRoute();
const sidebarCollapsed = ref(false);

onMounted(() => {
  sidebarCollapsed.value = browserStorage.getItem("ctrlcity-sidebar-collapsed") === "true";
});

watch(sidebarCollapsed, (collapsed) => {
  if (import.meta.client) browserStorage.setItem("ctrlcity-sidebar-collapsed", String(collapsed));
});

const { theme, toggle: toggleTheme } = useTheme();
const themeToggle = computed(() =>
  theme.value === "dark"
    ? { label: "淺色模式", ariaLabel: "切換為淺色主題", icon: Sun }
    : { label: "深色模式", ariaLabel: "切換為深色主題", icon: Moon },
);

const live = useLiveDashboard();
useLivePolling(live.refresh, computed(() => true));

const navigation = [
  { to: "/", label: "營運總覽", icon: LayoutDashboard },
  { to: "/stations", label: "站點總覽", icon: MapPin },
  { to: "/dispatch", label: "調度規劃", icon: Route },
];

/** Admin pages (`/admin/*`) are reached by direct URL, not the sidebar, so
 * they need their header label listed separately from `navigation`. */
const adminLabels: Record<string, string> = {
  "/admin/events": "活動管理",
  "/admin/callback": "登入",
  "/admin/roi": "營運ROI",
  "/admin/adjustments": "營運調整",
  "/design-system": "字級設計系統",
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
  <div class="ctrlcity-shell" :class="{ 'sidebar-is-collapsed': sidebarCollapsed }">
    <aside class="ctrlcity-sidebar">
      <NuxtLink :to="navigationTarget('/')" class="ctrlcity-brand" aria-label="前往營運總覽">
        <img class="ctrlcity-logo" src="/Logo-t.png" alt="CtrlCity" />
      </NuxtLink>
      <span class="nav-caption">營運工作台</span>
      <nav aria-label="主要導覽" class="ctrlcity-navigation">
        <NuxtLink v-for="item in navigation" :key="item.to" :to="navigationTarget(item.to)"
          :class="{ 'is-active': route.path === item.to }" :aria-current="route.path === item.to ? 'page' : undefined">
          <component :is="item.icon" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /><span>{{
            item.label }}</span>
          <ChevronRight class="nav-arrow" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
        </NuxtLink>
      </nav>
      <div class="sidebar-footer">
        <MapPin style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
        <div><strong>新北市服務範圍</strong><small>公共自行車營運支援</small></div>
      </div>
      <button type="button" class="sidebar-toggle" :aria-label="sidebarCollapsed ? '展開側欄' : '收合側欄'"
        :title="sidebarCollapsed ? '展開側欄' : '收合側欄'" :aria-expanded="!sidebarCollapsed"
        @click="sidebarCollapsed = !sidebarCollapsed">
        <component :is="sidebarCollapsed ? CircleChevronRight : CircleChevronLeft" :size="14" :stroke-width="1.6"
          aria-hidden="true" />
      </button>
    </aside>
    <main class="ctrlcity-main">
      <header class="ctrlcity-header">
        <div class="header-heading">
          <p>新北市公共自行車</p>
          <h1>{{ activeLabel }}<span v-if="route.path === '/'" class="header-badge">即時監控</span></h1>
        </div>
        <button type="button" class="header-theme" :aria-label="themeToggle.ariaLabel" :title="themeToggle.ariaLabel"
          @click="toggleTheme">
          <component :is="themeToggle.icon" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
          <span>{{ themeToggle.label }}</span>
        </button>
      </header>
      <slot />
    </main>
  </div>
</template>

<style scoped>
.ctrlcity-shell {
  min-height: 100svh;
  background: var(--canvas);
  color: var(--ink);
}

.ctrlcity-sidebar {
  width: 208px;
  position: fixed;
  inset: 0 auto 0 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--panel);
  z-index: 10;
  transition: width 240ms ease;
}

.ctrlcity-brand {
  display: flex;
  justify-content: center;
  margin: 24px 22px 36px;
  text-decoration: none;
}

.ctrlcity-logo {
  display: block;
  width: 118px;
  height: auto;
}

.nav-caption {
  margin: 0 24px 12px;
  font-size: var(--type-body2);
  color: var(--muted);
  letter-spacing: .12em;
}

.ctrlcity-navigation {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 12px;
}

.ctrlcity-navigation a {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 13px 12px;
  color: var(--muted);
  border-radius: 7px;
  text-decoration: none;
  font-size: var(--type-body2);
  font-weight: 550;
  border: 1px solid transparent;
  transition: background .15s;
}

.ctrlcity-navigation a>svg {
  font-size: var(--icon-md);
}

.ctrlcity-navigation a.is-active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 20%, var(--panel));
}

.ctrlcity-navigation a:hover {
  background: var(--panel-muted);
  color: var(--ink);
}

.ctrlcity-navigation .nav-arrow {
  margin-left: auto;
  font-size: var(--icon-sm);
  opacity: 0;
}

.ctrlcity-navigation a.is-active .nav-arrow {
  opacity: 1;
}

.sidebar-footer {
  display: flex;
  gap: 9px;
  align-items: center;
  margin: auto 20px 24px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}

.sidebar-footer>svg {
  font-size: var(--icon-md);
  color: var(--accent);
}

.sidebar-footer strong {
  font-size: var(--type-body2);
  font-weight: 550;
}

.sidebar-footer small {
  display: block;
  color: var(--muted);
  font-size: var(--type-body2);
  margin-top: 3px;
}

.sidebar-toggle {
  position: absolute;
  z-index: 2;
  top: 50%;
  right: -9px;
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  overflow: hidden;
  transform: translateY(-50%);
  border: 1px solid color-mix(in srgb, var(--accent) 65%, #dbeafe);
  border-radius: 50%;
  color: #eafffb;
  background: linear-gradient(135deg, #183a3a 0%, #8fffea 36%, #315d62 52%, #d8fff8 68%, #102929 100%);
  background-size: 260% 260%;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--panel) 88%, transparent), 0 3px 14px rgb(0 0 0 / 45%);
  animation: sidebar-liquid-metal 2s ease-in-out infinite;
  cursor: pointer;
}

.sidebar-toggle::before {
  position: absolute;
  content: '';
  inset: -45%;
  background: linear-gradient(110deg, transparent 35%, rgb(255 255 255 / 70%) 48%, transparent 61%);
  transform: translateX(-60%) rotate(12deg);
  animation: sidebar-metal-glint 2s ease-in-out infinite;
}

.sidebar-toggle svg {
  position: relative;
  z-index: 1;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 45%));
}

.sidebar-toggle:hover {
  color: #fff;
  border-color: #fff;
}

.sidebar-is-collapsed .ctrlcity-sidebar {
  width: 76px;
}

.sidebar-is-collapsed .ctrlcity-brand {
  margin-inline: 10px;
}

.sidebar-is-collapsed .ctrlcity-logo {
  width: 52px;
}

.sidebar-is-collapsed .nav-caption,
.sidebar-is-collapsed .ctrlcity-navigation a>span,
.sidebar-is-collapsed .nav-arrow,
.sidebar-is-collapsed .sidebar-footer>div {
  display: none;
}

.sidebar-is-collapsed .ctrlcity-navigation {
  padding-inline: 10px;
}

.sidebar-is-collapsed .ctrlcity-navigation a {
  justify-content: center;
  padding-inline: 0;
}

.sidebar-is-collapsed .sidebar-footer {
  justify-content: center;
  margin-inline: 12px;
}

.ctrlcity-main {
  min-width: 0;
  margin-left: 208px;
  transition: margin-left 240ms ease;
}

.sidebar-is-collapsed .ctrlcity-main {
  margin-left: 76px;
}

.ctrlcity-header {
  max-width: 1760px;
  margin: auto;
  padding: 20px 32px;
  display: flex;
  gap: 20px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
}

.header-heading p {
  font-size: var(--type-body2);
  letter-spacing: .12em;
  color: var(--muted);
  margin-bottom: 7px;
}

/**
 * The page title is the H3 role, so it steps 32 -> 28 -> 24 on its own and
 * needs no per-breakpoint size. Line-height and tracking come from the scale
 * too; only the flex layout for the trailing badge is local.
 */
.header-heading h1 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  font-size: var(--type-h3);
  line-height: var(--type-h3-lh);
  letter-spacing: var(--type-h3-ls);
  font-weight: 650;
}

.header-badge {
  font-size: var(--type-body2);
  font-weight: 500;
  letter-spacing: .03em;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--canvas));
  border-radius: 5px;
  padding: 4px 7px;
}

.header-theme {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--muted);
  font-size: var(--type-body2);
}

.header-theme:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.header-theme svg {
  font-size: var(--icon-md);
}

@keyframes sidebar-liquid-metal {

  0%,
  100% {
    background-position: 0% 50%;
  }

  50% {
    background-position: 100% 50%;
  }
}

@keyframes sidebar-metal-glint {

  0%,
  20% {
    transform: translateX(-70%) rotate(12deg);
    opacity: 0;
  }

  45% {
    opacity: 1;
  }

  70%,
  100% {
    transform: translateX(70%) rotate(12deg);
    opacity: 0;
  }
}

@media (max-width: 1279px) {
  .ctrlcity-header {
    padding: 20px 22px;
  }
}

@media (max-width: 900px) {

  .ctrlcity-sidebar,
  .sidebar-is-collapsed .ctrlcity-sidebar {
    position: static;
    width: 100%;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .ctrlcity-brand,
  .sidebar-is-collapsed .ctrlcity-brand {
    justify-content: flex-start;
    margin: 12px 20px;
  }

  .ctrlcity-logo,
  .sidebar-is-collapsed .ctrlcity-logo {
    width: 76px;
  }

  .ctrlcity-main,
  .sidebar-is-collapsed .ctrlcity-main {
    margin-left: 0;
  }

  .nav-caption,
  .sidebar-footer,
  .sidebar-toggle {
    display: none;
  }

  .ctrlcity-navigation,
  .sidebar-is-collapsed .ctrlcity-navigation {
    flex-direction: row;
    padding: 0 12px 10px;
    gap: 5px;
    overflow-x: auto;
  }

  .ctrlcity-navigation a,
  .sidebar-is-collapsed .ctrlcity-navigation a {
    justify-content: flex-start;
    padding: 10px 12px;
    flex-shrink: 0;
    font-size: var(--type-body2);
  }

  .sidebar-is-collapsed .ctrlcity-navigation a>span {
    display: inline;
  }

  .ctrlcity-navigation .nav-arrow {
    display: none;
  }
}

@media (max-width: 640px) {
  .ctrlcity-header {
    padding: 20px 16px;
    gap: 10px;
  }

  .header-heading h1 {
    gap: 8px;
  }

  .header-theme span {
    display: none;
  }

  .header-theme {
    width: 44px;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {

  .ctrlcity-sidebar,
  .ctrlcity-main {
    transition: none;
  }

  .sidebar-toggle,
  .sidebar-toggle::before {
    animation: none;
  }
}
</style>
