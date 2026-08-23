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
    ?.setAttribute('content', isDark.value ? '#09090b' : '#fafafa')
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
  <div class="min-h-svh bg-canvas text-ink">
    <aside class="border-b border-line bg-panel lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-b-0">
      <div class="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:block lg:px-5 lg:py-6">
        <NuxtLink :to="navigationTarget('/')" class="inline-flex min-w-0 items-center gap-3 no-underline" aria-label="前往營運總覽">
          <span class="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface text-xl text-accent"><Icon icon="solar:wheel-angle-outline" /></span>
          <span class="min-w-0">
            <strong class="block truncate text-lg leading-6">新北市 YouBike</strong>
            <span class="block text-base leading-6 text-muted">調度工作台</span>
          </span>
        </NuxtLink>
      </div>

      <nav class="flex gap-2 overflow-x-auto px-4 pb-3 sm:px-6 lg:mt-2 lg:flex-col lg:px-4 lg:pb-0" aria-label="主要導覽">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="navigationTarget(item.to)"
          class="inline-flex min-h-11 shrink-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-base font-semibold no-underline transition-colors"
          :class="route.path === item.to ? 'border-accent bg-accent text-on-accent shadow-sm' : 'text-muted hover:border-line hover:bg-surface hover:text-ink'"
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
          <span class="mt-2 size-2 shrink-0 rounded-full bg-positive" aria-hidden="true" />
          <div>
            <span class="block text-base text-muted">資料範圍</span>
            <strong class="mt-1 block text-base leading-6">即時站況／歷史回放</strong>
          </div>
        </div>
        <p class="mt-4 text-base leading-6 text-muted">庫存風險與調度建議均需由值班人員覆核。</p>
      </div>
    </aside>

    <main class="min-w-0 lg:ml-64">
      <header class="border-b border-line bg-canvas">
        <div class="mx-auto flex w-full max-w-screen-2xl flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:py-5">
          <div class="min-w-0">
            <p class="inline-flex items-center gap-2 text-base font-semibold tracking-wide text-accent">公共自行車營運調度</p>
            <h1 class="mt-1 text-2xl font-bold tracking-tight">{{ activeLabel }}</h1>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="inline-flex min-h-11 items-center gap-2 rounded-lg bg-surface px-3 text-base font-semibold text-muted"><Icon class="text-xl text-accent" icon="solar:map-point-outline" /> 新北市服務範圍</span>
            <button class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-base font-semibold text-ink transition-colors hover:bg-surface" type="button" :aria-pressed="isDark" :aria-label="isDark ? '切換為淺色模式' : '切換為深色模式'" @click="toggleTheme">
              <Icon class="text-xl text-accent" :icon="isDark ? 'solar:sun-2-outline' : 'solar:moon-outline'" />
              <span>{{ isDark ? '淺色模式' : '深色模式' }}</span>
            </button>
          </div>
        </div>
      </header>
      <slot />
    </main>
  </div>
</template>
