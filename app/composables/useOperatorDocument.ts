import { OperatorDocumentClient } from '~/shared/operator-client'

const clients = new Map<string, OperatorDocumentClient<unknown>>()

export function useOperatorDocument<T>(endpoint: string, parse: (raw: unknown) => T, getValue: () => T, setValue: (value: T) => void, envelope: (value: T) => unknown) {
  const auth = useDispatcherAuth()
  const remote = Boolean(endpoint) || useRuntimeConfig().public.storageMode === 'aws'
  const status = useState<string>(`operator-status:${endpoint}`, () => remote && !endpoint ? '此 AWS 部署尚未啟用雲端編輯，請先開啟調度登入功能。' : '')
  const pending = useState(`operator-pending:${endpoint}`, () => false)
  const ready = useState(`operator-ready:${endpoint}`, () => false)
  const dirty = useState(`operator-dirty:${endpoint}`, () => false)
  const conflict = useState(`operator-conflict:${endpoint}`, () => false)
  const canEdit = computed(() => !remote || (ready.value && Boolean(auth.accessToken.value) && !pending.value && !conflict.value))
  if (endpoint && !clients.has(endpoint)) clients.set(endpoint, new OperatorDocumentClient(endpoint, parse))
  const client = clients.get(endpoint) as OperatorDocumentClient<T> | undefined
  const draftKey = `operator-draft:${endpoint}`
  function markDirty() {
    dirty.value = true
    status.value = '尚有未儲存的變更'
    // A separate draft never replaces a successfully loaded cloud document automatically.
    try { sessionStorage.setItem(draftKey, JSON.stringify({ value: getValue(), etag: client?.etag })) } catch { /* memory draft remains */ }
  }
  async function reload() {
    if (!client || pending.value) return
    pending.value = true
    try {
      setValue(await client.load()); ready.value = true; dirty.value = false; conflict.value = false
      status.value = '已載入雲端資料'
    } catch (error) { ready.value = false; status.value = (error as Error).message }
    finally { pending.value = false }
  }
  function restoreDraft() {
    if (!canEdit.value || !client) return
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null')
      if (!draft) { status.value = '沒有可還原的草稿'; return }
      if (draft.etag !== client.etag) { status.value = '草稿版本與雲端不同，請依最新資料重新編輯。'; return }
      setValue(parse(envelope(draft.value))); markDirty()
    } catch { status.value = '無法還原草稿' }
  }
  async function save() {
    if (!client || pending.value) return
    pending.value = true
    try {
      await client.save(envelope(getValue()), auth.accessToken.value)
      dirty.value = false; status.value = '已儲存到雲端'
      try { sessionStorage.removeItem(draftKey) } catch { /* optional draft cleanup */ }
    } catch (error) { conflict.value = client.conflicted; status.value = (error as Error).message }
    finally { pending.value = false }
  }
  return { remote, status, pending, ready, dirty, canEdit, reload, save, markDirty, restoreDraft, ...auth }
}
