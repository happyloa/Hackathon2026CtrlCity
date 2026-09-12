import { createBrowserStorage } from '~/shared/browser-storage'

/** Pass `{ authored: true }` for content the operator typed, not data derived from the feed. */
export function useBrowserStorage(options: { authored?: boolean } = {}) {
  return createBrowserStorage(String(useRuntimeConfig().public.storageMode), () => window.localStorage, options)
}
