/**
 * Single source of truth for every tunable operational parameter in the
 * dashboard: safety stock, dispatch vehicle limits, alert thresholds, nearby
 * search radii, etc. Both browser code (`.ts`/`.vue`) and the Node-only
 * offline pipeline (`scripts/export-replay-static.mjs`) import this file, so
 * it must stay plain JS with no Nuxt/Vue/DOM dependency -- see
 * `parameters.d.mts` for the accompanying types.
 *
 * Changing a value here changes the live app and the next offline rebuild.
 * It does not retrain any model or rewrite already-published artifacts.
 *
 * 本檔案是整個儀表板可調參數的單一來源：安全庫存、調度車輛限制、告警門檻、
 * 鄰近搜尋半徑等。瀏覽器端程式碼（`.ts`/`.vue`）與純 Node 的離線建置流程
 * （`scripts/export-replay-static.mjs`）都會匯入這個檔案，因此必須維持純
 * JavaScript、不依賴 Nuxt/Vue/DOM——對應型別請見 `parameters.d.mts`。
 *
 * 修改這裡的數值會同時影響正式站台與下一次離線重建，但不會重新訓練模型，
 * 也不會改寫已經發布出去的產出檔案。
 */

/**
 * Applies to both the live dispatch planner and the multi-stop route planner.
 * 同時套用於即時調度規劃與多站路線規劃。
 */
export const SAFETY_STOCK_POLICY = Object.freeze({
  /**
   * Share of a station's total docks reserved as safety stock.
   * 依站點總車位比例保留的安全庫存。
   */
  ratio: 0.15,
  /**
   * Floor on the reserved amount, regardless of station size.
   * 不論站點大小都要保留的最低安全庫存量。
   */
  minimum: 3,
})

/**
 * The pipeline-wide "is this station running low?" definition -- what counts
 * as `low_bikes`/`low_docks` (and, before a station hits exactly zero, what
 * the rule-baseline model treats as empty/full-adjacent). It feeds:
 *   - the live rule-baseline risk profile (`useLiveRiskProfiles.ts`), shown on
 *     the dashboard for every station not in `ml/`'s hybrid-deployment
 *     XGBoost routing;
 *   - historical replay/profile builds (`scripts/build-artifacts.mjs`,
 *     `scripts/station-time-profile.mjs`);
 *   - baseline F1 evaluation (`scripts/evaluate-forecast.mjs`), which in turn
 *     decides `station-risk-evaluation.json`'s baseline-vs-XGBoost routing;
 *   - the XGBoost model's own `neighbor_low_bikes_rate` training feature and
 *     training sample weights (`ml/src/features.py`), which hardcodes this
 *     same ratio/floor directly in SQL because Python cannot import this file.
 *
 * Changing this value here only updates the Node/TS side. `ml/src/features.py`
 * (and thus the trained model) will silently disagree with it until someone
 * updates that file's hardcoded `GREATEST(2, CEIL(total_docks * 0.1))` to
 * match and reruns the full training pipeline: `ml/src/train.py` -> export ->
 * `npm run data:build` (regenerates the historical baseline + F1 routing) ->
 * `npm run predict:xgboost`. Until that happens, the rule baseline everywhere
 * below is internally consistent with the new value, but the XGBoost model's
 * neighbour-rate feature and routing decision still reflect the old one.
 *
 * 整條管線共用的「這站是不是快沒車/位了」定義——也就是 `low_bikes`/`low_docks`
 * 的判定門檻（在真的歸零之前，規則基準模型也用它來判斷接近空/滿）。用到它的地方：
 *   - 即時規則基準風險等級（`useLiveRiskProfiles.ts`），也就是首頁上所有「未被
 *     `ml/` 混合部署路由到 XGBoost」站點顯示的風險；
 *   - 歷史回放／統計建置（`scripts/build-artifacts.mjs`、
 *     `scripts/station-time-profile.mjs`）；
 *   - 規則基準 F1 評估（`scripts/evaluate-forecast.mjs`），會進一步決定
 *     `station-risk-evaluation.json` 的基準／XGBoost 路由結果；
 *   - XGBoost 模型自己的 `neighbor_low_bikes_rate` 訓練特徵與訓練樣本權重
 *     （`ml/src/features.py`）——那邊是直接把同一組比例／下限寫死在 SQL 裡，
 *     因為 Python 無法匯入這個檔案。
 *
 * 只改這裡只會更新 Node/TS 端。`ml/src/features.py`（以及訓練出來的模型）
 * 在有人把該檔案寫死的 `GREATEST(2, CEIL(total_docks * 0.1))` 改成一致、
 * 並重跑完整訓練流程之前，會持續套用舊值——流程是：`ml/src/train.py` →
 * 匯出模型 → `npm run data:build`（重新產生歷史基準與 F1 路由）→
 * `npm run predict:xgboost`。在完成之前，下面所有規則基準都已經一致套用新值，
 * 但 XGBoost 模型的鄰近缺車率特徵與路由結果仍反映舊值。
 */
