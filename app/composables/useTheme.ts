/**
 * Dark is the operational default (night-shift dispatch, screens lit for
 * hours), with a light theme available for bright offices. This is a static
 * site with no backend, so the choice is persisted to `localStorage` instead
 * of a server-side setting; `useState` alone would reset to 'dark' on every
 * full page reload.
 */
const STORAGE_KEY = 'theme'

export type Theme = 'dark' | 'light'

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

export function useTheme() {
  const browserStorage = useBrowserStorage()
  const theme = useState<Theme>('theme', () => 'dark')

  /**
   * Must read localStorage before the persisting watch below runs its
   * `immediate: true` pass -- that pass writes `theme.value` straight back to
   * storage, so reading it after would just observe our own default write
   * and never recover a persisted 'light' choice.
   */
  if (import.meta.client) {
    const stored = browserStorage.getItem(STORAGE_KEY)
    if (isTheme(stored)) theme.value = stored
  }

  watch(theme, (value) => {
    if (import.meta.client) {
      browserStorage.setItem(STORAGE_KEY, value)
      document.documentElement.dataset.theme = value
    }
  }, { immediate: true })

  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, toggle }
}
