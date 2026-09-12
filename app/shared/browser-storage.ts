/** AWS builds must not even access window.localStorage (which may be blocked). */
export function createBrowserStorage(mode: string, storage: () => Storage) {
  return {
    getItem(key: string): string | null {
      if (mode === 'aws') return null
      try { return storage().getItem(key) } catch { return null }
    },
    setItem(key: string, value: string) {
      if (mode === 'aws') return
      try { storage().setItem(key, value) } catch { /* session state remains available */ }
    },
  }
}