export const LOW_INVENTORY_POLICY = Object.freeze({
  /**
   * Share of total docks below which a station counts as low.
   * 低於此車位佔比即視為低庫存。
   */
  ratio: 0.1,
  /**
   * Floor on the low-inventory threshold, regardless of station size.
   * 不論站點大小都套用的低庫存門檻下限。
   */
  floor: 3,
})

/**
 * Governs which live alerts/dispatch suggestions `buildLiveOperations` proposes.
 * 決定 `buildLiveOperations` 會產生哪些即時告警與調度建議。
 */
export const DEFAULT_LIVE_OPERATION_POLICY = Object.freeze({
  horizon: '60',
  safetyStockRatio: SAFETY_STOCK_POLICY.ratio,
  minimumSafetyStock: SAFETY_STOCK_POLICY.minimum,
  /**
   * Smallest transfer worth dispatching a vehicle for.
   * 值得派車搬運的最小數量。
   */
  minimumTransferBikes: 1,
  /**
   * Largest single station-to-station transfer suggested per dispatch.
   * 單次調度建議中，站對站最大搬運量。
   */
  maximumTransferBikes: 8,
  /**
   * Straight-line pairing radius between a struggling station and its helper.
   * 有狀況的站點與支援站之間，可配對的直線距離上限。
   */
  maximumDistanceKm: 8,
  /**
   * Cap on alerts considered per run, to keep planning deterministic and fast.
   * 每次規劃考慮的告警數量上限，確保規劃結果穩定且快速。
   */
  maximumAlerts: 80,
  /**
   * Cap on dispatch recommendations returned per run.
   * 每次規劃回傳的調度建議數量上限。
   */
  maximumDispatches: 16,
})

/**
 * Governs `buildDispatchRoutePlans`, which turns those dispatches into vehicle routes.
 * 決定 `buildDispatchRoutePlans` 如何把調度建議組成實際車輛路線。
 */
export const DEFAULT_DISPATCH_ROUTE_POLICY = Object.freeze({
  /**
   * Bikes a single dispatch vehicle can carry at once.
   * 單一調度車輛的載運容量（單位：台）。
   */
  vehicleCapacity: 14,
  /**
   * Maximum number of dispatch tasks merged into one route.
   * 單一路線最多可合併的調度任務數。
   */
  maximumTasksPerRoute: 4,
  /**
   * Maximum distinct stops (pickup/dropoff) allowed on one route.
   * 單一路線最多可停靠的站點數（取車/放車）。
   */
  maximumStopsPerRoute: 8,
  /**
   * Total straight-line distance budget for one route.
   * 單一路線的直線距離總預算。
   */
  maximumRouteDistanceKm: 20,
  /**
   * How close an additional task's stations must be to an existing route to be merged in.
   * 新任務的站點需與現有路線多近才能被合併進去。
   */
  maximumAdjacentTaskDistanceKm: 2.5,
  /**
   * How much a later, lower-priority stop may still jump ahead of an earlier one.
   * 較低優先分數的任務仍可插隊到較前順位的容忍幅度。
   */
  priorityOrderTolerance: 8,
  safetyStockRatio: SAFETY_STOCK_POLICY.ratio,
  minimumSafetyStock: SAFETY_STOCK_POLICY.minimum,
})

