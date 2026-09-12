<script setup lang="ts">
import { displayStationName } from '~/shared/ops'
import type { DemandEventPattern } from '~/shared/demand-events.mjs'

const { events, cloud, replace } = useDemandEvents()
const live = useLiveDashboard()
onMounted(() => { if (!live.dashboard.value) void live.refresh() })

const PATTERN_OPTIONS: { value: DemandEventPattern; label: string; hint: string }[] = [
  { value: 'borrow_surge', label: '單純借車潮（全程缺車風險）', hint: '整段時間借車量偏高，例如長時間開放的市集或景點。' },
  { value: 'return_surge', label: '單純還車潮（全程滿車風險）', hint: '整段時間還車量偏高，站點容易滿位。' },
  { value: 'fills_then_empties', label: '先滿後空（開場還車、散場借車）', hint: '單場次活動最常見：開場人潮湧入還車，散場人潮湧出借車。' },
  { value: 'empties_then_fills', label: '先空後滿（開場借車、散場還車）', hint: '較少見：開場人潮騎車前來聚集，散場再還車離開。' },
]

const name = ref('')
const selectedStationIds = ref<string[]>([])
const stationQuery = ref('')
const startAt = ref('')
const endAt = ref('')
const pattern = ref<DemandEventPattern>('borrow_surge')
const note = ref('')
const error = ref('')

function patternLabel(value: DemandEventPattern): string {
  return PATTERN_OPTIONS.find(option => option.value === value)?.label ?? value
}

const stationLookup = computed(() => new Map((live.dashboard.value?.stations ?? []).map(station => [station.id, station])))

const stationMatches = computed(() => {
  const query = stationQuery.value.trim()
  if (!query) return []
  return (live.dashboard.value?.stations ?? [])
    .filter(station => !selectedStationIds.value.includes(station.id))
    .filter(station => station.name.includes(query) || station.district.includes(query) || station.id.includes(query))
    .slice(0, 8)
})

function addStation(id: string) {
  if (!selectedStationIds.value.includes(id)) selectedStationIds.value = [...selectedStationIds.value, id]
  stationQuery.value = ''
}
function removeStation(id: string) {
  selectedStationIds.value = selectedStationIds.value.filter(existing => existing !== id)
}
function stationLabel(id: string): string {
  const station = stationLookup.value.get(id)
  return station ? `${displayStationName(station.name)}（${station.district}）` : `${id}（找不到對應站點，請確認代號是否正確）`
}
function stationUnresolved(id: string): boolean {
  return !stationLookup.value.has(id)
}

function add() {
  try {
    replace({ events: [...events.value, { id: crypto.randomUUID(), name: name.value, stationIds: selectedStationIds.value, startAt: startAt.value, endAt: endAt.value, pattern: pattern.value, note: note.value }] })
    error.value = ''; name.value = ''; note.value = ''; selectedStationIds.value = []; pattern.value = 'borrow_surge'
  } catch (cause) { error.value = (cause as Error).message }
}
function remove(id: string) { replace({ events: events.value.filter(event => event.id !== id) }) }
</script>
<template>
  <main class="mx-auto max-w-screen-lg space-y-4 p-6 text-body1">
    <h1 class="text-h5 font-bold">活動管理</h1>
    <NuxtLink to="/admin/adjustments" class="text-accent">營運排除窗</NuxtLink>
    <p>記錄活動名稱、影響站點與台北時間。活動開始前 60 分鐘內，營運總覽與調度規劃會依此評估鄰近站點的補位能力。</p>
    <p role="status">{{ cloud.status.value }}</p>
    <p v-if="cloud.authError.value" role="alert">{{ cloud.authError.value }}</p>
    <div v-if="cloud.remote" class="flex flex-wrap gap-3">
      <p v-if="!cloud.enabled">目前開放雲端唯讀，尚未啟用調度登入。</p>
      <button v-if="cloud.enabled && !cloud.accessToken.value" class="min-h-11 text-accent" @click="cloud.signIn">登入後可編輯</button>
      <button v-else class="min-h-11 text-accent" @click="cloud.signOut">登出</button>
      <button :disabled="cloud.pending.value" class="min-h-11 text-accent" @click="cloud.reload">重新載入雲端清單</button>
      <button :disabled="!cloud.canEdit.value || !cloud.dirty.value" class="min-h-11 text-accent" @click="cloud.save">儲存到雲端</button>
      <button :disabled="!cloud.canEdit.value" class="min-h-11 text-accent" @click="cloud.restoreDraft">還原本分頁草稿</button>
    </div>
    <fieldset :disabled="!cloud.canEdit.value" class="grid gap-3 rounded-xl border border-line bg-panel p-4">
      <label class="grid gap-1">活動名稱<input v-model="name" class="min-h-11 border border-line bg-surface p-2" /></label>
      <div class="grid gap-1">
        <span>影響站點</span>
        <p v-if="!live.dashboard.value" role="status" class="text-body2 text-muted">正在載入即時站點清單，載入後可用站名搜尋…</p>
        <div class="flex flex-wrap gap-2">
          <span v-for="id in selectedStationIds" :key="id"
            class="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-body2"
            :class="{ 'border-danger text-danger': stationUnresolved(id) }">
            {{ stationLabel(id) }}
            <button type="button" class="text-muted hover:text-danger" @click="removeStation(id)" aria-label="移除此站點">×</button>
          </span>
        </div>
        <input v-model="stationQuery" placeholder="輸入站名、行政區或站點代號搜尋"
          class="min-h-11 border border-line bg-surface p-2" />
        <ul v-if="stationMatches.length" class="grid gap-1 rounded-lg border border-line bg-surface p-2">
          <li v-for="station in stationMatches" :key="station.id">
            <button type="button" class="min-h-9 w-full text-left text-accent hover:underline"
              @click="addStation(station.id)">
              {{ displayStationName(station.name) }}（{{ station.district || '行政區未標示' }}）
            </button>
          </li>
        </ul>
      </div>
      <label class="grid gap-1">開始時間<input v-model="startAt" type="datetime-local" class="min-h-11 border border-line bg-surface p-2" /></label>
      <label class="grid gap-1">結束時間<input v-model="endAt" type="datetime-local" class="min-h-11 border border-line bg-surface p-2" /></label>
      <label class="grid gap-1">人潮模式
        <select v-model="pattern" class="min-h-11 border border-line bg-surface p-2">
          <option v-for="option in PATTERN_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <span class="text-body2 text-muted">{{ PATTERN_OPTIONS.find(option => option.value === pattern)?.hint }}</span>
      </label>
      <label class="grid gap-1">備註<input v-model="note" class="min-h-11 border border-line bg-surface p-2" /></label>
      <button class="min-h-11 text-accent" @click="add">新增活動</button>
    </fieldset>
    <p v-if="error" role="alert" class="text-danger">{{ error }}</p>
    <article v-for="event in events" :key="event.id" class="rounded-xl border border-line bg-panel p-4">
      <strong>{{ event.name }}</strong>
      <p>{{ event.startAt }} → {{ event.endAt }} · {{ patternLabel(event.pattern) }}</p>
      <p>
        <span v-for="(id, index) in event.stationIds" :key="id" :class="{ 'text-danger': stationUnresolved(id) }">
          <template v-if="index > 0">、</template>{{ stationLabel(id) }}
        </span>
        <span v-if="event.note"> · {{ event.note }}</span>
      </p>
      <button :disabled="!cloud.canEdit.value" class="min-h-11 text-danger" @click="remove(event.id)">刪除</button>
    </article>
  </main>
</template>
