import { parseDemandEventsFile, type DemandEvent } from '~/shared/demand-events.mjs'

export function useDemandEvents() {
  const browserStorage = useBrowserStorage()
  const events = useState<DemandEvent[]>('demand-events', () => [])
  const endpoint = String(useRuntimeConfig().public.eventsEndpoint || '')
  const cloud = useOperatorDocument(endpoint, parseDemandEventsFile, () => events.value, value => { events.value = value }, value => ({ schemaVersion: '1.0', events: value }))
  onMounted(() => {
    if (cloud.remote) { if (!cloud.ready.value) void cloud.reload(); return }
    try { events.value = parseDemandEventsFile(JSON.parse(browserStorage.getItem('demand-events:v1') || '{"events":[]}')) } catch { /* start empty */ }
  })
  function replace(raw: unknown) {
    if (!cloud.canEdit.value) throw new Error('登入後可編輯')
    events.value = parseDemandEventsFile(raw)
    if (cloud.remote) cloud.markDirty()
    else { try { browserStorage.setItem('demand-events:v1', JSON.stringify({ events: events.value })) } catch { /* session edits remain */ } }
  }
  return { events, cloud, replace }
}