/**
 * Alert list UI buckets (`AlertList.vue`), scored 0-100 by `scoreAlertPriority`.
 * 告警清單 UI 分級門檻（`AlertList.vue`），對應 `scoreAlertPriority` 產出的 0-100 分數。
 */
export const ALERT_PRIORITY_THRESHOLDS = Object.freeze({
  immediate: 55,
  high: 30,
})

/**
 * Below this many available bikes a station is "near empty" regardless of its size.
 * 可借車數低於此值時，無論站點大小都視為「接近無車」。
 */
export const NEAR_EMPTY_BIKES = 2

/**
 * Risk score (0-1) above which the XGBoost-overridden forecast raises an alert.
 * 風險分數（0-1）超過此門檻時，XGBoost 覆蓋後的預測會觸發告警。
 */
export const XGBOOST_ALERT_THRESHOLD = 0.5

/**
 * Straight-line clustering/search radii used across the map and station-detail views.
 * 地圖與站點詳情頁共用的直線分群／搜尋半徑。
 */
export const NEARBY_STATION_RADII_METERS = Object.freeze({
  /**
   * Distance within which two stations are merged into one "neighbour group" pin.
   * 兩站點距離在此範圍內時，會合併成同一個「鄰近群」圖釘。
   */
  neighbourGroup: 500,
  /**
   * Search radius for suggesting an alternate station to borrow from / return to.
   * 建議替代借車／還車站點時使用的搜尋半徑。
   */
  alternateStationSearch: 600,
})

/**
 * Max alternate stations shown per direction (borrow/return) in station detail.
 * 站點詳情頁每個方向（借車／還車）最多顯示的替代站點數。
 */
export const ALTERNATE_STATION_SUGGESTION_LIMIT = 3

/**
 * District legend tone breakpoints, as a share of stations currently needing attention.
 * 行政區圖例燈號的門檻，以目前需要關注的站點佔比計算。
 */
export const DISTRICT_ATTENTION_RATE_THRESHOLDS = Object.freeze({
  low: 0.1,
  medium: 0.25,
})

/**
 * Share of total docks that must be bikes (or docks) for a station to read as lopsided.
 * 判定站點庫存「失衡」（偏車或偏車位）所需的總車位佔比門檻。
 */
export const STABLE_INVENTORY_TONE_RATIO = 2 / 3

/**
 * Used only by `scripts/predict-xgboost.mjs`'s one-shot inference demo.
 * `lowInventoryRatio`/`lowInventoryFloor` mirror `LOW_INVENTORY_POLICY` above
 * (same pipeline-wide definition, reused here so the neighbour-rate feature
 * computed at inference time stays in step with the rest of the Node/TS side).
 *
 * 僅供 `scripts/predict-xgboost.mjs` 的單次推論流程使用。`lowInventoryRatio`／
 * `lowInventoryFloor` 直接沿用上面的 `LOW_INVENTORY_POLICY`（同一套管線共用定義），
 * 確保推論時計算的鄰近缺車率特徵，跟其餘 Node/TS 端保持一致。
 */
export const XGBOOST_PREDICTION_POLICY = Object.freeze({
  /**
   * Straight-line radius used to compute a station's neighbour low-inventory rate feature.
   * 計算「鄰近站點缺車率」特徵時使用的直線搜尋半徑。
   */
  neighborRadiusMeters: 300,
  lowInventoryRatio: LOW_INVENTORY_POLICY.ratio,
  lowInventoryFloor: LOW_INVENTORY_POLICY.floor,
  /**
   * Baseline 60-minute F1 score at/below which a station is routed to XGBoost
   * instead of the rule baseline, per the validated hybrid deployment strategy.
   * 規則基準模型 60 分鐘 F1 分數低於等於此值時，該站改路由至 XGBoost，
   * 依照已驗證過的混合部署策略。
   */
  baselineF1RoutingThreshold: 0.6,
})
