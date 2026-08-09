# 命題需求對照

範圍固定為新北市 YouBike，不擴張至台北市或全台。

| 命題重點 | Demo 對應 | 實作位置 |
| --- | --- | --- |
| 即時站況視覺化 | 新北市站點地圖、庫存數字、異常清單、行政區篩選與地圖定位。 | app/components/RiskMap.vue、app/components/LiveFeedCard.vue |
| 即時資料更新 | 頁面每五分鐘比對一次官方資料，只有資料簽章變動才提示更新。 | app/pages/index.vue |
| 官方公開資料 | 瀏覽器經同源唯讀代理取得新北市 Open Data；代理只串流，不解析或保存資料。 | app/functions/api/v1/live-stations.ts |
| 歷史資料與風險預測 | 三個歷史回放情境，含站點庫存、30／60／120 分鐘風險、趨勢圖與品質旗標；即時模式以同站歷史時段基線提供 30／60 分鐘啟發式風險指標，未對照時只顯示庫存。 | app/scripts/build-artifacts.mjs、app/scripts/export-replay-static.mjs、app/composables/useLiveRiskProfiles.ts |
| 無車／無位／服務狀態待確認 | 歷史回放顯示風險、開始時間與持續分鐘數；官方未啟用或可借、可還皆為 0 的資料標記為需人工確認，不宣稱已確認停運。 | app/components/AlertList.vue、app/components/RiskMap.vue |
| 調度決策支援 | 顯示補車／移車雙向任務、來源站、目的站、建議車數、距離、優先分數與調度前後影響試算；不是車隊路線最佳化。 | app/components/DispatchList.vue |
| 人工確認 | 確認告警與接受調度是前端 Demo 狀態，重新整理即重置，不會發出真實派車。 | app/composables/useReplayDashboard.ts |
| AI 摘要界線 | Demo 使用可追溯的 template 摘要；Bedrock adapter 僅保留為未部署遷移骨架。 | app/components/BriefingCard.vue、app/aws/ |

## 1102 修正與免費額度

歷史資料在 build 階段轉為 Pages 靜態資產，使用者切換歷史模式才載入對應情境。_routes.json 只包含 /api/*，所以首頁、地圖、回放檔與子頁都不需進入 Function。

唯一的 Function 是即時資料轉送；未建立 KV、D1、R2、Workers AI 或付費 binding。官方即時來源暫時不可用時，畫面會顯示錯誤並可切回歷史回放；最後成功的即時資料只保留於目前瀏覽器頁面。
