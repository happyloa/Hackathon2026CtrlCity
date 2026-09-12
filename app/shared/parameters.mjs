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
   * Cap on dispatch recommendations returned per run. This is the binding
   * constraint on how many struggling stations get help: with ~100 actionable
   * alerts in an evening, a cap of 16 meant most stations that had already run
   * out never appeared in a route at all, however high they scored.
   * 每次規劃回傳的調度建議數量上限。這是「有多少站點真的被救到」的決定性限制：
   * 傍晚時段可派遣告警約 100 筆，上限 16 會讓多數「已經沒車」的站點無論分數多高
   * 都排不進任何路線。
   */
  maximumDispatches: 40,
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
 * How long a station must have been short of bikes before it outranks
 * everything below it. `scoreAlertPriority` turns these into a band floor, so
 * the ordering is structural rather than the outcome of tuning weights:
 *
 *   已缺車 >= 60 分   75-99   最優先
 *   已缺車 >= 30 分   50-74
 *   目前缺車／滿柱     25-49   (still short, but not yet 30 minutes)
 *   預測缺車／滿柱      0-24
 *
 * A predicted shortage can therefore never outrank an observed one, and an
 * hour-long shortage can never be displaced by a half-hour one. The minutes
 * are the unified 缺車 run (`NEAR_EMPTY_BIKES`), the same clock the homepage
 * 即時缺車 >=30/>=60 lists and the opening alarm read.
 *
 * 站點必須缺車多久才會壓過下一層。`scoreAlertPriority` 把這些轉成分數的樓地板，
 * 讓排序來自結構而不是權重微調：預測永遠不可能壓過已發生的缺車，半小時的缺車也
 * 永遠不可能壓過一小時的。分鐘數取自統一的缺車判定（`NEAR_EMPTY_BIKES`），與首頁
 * 「即時缺車 ≥30／≥60 分鐘」清單和開啟時的警示同一個時鐘。
 */
export const SUSTAINED_SHORTAGE_TIERS = Object.freeze([
  { minutes: 60, score: 75 },
  { minutes: 30, score: 50 },
])

/**
 * Alert list UI buckets (`AlertList.vue`), scored 0-100 by `scoreAlertPriority`.
 * Aligned with the bands above: 「立即關注」starts where a shortage has lasted
 * 30 minutes, 「高優先」where a station has already run out.
 * 告警清單 UI 分級門檻（`AlertList.vue`），對應 `scoreAlertPriority` 產出的 0-100
 * 分數，並對齊上面的分層：「立即關注」自缺車滿 30 分鐘起，「高優先」自目前已缺車起。
 */
export const ALERT_PRIORITY_THRESHOLDS = Object.freeze({
  immediate: 50,
  high: 25,
})

/**
 * Below this many available bikes a station is "near empty" regardless of its
 * size: 近端缺車, 全系統判定「缺車」的統一門檻. Compared with `<`, so this reads
 * as 低於 3 台 -- 0, 1 or 2 bikes. Everything that answers "is this station
 * short of bikes right now" must read this constant rather than restate the
 * number: the map severity (`stationSeverityFor`), its legend, and the
 * real-time persistence runs (`LIVE_SNAPSHOT_POLICY.lowBikesThreshold`). Only
 * 完全缺車 (`currentState === 'empty_now'`, exactly zero) is narrower, and it
 * answers a different question: 空站 is the extreme case of 缺車, not a synonym.
 *
 * This sat at 2 while every threshold added around it was written as 3
 * (`LOW_INVENTORY_POLICY.floor`, `SAFETY_STOCK_POLICY.minimum`,
 * `FROZEN_STATION_POLICY.stuckValueCeiling`, and `lowBikesThreshold` itself),
 * so the map coloured a strictly smaller set of stations than every list that
 * claimed the same standard. Keep them aligned.
 *
 * 可借車數低於此值時，無論站點大小都視為「近端缺車」——全系統判定「缺車」的統一
 * 門檻。比較用 `<`，所以語意是「低於 3 台」（0、1、2 台）。所有回答「這站現在是否
 * 缺車」的地方都必須引用這個常數，而不是各自寫死數字：地圖嚴重度、地圖圖例、即時
 * 持續缺車清單。只有「完全缺車」（恰好為零）比它更窄，而那是另一個問題：空站是缺車
 * 的極端情況，不是同義詞。
 *
 * 這個值原本停在 2，但後來加入的門檻全部寫成 3（`LOW_INVENTORY_POLICY.floor`、
 * `SAFETY_STOCK_POLICY.minimum`、`FROZEN_STATION_POLICY.stuckValueCeiling`，以及
 * `lowBikesThreshold` 本身），導致地圖著色的站點集合嚴格小於所有宣稱同一標準的清單。
 */
