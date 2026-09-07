<script setup lang="ts">
defineProps<{ digit: string }>()
</script>

<template>
  <span
    class="relative inline-grid h-9 w-8 place-items-center overflow-hidden rounded-md bg-panel-muted font-mono text-3xl font-extrabold text-ink shadow-sm"
    aria-hidden="true">
    <Transition name="flip-digit">
      <span :key="digit" class="absolute inset-0 grid place-items-center">{{ digit }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.flip-digit-enter-active,
.flip-digit-leave-active {
  transition: transform 220ms ease, opacity 220ms ease;
}

.flip-digit-enter-from {
  transform: rotateX(90deg);
  opacity: 0;
}

.flip-digit-leave-to {
  transform: rotateX(-90deg);
  opacity: 0;
}
</style>
