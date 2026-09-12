<script setup lang="ts">
const { events, cloud, replace } = useDemandEvents()
const name = ref('')
const stationIds = ref('')
const startAt = ref('')
const endAt = ref('')
const note = ref('')
const error = ref('')
function add() {
  try {
    replace({ events: [...events.value, { id: crypto.randomUUID(), name: name.value, stationIds: stationIds.value.split(',').map(id => id.trim()).filter(Boolean), startAt: startAt.value, endAt: endAt.value, note: note.value }] })
    error.value = ''; name.value = ''; note.value = ''
  } catch (cause) { error.value = (cause as Error).message }
}
function remove(id: string) { replace({ events: events.value.filter(event => event.id !== id) }) }
</script>
<template>
  <main class="mx-auto max-w-screen-lg space-y-4 p-6 text-body1">
    <h1 class="text-h5 font-bold">活動管理</h1>
    <NuxtLink to="/admin/adjustments" class="text-accent">營運排除窗</NuxtLink>
    <p>記錄活動名稱、影響站點與台北時間。活動紀錄供調度人員參考。</p>
    <p role="status">{{ cloud.status.value }}</p>
    <p v-if="cloud.authError.value" role="alert">{{ cloud.authError.value }}</p>
    <div v-if="cloud.remote" class="flex flex-wrap gap-3">
      <button v-if="!cloud.accessToken.value" class="min-h-11 text-accent" @click="cloud.signIn">登入後可編輯</button>
      <button v-else class="min-h-11 text-accent" @click="cloud.signOut">登出</button>
      <button :disabled="cloud.pending.value" class="min-h-11 text-accent" @click="cloud.reload">重新載入雲端清單</button>
      <button :disabled="!cloud.canEdit.value || !cloud.dirty.value" class="min-h-11 text-accent" @click="cloud.save">儲存到雲端</button>
      <button :disabled="!cloud.canEdit.value" class="min-h-11 text-accent" @click="cloud.restoreDraft">還原本分頁草稿</button>
    </div>
    <fieldset :disabled="!cloud.canEdit.value" class="grid gap-3 rounded-xl border border-line bg-panel p-4">
      <label class="grid gap-1">活動名稱<input v-model="name" class="min-h-11 border border-line bg-surface p-2" /></label>
      <label class="grid gap-1">影響站點 ID（以逗號分隔）<input v-model="stationIds" class="min-h-11 border border-line bg-surface p-2" /></label>
      <label class="grid gap-1">開始時間<input v-model="startAt" type="datetime-local" class="min-h-11 border border-line bg-surface p-2" /></label>
      <label class="grid gap-1">結束時間<input v-model="endAt" type="datetime-local" class="min-h-11 border border-line bg-surface p-2" /></label>
      <label class="grid gap-1">備註<input v-model="note" class="min-h-11 border border-line bg-surface p-2" /></label>
      <button class="min-h-11 text-accent" @click="add">新增活動</button>
    </fieldset>
    <p v-if="error" role="alert" class="text-danger">{{ error }}</p>
    <article v-for="event in events" :key="event.id" class="rounded-xl border border-line bg-panel p-4">
      <strong>{{ event.name }}</strong>
      <p>{{ event.startAt }} → {{ event.endAt }}</p>
      <p>{{ event.stationIds.join('、') }} · {{ event.note }}</p>
      <button :disabled="!cloud.canEdit.value" class="min-h-11 text-danger" @click="remove(event.id)">刪除</button>
    </article>
  </main>
</template>
