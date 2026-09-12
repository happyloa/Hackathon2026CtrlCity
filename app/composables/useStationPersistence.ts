import { freshPersistence, type PersistenceState } from '~/shared/station-persistence'

export function useStationPersistence() {
  const path = String(useRuntimeConfig().public.persistencePath || '')
  const state = useState<PersistenceState | null>('station-persistence', () => null)
  async function refresh() {
    if (!path) { state.value = null; return }
    try { state.value = freshPersistence(await $fetch(path, { cache: 'no-store', timeout: 10_000, retry: 0 })) }
    catch { state.value = null }
  }
  function lookup(id: string) { return freshPersistence(state.value)?.stations[id] ?? null }
  return { state, refresh, lookup }
}
