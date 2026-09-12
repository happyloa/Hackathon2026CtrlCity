/**
 * AWS builds must not even access window.localStorage (which may be blocked)
 * for anything *derived* from the feed: a stale local copy would quietly
 * disagree with what the scheduler publishes, which is exactly the bug the
 * server-side persistence file was introduced to remove.
 *
 * `authored: true` opts one store back in. Content the operator typed
 * themselves -- manual dispatch routes -- is not derived from anything, has no
 * server copy to fall back to, and is simply lost on reload if it cannot be
 * written anywhere. For that category localStorage is the correct home on every
 * deployment, and a browser that blocks it degrades to session-only editing
 * rather than losing the page.
 */
export function createBrowserStorage(mode: string, storage: () => Storage, { authored = false } = {}) {
  const blocked = mode === 'aws' && !authored
  return {
    getItem(key: string): string | null {
      if (blocked) return null
      try { return storage().getItem(key) } catch { return null }
    },
    setItem(key: string, value: string) {
      if (blocked) return
      try { storage().setItem(key, value) } catch { /* session state remains available */ }
    },
  }
}
