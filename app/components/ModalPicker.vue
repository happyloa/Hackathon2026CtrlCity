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
  <div class="modal-picker">
    <span class="modal-picker-label">{{ label }}</span>
    <button
      ref="triggerRef"
      class="modal-picker-trigger"
      type="button"
      :disabled="disabled || !options.length"
      :aria-haspopup="'dialog'"
      :aria-expanded="isOpen"
      :aria-label="`開啟${label}選單，目前為${selectedLabel}`"
      @click="open"
    >
      <span>{{ selectedLabel }}</span>
      <Icon icon="solar:alt-arrow-down-outline" />
    </button>

    <Teleport to="body">
      <Transition name="picker">
      <div v-if="isOpen" class="modal-picker-backdrop" @mousedown.self="close()">
        <section ref="dialogRef" class="modal-picker-dialog" role="dialog" aria-modal="true" :aria-labelledby="dialogTitleId" tabindex="-1">
          <header class="modal-picker-header">
            <div>
              <span>{{ label }}</span>
              <h2 :id="dialogTitleId">{{ dialogTitle }}</h2>
            </div>
            <button class="modal-picker-close" type="button" aria-label="關閉選單" @click="close()">
              <Icon icon="solar:close-circle-outline" />
            </button>
          </header>

          <label v-if="options.length > 8" class="modal-picker-search">
            <Icon icon="solar:magnifer-outline" />
            <span class="sr-only">搜尋{{ label }}</span>
            <input ref="searchRef" v-model="searchQuery" type="search" :placeholder="`搜尋${label}`" autocomplete="off" />
          </label>

          <div class="modal-picker-options" role="listbox" :aria-label="`${label}選項`">
            <button
              v-for="(option, index) in visibleOptions"
              :key="option.value || '__all__'"
              :ref="element => setOptionRef(element, index)"
              class="modal-picker-option"
              :class="{ selected: option.value === modelValue }"
              type="button"
              role="option"
              :tabindex="index === activeOptionIndex ? 0 : -1"
              :aria-selected="option.value === modelValue"
              @focus="activeOptionIndex = index"
              @click="choose(option.value)"
              @keydown="onOptionKeydown($event, index)"
            >
              <span>{{ option.label }}</span>
              <Icon v-if="option.value === modelValue" icon="solar:check-circle-outline" />
            </button>
            <p v-if="!visibleOptions.length" class="modal-picker-empty">找不到符合的選項。</p>
          </div>
        </section>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-picker { display: grid; min-width: 0; gap: 5px; color: var(--muted); font-size: 16px; font-weight: 700; }
.modal-picker-label { color: inherit; }
.modal-picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 38px; padding: 8px 9px; color: var(--ink); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 5px; font: inherit; font-size: 16px; font-weight: 800; text-align: left; }
.modal-picker-trigger span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-picker-trigger svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 19px; }
.modal-picker-trigger:hover:not(:disabled) { border-color: var(--teal-dark); }
.modal-picker-trigger:disabled { cursor: not-allowed; opacity: .6; }

.modal-picker-backdrop { position: fixed; z-index: 1200; inset: 0; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / .56); }
.modal-picker-dialog { width: min(100%, 520px); max-height: min(78dvh, 680px); overflow: hidden; color: var(--ink); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: 0 24px 72px rgb(0 0 0 / .34); outline: 0; }
.modal-picker-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px; border-bottom: 1px solid var(--line); }
.modal-picker-header span { display: block; margin-bottom: 4px; color: var(--muted); font-size: 16px; font-weight: 700; }
.modal-picker-header h2 { margin: 0; color: var(--ink); font-size: clamp(20px, 3vw, 25px); line-height: 1.25; }
.modal-picker-close { display: inline-grid; flex: 0 0 auto; width: 42px; height: 42px; place-items: center; padding: 0; color: var(--ink); background: var(--surface-muted); border: 1px solid var(--line); border-radius: 5px; font: inherit; }
.modal-picker-close svg { font-size: 23px; }
.modal-picker-close:hover { color: var(--on-accent); background: var(--teal-dark); border-color: var(--teal-dark); }
.modal-picker-search { display: flex; align-items: center; gap: 8px; min-height: 46px; margin: 12px 12px 0; padding: 0 12px; color: var(--muted); background: var(--paper); border: 1px solid var(--line-strong); border-radius: 5px; }
.modal-picker-search:focus-within { border-color: var(--teal-dark); outline: 3px solid rgb(30 111 98 / .18); }
.modal-picker-search svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 20px; }
.modal-picker-search input { width: 100%; min-width: 0; padding: 10px 0; color: var(--ink); background: transparent; border: 0; outline: 0; font: inherit; font-size: 16px; }
.modal-picker-options { display: grid; max-height: min(60dvh, 540px); gap: 7px; padding: 12px; overflow-y: auto; }
.modal-picker-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 11px 13px; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 5px; font: inherit; font-size: 16px; font-weight: 700; text-align: left; }
.modal-picker-option svg { flex: 0 0 auto; color: var(--teal-dark); font-size: 21px; }
.modal-picker-option:hover, .modal-picker-option:focus-visible { border-color: var(--teal-dark); background: var(--surface-muted); outline: 0; }
.modal-picker-option.selected { color: var(--on-accent); background: var(--teal-dark); border-color: var(--teal-dark); }
.modal-picker-option.selected svg { color: currentColor; }
.modal-picker-empty { margin: 12px; color: var(--muted); font-size: 16px; text-align: center; }
.picker-enter-active, .picker-leave-active { transition: opacity .16s ease; }
.picker-enter-active .modal-picker-dialog, .picker-leave-active .modal-picker-dialog { transition: transform .16s ease, opacity .16s ease; }
.picker-enter-from, .picker-leave-to { opacity: 0; }
.picker-enter-from .modal-picker-dialog, .picker-leave-to .modal-picker-dialog { opacity: 0; transform: translateY(10px) scale(.985); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 540px) {
  .modal-picker-backdrop { align-items: end; padding: 10px; }
  .modal-picker-dialog { width: 100%; max-height: 82dvh; }
  .modal-picker-header { padding: 16px; }
  .modal-picker-options { max-height: 62dvh; padding: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  .picker-enter-active, .picker-leave-active, .picker-enter-active .modal-picker-dialog, .picker-leave-active .modal-picker-dialog { transition: none; }
}
</style>
