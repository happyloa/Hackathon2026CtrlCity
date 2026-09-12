import { createBrowserStorage } from '~/shared/browser-storage'

export function useBrowserStorage() {
  return createBrowserStorage(String(useRuntimeConfig().public.storageMode), () => window.localStorage)
}
