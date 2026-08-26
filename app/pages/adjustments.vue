<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { formatLocalDateTime, type OperationalAdjustment, type OperationalAdjustmentDraft } from '~/shared/operational-adjustments.mjs'

// The station list comes from the profile artifact rather than the live feed:
// its ids are the ones the offline pipeline derives from city|district|name, so
// a recorded window is guaranteed to match. Live-feed ids are resolved through a
// separate match key and a mismatch would silently drop the exclusion.
const { stations: profileStations } = useOperationalRoi()
const {
  adjustments,
  openEnded,
  add,
  update,
  remove,
  closeNow,
  conflictsFor,
  exportPayload,
  importPayload,
  reloadFromSeed,
} = useOperationalAdjustments()

const stationOptions = computed(() => [...profileStations]
  .sort((left, right) =>
    left.district.localeCompare(right.district, 'zh-Hant') || left.name.localeCompare(right.name, 'zh-Hant'))
  .map(station => ({ value: station.id, label: `${station.district} ${station.name}` })))

const emptyDraft = (): OperationalAdjustmentDraft => ({
  stationId: '',
  stationName: '',
  district: '',
  reason: '',
  startAt: formatLocalDateTime(Date.now()).slice(0, 14) + '00',
  endAt: null,
})

const draft = ref<OperationalAdjustmentDraft>(emptyDraft())
const editingId = ref<string | null>(null)
const openEndedChecked = ref(true)
const issues = ref<Record<string, string>>({})
const notice = ref('')
const importText = ref('')
const showImport = ref(false)

const selectedStationId = computed({
  get: () => draft.value.stationId,
  set: (value: string) => {
    const station = profileStations.find(item => item.id === value)
    draft.value = {
      ...draft.value,
      stationId: value,
      stationName: station?.name || '',
      district: station?.district || '',
    }
  },
})

const pendingConflicts = computed(() => {
  if (!draft.value.stationId) return []
  const candidate: OperationalAdjustment = {
    id: editingId.value || '__draft__',
    ...draft.value,
    endAt: openEndedChecked.value ? null : draft.value.endAt,
    createdAt: '',
    updatedAt: '',
  }
  return conflictsFor(candidate)
})

function resetForm() {
  draft.value = emptyDraft()
  editingId.value = null
  openEndedChecked.value = true
  issues.value = {}
}

function submit() {
  const payload: OperationalAdjustmentDraft = {
    ...draft.value,
    endAt: openEndedChecked.value ? null : draft.value.endAt,
  }
  const result = editingId.value ? update(editingId.value, payload) : add(payload)
  if (!result.ok) {
    issues.value = Object.fromEntries(result.issues.map(issue => [issue.field, issue.message]))
    return
  }
  notice.value = editingId.value ? '已更新排除窗' : '已新增排除窗'
  resetForm()
}

function edit(item: OperationalAdjustment) {
  editingId.value = item.id
  openEndedChecked.value = item.endAt === null
  draft.value = {
    stationId: item.stationId,
    stationName: item.stationName,
    district: item.district,
    reason: item.reason,
    startAt: item.startAt,
    endAt: item.endAt,
  }
  issues.value = {}
}

function endOpenWindow(item: OperationalAdjustment) {
  closeNow(item.id, formatLocalDateTime(Date.now()).slice(0, 14) + '00')
  notice.value = `已將「${item.stationName}」的排除窗結束於現在`
}

