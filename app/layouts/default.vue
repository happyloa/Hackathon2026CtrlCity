<script setup lang="ts">
import { Icon } from '@iconify/vue'

const route = useRoute()
const isDark = ref(false)

const navigation = [
  { to: '/', label: '營運總覽', icon: 'solar:radar-2-outline' },
  { to: '/alerts', label: '告警處理', icon: 'solar:danger-triangle-outline' },
  { to: '/dispatch', label: '調度建議', icon: 'solar:routing-2-outline' },
]

const activeLabel = computed(() => navigation.find(item => item.to === route.path)?.label || '站點資訊')

function applyTheme() {
  document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light'
  localStorage.setItem('yb-ops-theme', isDark.value ? 'dark' : 'light')
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
      <NuxtLink to="/" class="brand" aria-label="前往調度戰情室">
        <span class="brand-mark"><Icon icon="solar:wheel-angle-outline" /></span>
        <span>
          <strong>新北市 YouBike</strong>
          <small>調度工作台</small>
        </span>
      </NuxtLink>

      <nav aria-label="主要導覽">
        <NuxtLink v-for="item in navigation" :key="item.to" :to="item.to" class="nav-link">
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
        <div>
          <p class="eyebrow">新北市公共自行車營運調度</p>
          <h1>{{ activeLabel }}</h1>
        </div>
        <div class="topbar-meta">
          <span class="topbar-context"><Icon icon="solar:map-point-outline" /> 新北市服務範圍</span>
          <button class="theme-toggle" type="button" :aria-pressed="isDark" :aria-label="isDark ? '切換為淺色模式' : '切換為深色模式'" @click="toggleTheme">
            <Icon :icon="isDark ? 'solar:sun-2-outline' : 'solar:moon-outline'" />
            {{ isDark ? '淺色模式' : '深色模式' }}
          </button>
        </div>
      </header>
      <slot />
    </main>
  </div>
</template>
