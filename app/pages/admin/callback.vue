<script setup lang="ts">
const auth = useDispatcherAuth()
const error = ref('')
onMounted(async () => {
  try { await navigateTo(await auth.completeSignIn(), { replace: true }) }
  catch { history.replaceState(null, '', '/admin/callback'); error.value = '登入未完成或已過期，請重新登入。' }
})
</script>
<template>
  <main class="p-6 text-body1">
    <p role="status">{{ error || '正在完成登入…' }}</p>
    <NuxtLink v-if="error" to="/admin/adjustments" class="text-accent">返回營運調整</NuxtLink>
  </main>
</template>