export const NEAR_EMPTY_BIKES = 3

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

/**
 * Governs the browser-side rolling snapshot buffer `useStationSnapshots.ts`
 * keeps per station -- persisted to localStorage so it survives a reload,
 * not just in memory -- and every feature built on top of it: the
 * "已持續缺車" real-time-persistence lists in `WarningPanel.vue`, the
 * momentum term in the rule-baseline forecast (`useLiveRiskProfiles.ts`), and
 * client-side frozen/stuck-station detection ("壞車"). `lowBikesThreshold` is
 * a fixed absolute bike count, unlike `LOW_INVENTORY_POLICY` above, which
 * scales with station size -- the two answer different questions ("is this
 * station's inventory low relative to its own capacity" vs. "does this
 * station realistically have close to zero usable bikes right now").
 *
 * `maxSnapshotsPerStation` is set to line up with
 * `scripts/detect-frozen-stations.mjs`'s `MIN_RUN_SLOTS = 6` (6 half-hour
 * slots = 3 hours) -- the shortest run that script treats as a real frozen
 * candidate rather than ordinary demand noise -- at the live poll cadence
 * (`useLivePolling.ts`'s 5-minute interval): 3 hours needs 36 five-minute
 * snapshots. `localStorageRetentionHours` is kept wider than that active
 * window (double it) so a tab reopened partway through still has a full
 * 3-hour run available once stale entries are trimmed, rather than having to
 * rebuild the whole window from scratch.
 *
 * 管理 `useStationSnapshots.ts` 幫每個站點保留的瀏覽器端捲動快照緩衝——會寫入
 * localStorage，重新整理頁面也不會消失，不只是留在記憶體——以及建立在其上的所有
 * 功能：`WarningPanel.vue` 的「已持續缺車」即時清單、規則基準預測裡的動量項
 * （`useLiveRiskProfiles.ts`），以及瀏覽器端的壞車／卡住站點偵測（「壞車」）。
 * `lowBikesThreshold` 是固定的絕對可借車數，跟上面會隨站點大小縮放的
 * `LOW_INVENTORY_POLICY` 不同——兩者回答的問題不一樣（「這站庫存相對自己容量是否
 * 偏低」vs.「這站現在是否幾乎沒車可借」）。
 *
 * `maxSnapshotsPerStation` 對齊 `scripts/detect-frozen-stations.mjs` 的
 * `MIN_RUN_SLOTS = 6`（6 個半小時格 = 3 小時）——那是該腳本認定「值得通報的凍結」
 * 而非一般需求雜訊的最短長度——換算成即時輪詢頻率（`useLivePolling.ts` 的 5 分鐘
 * 一次）：3 小時需要 36 筆 5 分鐘快照。`localStorageRetentionHours` 刻意設得比這個
 * 有效視窗更寬（兩倍），這樣中途重新打開分頁時，捨棄過期快照後仍有完整的 3 小時
 * 資料可用，不必從頭重新累積整個視窗。
 */
