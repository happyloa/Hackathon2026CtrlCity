<script setup lang="ts">
import { Icon } from '@iconify/vue'

const route = useRoute()
const isDark = ref(false)

const navigation = [
  { to: '/', label: '調度中心', icon: 'solar:radar-2-outline' },
  { to: '/alerts', label: '全部風險', icon: 'solar:danger-triangle-outline' },
  { to: '/dispatch', label: '全部任務', icon: 'solar:routing-2-outline' },
]

const activeLabel = computed(() => navigation.find(item => item.to === route.path)?.label || '站點資訊')
const navigationQuery = computed(() => Object.fromEntries(
  ['mode', 'at', 'district']
    .map(key => [key, route.query[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])),
))
const navigationTarget = (path: string) => ({ path, query: navigationQuery.value })

function applyTheme() {
  document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light'
  localStorage.setItem('yb-ops-theme', isDark.value ? 'dark' : 'light')
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', isDark.value ? '#151517' : '#f5f5f1')
}

function toggleTheme() {
  isDark.value = !isDark.value
  applyTheme()
}

onMounted(() => {
  const savedTheme = localStorage.getItem('yb-ops-theme')
  isDark.value = savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)
  applyTheme()
})
</script>

<template>
  <div class="app-shell">
    <aside class="side-nav">
      <NuxtLink :to="navigationTarget('/')" class="brand" aria-label="前往營運總覽">
        <span class="brand-mark"><Icon icon="solar:wheel-angle-outline" /></span>
        <span>
          <strong>新北市 YouBike</strong>
          <small>調度工作台</small>
        </span>
      </NuxtLink>

      <nav aria-label="主要導覽">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="navigationTarget(item.to)"
          class="nav-link"
          :aria-label="item.label"
          :title="item.label"
        >
          <Icon :icon="item.icon" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="side-spacer" />
      <div class="side-status">
        <span class="status-dot" />
        <div>
          <small>資料範圍</small>
          <strong>即時站況／歷史回放</strong>
        </div>
      </div>
      <p class="side-note">庫存風險與調度建議均需由值班人員覆核。</p>
    </aside>

    <main class="main-canvas">
      <header class="topbar">
        <div class="topbar-title">
          <p class="eyebrow">公共自行車營運調度</p>
          <h1>{{ activeLabel }}</h1>
        </div>
        <div class="topbar-meta">
          <span class="topbar-context"><Icon icon="solar:map-point-outline" /> 新北市服務範圍</span>
          <button class="theme-toggle" type="button" :aria-pressed="isDark" :aria-label="isDark ? '切換為淺色模式' : '切換為深色模式'" @click="toggleTheme">
            <Icon :icon="isDark ? 'solar:sun-2-outline' : 'solar:moon-outline'" />
            <span>{{ isDark ? '淺色模式' : '深色模式' }}</span>
          </button>
        </div>
      </header>
      <slot />
    </main>
  </div>
</template>
