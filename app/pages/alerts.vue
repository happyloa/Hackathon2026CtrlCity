<script setup lang="ts">
const route = useRoute()

onMounted(() => {
  void navigateTo({ path: '/stations', query: route.query }, { replace: true })
})
</script>

<template>
  <div class="loading-board m-4" role="status" aria-live="polite">正在開啟站點總覽…</div>
</template>