export const LIVE_SNAPSHOT_POLICY = Object.freeze({
  /**
   * Max snapshots retained per station in the persisted buffer.
   * 持久化緩衝中，每個站點保留的最大快照筆數。
   */
  maxSnapshotsPerStation: 36,
  /**
   * How long a persisted snapshot survives in localStorage before being discarded.
   * 快照在 localStorage 中保留多久後會被捨棄。
   */
  localStorageRetentionHours: 6,
  /**
   * Absolute available-bikes count below which a station counts as "real-time
   * low". Deliberately the same constant the map colours by: this list and the
   * map answered the same question with different numbers (< 3 vs < 2), so the
   * homepage reported far more 缺車 stations than the map ever showed. The
   * value is unchanged -- 3 was always right here; the map's 2 was the stale one.
   * 即時可借車數低於此值即視為「近端缺車」。刻意與地圖著色共用同一個常數：兩者
   * 原本用不同的數字（< 3 與 < 2）回答同一個問題，導致首頁清單的缺車站數遠多於
   * 地圖顯示的數量。數值本身沒有變——這裡一直是 3，漏改的是地圖那邊的 2。
   */
  lowBikesThreshold: NEAR_EMPTY_BIKES,
})

/**
 * Governs `useFrozenStations.ts`'s live "站點連續停滯" detection, shown both
 * in the homepage's frozen-station panel and as a filter on the station
 * overview list. Originally mirrored `scripts/detect-frozen-stations.mjs`'s
 * `MIN_RUN_SLOTS = 6` (6 half-hour slots = 3 hours) and its exactly-0 check;
 * both have since been deliberately loosened for this live-monitoring use
 * case, on top of (not a change to) that offline EDA script, which keeps its
 * own stricter definition for historical batch analysis:
 *   - `minRunMinutes` shortened to 2 hours -- long enough to rule out a
 *     normal brief lull, short enough to flag a stuck station same-day
 *     instead of waiting a full 3 hours.
 *   - `stuckValueCeiling` widened from "stuck at exactly 0" to "stuck at any
 *     single reading from 0 through this ceiling" -- a sensor stuck
 *     reporting "2 bikes" for hours is just as suspicious as one stuck at 0,
 *     especially at a station with many docks.
 * A station still needs the OTHER metric to stay positive throughout, same
 * as the offline script: a station stuck at 0 bikes AND 0 docks is a total
 * outage, already covered by `serviceStatus`/`currentState`, not this.
 *
 * 管理 `useFrozenStations.ts` 的即時「站點連續停滯」偵測，同時用在首頁的壞車面板，
 * 以及站點總覽清單的篩選項。原本對齊 `scripts/detect-frozen-stations.mjs` 的
 * `MIN_RUN_SLOTS = 6`（6 個半小時格＝3 小時）與其「剛好等於 0」的判斷；這兩點都
 * 已針對即時監看這個使用情境刻意放寬——是疊加在那支離線 EDA 腳本之上，不是改動它，
 * 它自己歷史批次分析仍維持原本較嚴格的定義：
 *   - `minRunMinutes` 縮短為 2 小時——夠長到排除一般短暫的需求空檔，也夠短能在
 *     當天就標記出卡住的站點，不用等滿 3 小時。
 *   - `stuckValueCeiling` 從「剛好卡在 0」放寬為「卡在 0 到這個上限之間的任一個
 *     固定讀數」——感測器卡在回報「2 台車」跟卡在 0 一樣可疑，尤其是車柱數很多的
 *     站點。
 * 跟離線腳本一樣，另一項指標仍必須全程維持大於 0：一個可借車與可還位都卡在 0 的
 * 站點是整站中斷，已經由 `serviceStatus`／`currentState` 涵蓋，不屬於這裡要抓的情況。
 */
export const FROZEN_STATION_POLICY = Object.freeze({
  /**
   * Minimum unbroken run length, in minutes, before a stuck metric counts as frozen.
   * 判定為「疑似凍結」前，該指標卡住不變所需的最短連續分鐘數。
   */
  minRunMinutes: 120,
  /**
   * A metric stuck at any single reading from 0 through this ceiling counts as frozen.
   * 指標卡在 0 到這個上限之間的任一個固定讀數，即視為凍結。
   */
  stuckValueCeiling: 3,
})
