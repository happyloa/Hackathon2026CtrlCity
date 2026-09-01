/**
 * Reads the static snapshot written by `npm run predict:xgboost`
 * (app/public/data/xgboost/live-predictions.json). It is NOT live -- it only
 * reflects whatever the last manual run captured -- because the full
 * XGBoost models (80-134MB once station_id's category list is included) are
 * far past Cloudflare Pages' 25MiB per-asset cap and can't run in the
 * browser. See docs/PoC交接.md's "即時 XGBoost 缺車/滿車警報" section.
 */
export interface XgboostHorizonPrediction {
  riskScore: number
  condition: 'empty' | 'full'
  predictedBikes: number
  predictedDocks: number
  gapBikes: number
  gapDocks: number
}

export interface XgboostStationPrediction {
  name: string
  district: string
  horizons: { '30'?: XgboostHorizonPrediction; '60'?: XgboostHorizonPrediction }
}

interface XgboostPredictionsPayload {
  generatedAt: string
  method: { model: string; routing: string; caveat: string }
  stations: Record<string, XgboostStationPrediction>
}

export function useXgboostPredictions() {
  const payload = useState<XgboostPredictionsPayload | null>('xgboost-predictions-payload', () => null)
  const pending = useState('xgboost-predictions-pending', () => false)
  const error = useState('xgboost-predictions-error', () => '')

  async function load() {
    if (payload.value || pending.value || !import.meta.client) return
    pending.value = true
    error.value = ''
    try {
      payload.value = await $fetch<XgboostPredictionsPayload>('/data/xgboost/live-predictions.json', { cache: 'no-store' })
    } catch {
      error.value = '找不到 XGBoost 推論結果，請先在本機執行 npm run predict:xgboost。'
    } finally {
      pending.value = false
    }
  }

  return { payload, pending, error, load }
}
