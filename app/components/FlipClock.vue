<script setup lang="ts">
/**
 * SSR/client must render the same markup on first paint, so `now` starts
 * `null` (static placeholder tiles) and only ticks once mounted -- seeding
 * it with `new Date()` here would bake a build-time snapshot into the
 * prerendered HTML and mismatch the client's real clock on hydration.
 */
const now = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  now.value = new Date()
  timer = setInterval(() => { now.value = new Date() }, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

function pad(value: number) {
  return String(value).padStart(2, '0')
}

const digits = computed(() => {
  const value = now.value
  const parts = value
    ? [pad(value.getHours()), pad(value.getMinutes()), pad(value.getSeconds())]
    : ['--', '--', '--']
  return parts.map(part => [...part])
})

const clockLabel = computed(() => digits.value.map(part => part.join('')).join(':'))
</script>

<template>
  <div class="inline-flex items-center gap-1.5" role="img" :aria-label="`目前時間 ${clockLabel}`">
    <template v-for="(group, groupIndex) in digits" :key="groupIndex">
      <div class="flex gap-0.5">
        <FlipClockDigit v-for="(digit, digitIndex) in group" :key="digitIndex" :digit="digit" />
      </div>
      <span v-if="groupIndex < digits.length - 1" class="text-lg font-bold text-muted" aria-hidden="true">:</span>
    </template>
  </div>
</template>
