import { freshPersistence, type PersistenceState } from '~/shared/station-persistence'

export function useStationPersistence() {
  const path = String(useRuntimeConfig().public.persistencePath || '')
  const state = useState<PersistenceState | null>('station-persistence', () => null)
  async function refresh() {
    if (!path) { state.value = null; return }
    try { state.value = freshPersistence(await $fetch(path, { cache: 'no-store', timeout: 10_000, retry: 0 })) }
    catch { state.value = null }
  }
  // Validated once per poll rather than once per station: `lookup` runs for
  // every one of ~1,600 stations on each render, and re-validating the whole
  // document each time scanned it 1,600 times over.
  const fresh = computed(() => freshPersistence(state.value))
  function lookup(id: string) { return fresh.value?.stations[id] ?? null }
  return { state, fresh, refresh, lookup }
}
