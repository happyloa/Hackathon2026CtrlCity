/**
 * The prediction source (rule baseline vs. XGBoost) is an analyst setting,
 * changed only on the operational ROI page (`/admin/roi`), but it needs to be
 * visible everywhere the dashboard renders alerts -- the homepage reads it to
 * decide which forecast to build alerts/dispatches from. This is a static
 * site with no backend, so the choice is persisted to `localStorage` instead
 * of a server-side setting; `useState` alone would reset to 'baseline' on
 * every full page reload.
 */
const STORAGE_KEY = 'prediction-mode'

export type PredictionMode = 'baseline' | 'xgboost'

function isPredictionMode(value: unknown): value is PredictionMode {
  return value === 'baseline' || value === 'xgboost'
}

export function usePredictionMode() {
  const browserStorage = useBrowserStorage()
  const mode = useState<PredictionMode>('prediction-mode', () => 'baseline')
  const xgboost = useXgboostPredictions()

  /**
   * Must read localStorage before the persisting watch below runs its
   * `immediate: true` pass -- that pass writes `mode.value` straight back to
   * storage, so reading it after would just observe our own default write
   * and never recover a persisted 'xgboost' choice.
   */
  if (import.meta.client) {
    const stored = browserStorage.getItem(STORAGE_KEY)
    if (isPredictionMode(stored)) mode.value = stored
  }

  watch(mode, (value) => {
    if (import.meta.client) browserStorage.setItem(STORAGE_KEY, value)
    if (value === 'xgboost') void xgboost.load()
  }, { immediate: true })

  return { mode, xgboost }
}
