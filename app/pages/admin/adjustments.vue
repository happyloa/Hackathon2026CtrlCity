<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { formatLocalDateTime, type OperationalAdjustment, type OperationalAdjustmentDraft } from '~/shared/operational-adjustments.mjs'

// The station list comes from the profile artifact rather than the live feed:
// its ids are the ones the offline pipeline derives from city|district|name, so
// a recorded window is guaranteed to match. Live-feed ids are resolved through a
// separate match key and a mismatch would silently drop the exclusion.
const { stations: profileStations } = useOperationalRoi()
const {
  cloud,
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
  startAt: formatLocalDateTime(Date.now() + 8 * 3600000),
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

onMounted(() => {
  const query = useRoute().query
  const station = profileStations.find(item => item.name === query.stationName && item.district === query.district)
  if (station) selectedStationId.value = station.id
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
  notice.value = cloud.remote ? '已更新草稿，請儲存到雲端' : editingId.value ? '已更新排除窗' : '已新增排除窗'
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
}

function endOpenWindow(item: OperationalAdjustment) {
  closeNow(item.id, formatLocalDateTime(Date.now() + 8 * 3600000))
  notice.value = `已將「${item.stationName}」的排除窗結束於現在`
}

function download() {
  if (cloud.remote) { void cloud.save(); return }
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
  if (cloud.remote) { void cloud.reload(); return }
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
  <div class="mx-auto w-full max-w-screen-3xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">

    <section v-if="cloud.remote" class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <p role="status" class="text-body1">{{ cloud.status.value || '正在讀取雲端資料…' }}</p>
      <p v-if="!cloud.accessToken.value" class="text-body1">登入後可編輯</p>
      <button v-if="!cloud.accessToken.value" class="min-h-11 px-3 text-body1 text-accent" @click="cloud.signIn">登入</button>
      <button v-else class="min-h-11 px-3 text-body1 text-accent" @click="cloud.signOut">登出</button>
      <button :disabled="!cloud.canEdit.value" class="min-h-11 px-3 text-body1 text-accent" @click="cloud.restoreDraft">還原本分頁草稿</button>
      <p v-if="cloud.authError.value" role="alert">{{ cloud.authError.value }}</p>
      <NuxtLink to="/admin/events" class="text-body1 text-accent">活動管理</NuxtLink>
    </section>
    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <h2 class="m-0 text-h6 font-bold">{{ editingId ? '編輯排除窗' : '新增排除窗' }}</h2>
      <p class="mt-1 text-body1 leading-6 text-muted">
        記錄站點停止服務的期間。維修、道路施工或活動封閉期間的快照看起來與長期缺車一模一樣，不排除會讓模型誤以為該站永遠缺車。
      </p>

      <fieldset :disabled="!cloud.canEdit.value" class="mt-4 grid gap-3 lg:grid-cols-2">
        <ModalPicker v-model="selectedStationId" label="站點" :options="stationOptions" empty-label="站點資料載入中" />
        <label class="grid min-w-0 gap-1.5 text-body1 font-bold text-muted">
          <span>原因（選填）</span>
          <input v-model="draft.reason"
            class="min-h-11 w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-body1 font-normal text-ink outline-none focus:border-accent-strong"
            type="text" placeholder="例如：站體遷移、道路施工">
        </label>

        <label class="grid min-w-0 gap-1.5 text-body1 font-bold text-muted">
          <span>起始時間</span>
          <input v-model="draft.startAt"
            class="min-h-11 w-full rounded-md border bg-panel px-2.5 py-2 text-body1 font-normal text-ink outline-none focus:border-accent-strong"
            :class="issues.startAt ? 'border-danger' : 'border-line-strong'" type="datetime-local">
          <span v-if="issues.startAt" class="text-body1 font-normal text-danger">{{ issues.startAt }}</span>
        </label>

        <div class="grid min-w-0 gap-1.5 text-body1 font-bold text-muted">
          <span>結束時間</span>
          <label class="flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5">
            <input v-model="openEndedChecked" type="checkbox" class="size-4">
            <span class="font-normal text-ink">未定，持續關閉</span>
          </label>
          <input v-if="!openEndedChecked" v-model="draft.endAt"
            class="min-h-11 w-full rounded-md border bg-panel px-2.5 py-2 text-body1 font-normal text-ink outline-none focus:border-accent-strong"
            :class="issues.endAt ? 'border-danger' : 'border-line-strong'" type="datetime-local">
          <span v-if="issues.endAt" class="text-body1 font-normal text-danger">{{ issues.endAt }}</span>
        </div>
      </fieldset>

      <p v-if="issues.stationId" class="mt-2 text-body1 text-danger">{{ issues.stationId }}</p>

      <p v-if="pendingConflicts.length"
        class="mt-3 rounded-md border border-warning bg-warning-surface px-3 py-2 text-body1">
        這個站點已有 {{ pendingConflicts.length }} 筆時間重疊的排除窗，重疊不影響計算結果（同一時段只會被排除一次），但可能代表重複輸入。
      </p>

      <div class="mt-4 flex flex-wrap gap-2">
        <button
          class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-accent bg-accent px-4 text-body1 font-bold text-on-accent transition-colors hover:opacity-90"
          type="button" :disabled="!cloud.canEdit.value" @click="submit">
          <Icon class="icon-md" :icon="editingId ? 'solar:check-circle-outline' : 'solar:add-circle-outline'" />
          {{ editingId ? '儲存變更' : '新增' }}
        </button>
        <button v-if="editingId"
          class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-body1 font-bold text-ink transition-colors hover:border-accent-strong"
          type="button" @click="resetForm">
          取消編輯
        </button>
      </div>
    </section>

    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="m-0 text-h6 font-bold">已登錄的排除窗</h2>
          <p class="mt-1 mb-0 text-body1 text-muted">
            共 {{ adjustments.length }} 筆<span v-if="openEnded.length">，其中 {{ openEnded.length }} 筆持續關閉中</span>
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-body1 font-bold text-ink transition-colors hover:border-accent-strong"
            type="button" title="從 app/data/operational-adjustments.json 重新載入，覆蓋此瀏覽器的本機清單" @click="reload">
            <Icon class="icon-md text-accent" icon="solar:refresh-outline" /> {{ cloud.remote ? '重新載入雲端清單' : '重新載入內建清單' }}
          </button>
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-body1 font-bold text-ink transition-colors hover:border-accent-strong"
            type="button" :disabled="cloud.remote && (!cloud.canEdit.value || !cloud.dirty.value)" @click="download">
            <Icon class="icon-md text-accent" icon="solar:download-outline" /> {{ cloud.remote ? '儲存到雲端' : '匯出 JSON' }}
          </button>
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-body1 font-bold text-ink transition-colors hover:border-accent-strong"
            type="button" :disabled="!cloud.canEdit.value" @click="showImport = !showImport">
            <Icon class="icon-md text-accent" icon="solar:upload-outline" /> 匯入
          </button>
        </div>
      </div>

      <div v-if="showImport" class="mt-4 grid gap-2">
        <textarea v-model="importText"
          class="min-h-32 w-full rounded-md border border-line-strong bg-surface p-3 font-mono text-body2 text-ink outline-none focus:border-accent-strong"
          placeholder="貼上 operational-adjustments.json 的內容" />
        <div>
          <button
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-accent bg-accent px-4 text-body1 font-bold text-on-accent"
            type="button" :disabled="!cloud.canEdit.value" @click="runImport">
            覆蓋目前清單
          </button>
        </div>
      </div>

      <p v-if="notice" class="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-body1">{{ notice }}</p>

      <div v-if="adjustments.length" class="mt-4 overflow-x-auto">
        <table class="w-full min-w-208 border-collapse text-left text-body1">
          <thead>
            <tr class="border-b border-line text-muted">
              <th class="px-3 py-2 font-bold" scope="col">站點</th>
              <th class="px-3 py-2 font-bold" scope="col">原因</th>
              <th class="px-3 py-2 font-bold" scope="col">時間範圍</th>
              <th class="px-3 py-2 font-bold" scope="col">狀態</th>
              <th class="px-3 py-2 text-right font-bold" scope="col">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line">
            <tr v-for="item in adjustments" :key="item.id">
              <td class="px-3 py-3 align-top">
                <strong class="block wrap-break-word">{{ item.district }} {{ item.stationName }}</strong>
              </td>
              <td class="px-3 py-3 align-top text-muted">{{ item.reason || '—' }}</td>
              <td class="px-3 py-3 align-top text-muted">{{ windowLabel(item) }}</td>
              <td class="px-3 py-3 align-top">
                <span v-if="item.endAt === null"
                  class="inline-flex min-h-9 items-center rounded-md border border-warning bg-warning-surface px-2 text-body1 font-bold text-warning">持續關閉</span>
                <span v-else class="text-muted">已結束</span>
              </td>
              <td class="px-3 py-3 align-top">
                <div class="flex flex-wrap justify-end gap-2">
                  <button v-if="item.endAt === null"
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-panel px-2 text-body1 font-bold text-ink hover:border-accent-strong"
                    type="button" :disabled="!cloud.canEdit.value" @click="endOpenWindow(item)">結束於現在</button>
                  <button
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-panel px-2 text-body1 font-bold text-ink hover:border-accent-strong"
                    type="button" :disabled="!cloud.canEdit.value" @click="edit(item)">
                    <Icon class="icon-md" icon="solar:pen-outline" /> 編輯
                  </button>
                  <button
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-panel px-2 text-body1 font-bold text-danger hover:border-danger"
                    type="button" :disabled="!cloud.canEdit.value" @click="remove(item.id)">
                    <Icon class="icon-md" icon="solar:trash-bin-trash-outline" /> 刪除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-else class="mt-4 text-body1 text-muted">尚未登錄任何排除窗。</p>
    </section>
  </div>
</template>
