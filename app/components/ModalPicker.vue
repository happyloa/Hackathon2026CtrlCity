<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { ComponentPublicInstance } from 'vue'

type PickerOption = {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  title?: string
  options: PickerOption[]
  emptyLabel?: string
  unselectedLabel?: string
  disabled?: boolean
}>(), {
  title: '',
  emptyLabel: '尚無可選項目',
  unselectedLabel: '請選擇',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const isOpen = ref(false)
const searchQuery = ref('')
const triggerRef = ref<HTMLButtonElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const optionRefs = ref<HTMLButtonElement[]>([])
const activeOptionIndex = ref(0)
let previousBodyOverflow = ''

const dialogTitle = computed(() => props.title || `選擇${props.label}`)
const dialogTitleId = `picker-title-${useId().replace(/:/g, '')}`
const selectedOption = computed(() => props.options.find(option => option.value === props.modelValue))
const selectedLabel = computed(() => selectedOption.value?.label || (props.options.length ? props.unselectedLabel : props.emptyLabel))
const visibleOptions = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-TW')
  return query
    ? props.options.filter(option => option.label.toLocaleLowerCase('zh-TW').includes(query))
    : props.options
})

function open() {
  if (props.disabled || !props.options.length) return
  searchQuery.value = ''
  isOpen.value = true
}

function close({ returnFocus = true }: { returnFocus?: boolean } = {}) {
  if (!isOpen.value) return
  isOpen.value = false
  if (returnFocus) void nextTick(() => triggerRef.value?.focus())
}

function choose(value: string) {
  emit('update:modelValue', value)
  close()
}

function setOptionRef(element: Element | ComponentPublicInstance | null, index: number) {
  if (element instanceof HTMLButtonElement) optionRefs.value[index] = element
}

function focusInitialControl() {
  const selectedIndex = visibleOptions.value.findIndex(option => option.value === props.modelValue)
  activeOptionIndex.value = Math.max(0, selectedIndex)
  if (props.options.length > 8) {
    searchRef.value?.focus()
    return
  }
  optionRefs.value[activeOptionIndex.value]?.focus()
}

function onOptionKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const lastIndex = visibleOptions.value.length - 1
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? lastIndex
      : event.key === 'ArrowDown'
        ? Math.min(lastIndex, index + 1)
        : Math.max(0, index - 1)
  activeOptionIndex.value = nextIndex
  optionRefs.value[nextIndex]?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (!isOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = Array.from(dialogRef.value?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled])') || [])
  if (!focusable.length) return
  const first = focusable.at(0)
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.value)) {
    event.preventDefault()
    first.focus()
  }
}

watch(isOpen, (open) => {
  if (!import.meta.client) return
  if (open) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    optionRefs.value = []
    void nextTick(focusInitialControl)
  } else {
    document.body.style.overflow = previousBodyOverflow
  }
})

watch(visibleOptions, (options) => {
  const selectedIndex = options.findIndex(option => option.value === props.modelValue)
  activeOptionIndex.value = Math.max(0, selectedIndex)
  optionRefs.value = []
})

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (import.meta.client) document.body.style.overflow = previousBodyOverflow
})
</script>

<template>
  <div class="grid min-w-0 gap-1.5 text-base font-bold text-muted">
    <span>{{ label }}</span>
    <button
      ref="triggerRef"
      class="flex min-h-11 w-full items-center justify-between gap-2.5 rounded-md border border-line-strong bg-panel px-2.5 py-2 text-left text-base font-extrabold text-ink transition-colors hover:border-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      :disabled="disabled || !options.length"
      :aria-haspopup="'dialog'"
      :aria-expanded="isOpen"
      :aria-label="`開啟${label}選單，目前為${selectedLabel}`"
      @click="open"
    >
      <span class="min-w-0 truncate">{{ selectedLabel }}</span>
      <Icon class="shrink-0 text-xl text-accent-strong" icon="solar:alt-arrow-down-outline" />
    </button>

    <Teleport to="body">
      <Transition name="picker">
      <div v-if="isOpen" class="fixed inset-0 z-50 grid items-end justify-center bg-black/60 p-2.5 sm:place-items-center sm:p-5" @mousedown.self="close()">
        <section ref="dialogRef" class="modal-picker-dialog flex max-h-svh w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line-strong bg-panel text-ink shadow-2xl outline-none transition-transform duration-150" role="dialog" aria-modal="true" :aria-labelledby="dialogTitleId" tabindex="-1">
          <header class="flex items-start justify-between gap-4 border-b border-line p-4 sm:p-5">
            <div>
              <span class="mb-1 block text-base font-bold text-muted">{{ label }}</span>
              <h2 :id="dialogTitleId" class="m-0 text-xl font-bold leading-tight text-ink sm:text-2xl">{{ dialogTitle }}</h2>
            </div>
            <button class="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-line bg-panel-muted p-0 text-ink transition-colors hover:border-accent-strong hover:bg-accent-strong hover:text-on-accent" type="button" aria-label="關閉選單" @click="close()">
              <Icon class="text-2xl" icon="solar:close-circle-outline" />
            </button>
          </header>

          <label v-if="options.length > 8" class="mx-3 mt-3 flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-muted focus-within:border-accent-strong sm:mx-4 sm:mt-4">
            <Icon class="shrink-0 text-xl text-accent-strong" icon="solar:magnifer-outline" />
            <span class="sr-only">搜尋{{ label }}</span>
            <input ref="searchRef" v-model="searchQuery" class="min-w-0 w-full bg-transparent py-2 text-base text-ink outline-none placeholder:text-muted" type="search" :placeholder="`搜尋${label}`" autocomplete="off" />
          </label>

          <div class="grid min-h-0 flex-1 gap-2 overflow-y-auto p-3 sm:p-4" role="listbox" :aria-label="`${label}選項`">
            <button
              v-for="(option, index) in visibleOptions"
              :key="option.value || '__all__'"
              :ref="element => setOptionRef(element, index)"
              class="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-base font-bold transition-colors focus-visible:border-accent-strong"
              :class="option.value === modelValue
                ? 'border-accent-strong bg-accent-strong text-on-accent hover:bg-accent-strong'
                : 'border-line bg-surface text-ink hover:border-accent-strong hover:bg-panel-muted'"
              type="button"
              role="option"
              :tabindex="index === activeOptionIndex ? 0 : -1"
              :aria-selected="option.value === modelValue"
              @focus="activeOptionIndex = index"
              @click="choose(option.value)"
              @keydown="onOptionKeydown($event, index)"
            >
              <span>{{ option.label }}</span>
              <Icon v-if="option.value === modelValue" class="shrink-0 text-xl text-current" icon="solar:check-circle-outline" />
            </button>
            <p v-if="!visibleOptions.length" class="m-3 text-center text-base text-muted">找不到符合的選項。</p>
          </div>
        </section>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>