function download() {
  if (!import.meta.client) return
  const blob = new Blob([exportPayload()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'operational-adjustments.json'
  anchor.click()
  URL.revokeObjectURL(url)
  notice.value = '已匯出，請覆蓋 app/data/operational-adjustments.json 後重跑統計'
}

function reload() {
  const count = reloadFromSeed()
  notice.value = `已重新載入內建清單，共 ${count} 筆（此瀏覽器先前的本機編輯已被覆蓋）`
}

function runImport() {
  const result = importPayload(importText.value)
  if (!result.ok) {
    notice.value = result.message
    return
  }
  notice.value = `已匯入 ${result.count} 筆排除窗`
  importText.value = ''
  showImport.value = false
}

function windowLabel(item: OperationalAdjustment) {
  return item.endAt === null
    ? `${item.startAt.replace('T', ' ')} 起，持續關閉`
    : `${item.startAt.replace('T', ' ')} → ${item.endAt.replace('T', ' ')}`
}
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <section class="rounded-xl border border-warning bg-warning-surface p-4 sm:p-5">
      <div class="flex items-start gap-3">
        <Icon class="mt-0.5 shrink-0 text-2xl text-warning" icon="solar:info-circle-outline" />
        <div class="min-w-0 text-base leading-6">
          <strong class="block">這裡的設定只存在這台瀏覽器</strong>
          <p class="mt-1 mb-0 text-muted">
            本站是靜態網站、沒有後端資料庫。要讓模型真正忽略這些站點時段，必須按
            <strong class="text-ink">匯出</strong>，用檔案覆蓋
            <code class="rounded bg-panel px-1">app/data/operational-adjustments.json</code>
            後重跑統計。只在這頁新增而沒有匯出，模型不會知道。
          </p>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <h2 class="m-0 text-xl font-bold">{{ editingId ? '編輯排除窗' : '新增排除窗' }}</h2>
      <p class="mt-1 text-base leading-6 text-muted">
        記錄站點停止服務的期間。維修、道路施工或活動封閉期間的快照看起來與長期缺車一模一樣，不排除會讓模型誤以為該站永遠缺車。
      </p>

      <div class="mt-4 grid gap-3 lg:grid-cols-2">
        <ModalPicker
          v-model="selectedStationId"
          label="站點"
          :options="stationOptions"
          empty-label="站點資料載入中"
        />
        <label class="grid min-w-0 gap-1.5 text-base font-bold text-muted">
          <span>原因（選填）</span>
          <input
            v-model="draft.reason"
            class="min-h-11 w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-base font-normal text-ink outline-none focus:border-accent-strong"
            type="text"
            placeholder="例如：站體遷移、道路施工"
          >
        </label>

        <label class="grid min-w-0 gap-1.5 text-base font-bold text-muted">
          <span>起始時間</span>
          <input
            v-model="draft.startAt"
            class="min-h-11 w-full rounded-md border bg-panel px-2.5 py-2 text-base font-normal text-ink outline-none focus:border-accent-strong"
            :class="issues.startAt ? 'border-danger' : 'border-line-strong'"
            type="datetime-local"
          >
          <span v-if="issues.startAt" class="text-base font-normal text-danger">{{ issues.startAt }}</span>
        </label>

        <div class="grid min-w-0 gap-1.5 text-base font-bold text-muted">
          <span>結束時間</span>
          <label class="flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5">
            <input v-model="openEndedChecked" type="checkbox" class="size-4">
            <span class="font-normal text-ink">未定，持續關閉</span>
          </label>
          <input
            v-if="!openEndedChecked"
            v-model="draft.endAt"
            class="min-h-11 w-full rounded-md border bg-panel px-2.5 py-2 text-base font-normal text-ink outline-none focus:border-accent-strong"
            :class="issues.endAt ? 'border-danger' : 'border-line-strong'"
            type="datetime-local"
          >
          <span v-if="issues.endAt" class="text-base font-normal text-danger">{{ issues.endAt }}</span>
        </div>
      </div>

      <p v-if="issues.stationId" class="mt-2 text-base text-danger">{{ issues.stationId }}</p>

      <p v-if="pendingConflicts.length" class="mt-3 rounded-md border border-warning bg-warning-surface px-3 py-2 text-base">
        這個站點已有 {{ pendingConflicts.length }} 筆時間重疊的排除窗，重疊不影響計算結果（同一時段只會被排除一次），但可能代表重複輸入。
      </p>

      <div class="mt-4 flex flex-wrap gap-2">
        <button
          class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-accent bg-accent px-4 text-base font-bold text-on-accent transition-colors hover:opacity-90"
          type="button"
          @click="submit"
        >
          <Icon class="text-xl" :icon="editingId ? 'solar:check-circle-outline' : 'solar:add-circle-outline'" />
          {{ editingId ? '儲存變更' : '新增' }}
        </button>
        <button
          v-if="editingId"
          class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-base font-bold text-ink transition-colors hover:border-accent-strong"
          type="button"
          @click="resetForm"
        >
          取消編輯
        </button>
      </div>
    </section>

    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="m-0 text-xl font-bold">已登錄的排除窗</h2>
          <p class="mt-1 mb-0 text-base text-muted">
            共 {{ adjustments.length }} 筆<span v-if="openEnded.length">，其中 {{ openEnded.length }} 筆持續關閉中</span>
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-base font-bold text-ink transition-colors hover:border-accent-strong"
            type="button"
            title="從 app/data/operational-adjustments.json 重新載入，覆蓋此瀏覽器的本機清單"
            @click="reload"
          >
            <Icon class="text-xl text-accent" icon="solar:refresh-outline" /> 重新載入內建清單
          </button>
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-base font-bold text-ink transition-colors hover:border-accent-strong"
            type="button"
            @click="download"
          >
            <Icon class="text-xl text-accent" icon="solar:download-outline" /> 匯出 JSON
          </button>
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-base font-bold text-ink transition-colors hover:border-accent-strong"
            type="button"
            @click="showImport = !showImport"
          >
            <Icon class="text-xl text-accent" icon="solar:upload-outline" /> 匯入
          </button>
        </div>
      </div>

      <div v-if="showImport" class="mt-4 grid gap-2">
        <textarea
          v-model="importText"
          class="min-h-32 w-full rounded-md border border-line-strong bg-surface p-3 font-mono text-sm text-ink outline-none focus:border-accent-strong"
          placeholder="貼上 operational-adjustments.json 的內容"
        />
        <div>
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-accent bg-accent px-4 text-base font-bold text-on-accent"
            type="button"
            @click="runImport"
          >
            覆蓋目前清單
          </button>
        </div>
      </div>

      <p v-if="notice" class="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-base">{{ notice }}</p>

      <div v-if="adjustments.length" class="mt-4 grid gap-2">
        <article
          v-for="item in adjustments"
          :key="item.id"
          class="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-surface p-3"
        >
          <div class="min-w-0">
            <strong class="block truncate text-base">{{ item.district }} {{ item.stationName }}</strong>
            <span class="mt-0.5 block text-base text-muted">{{ windowLabel(item) }}</span>
            <span v-if="item.reason" class="mt-0.5 block text-base text-muted">{{ item.reason }}</span>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            <span
              v-if="item.endAt === null"
              class="inline-flex min-h-9 items-center rounded-md border border-warning bg-warning-surface px-2 text-base font-bold text-warning"
            >持續關閉</span>
            <button
              v-if="item.endAt === null"
              class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-panel px-2 text-base font-bold text-ink hover:border-accent-strong"
              type="button"
              @click="endOpenWindow(item)"
            >結束於現在</button>
            <button
              class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-panel px-2 text-base font-bold text-ink hover:border-accent-strong"
              type="button"
              @click="edit(item)"
            >
              <Icon class="text-lg" icon="solar:pen-outline" /> 編輯
            </button>
            <button
              class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-panel px-2 text-base font-bold text-danger hover:border-danger"
              type="button"
              @click="remove(item.id)"
            >
              <Icon class="text-lg" icon="solar:trash-bin-trash-outline" /> 刪除
            </button>
          </div>
        </article>
      </div>

      <p v-else class="mt-4 text-base text-muted">尚未登錄任何排除窗。</p>
    </section>
  </div>
</template>
