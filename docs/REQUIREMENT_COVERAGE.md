# 命題對照矩陣

本文件把命題文件的五項交付重點，對照目前可展示的功能與誠實的完成邊界。

| 命題交付重點 | 已實作與 Demo 證據 | 對應的預期成效 | 完成狀態與邊界 |
| --- | --- | --- | --- |
| 命題連結 | 以「新北市公共自行車營運調度數據視覺化及預測模型」為產品主題；同一工作流串起即時庫存、歷史風險、告警與人工調度。 | 讓調度員更快發現空車／滿位並主動介入。 | 已完成原型；不宣稱已接入營運派車系統。 |
| 數據及資料應用 | 處理 12 份 CSV、約 1,332 萬筆、六個月站點快照；處理 UTF-8／CP950、時區、站名別名、容量差與暫不可用狀態。即時模式接新北市政府 Open Data，五分鐘比對並僅在資料變動時更新畫面。 | 易理解的站況與基於歷史的空車／滿位風險判讀。 | 已完成可重現資料產製與即時快照呈現。即時模式只呈現現況，**不**冒充未來預測。 |
| 技術架構 | Nuxt 4 前端與 Nitro `/api/v1/*` 邊界、歷史 dashboard artifact、站點／告警／調度／簡報 API；Cloudflare Pages 作為 Demo 託管。 | 可把資料來源或部署位置替換，而不重寫 UI。 | Cloudflare Demo 已可展示。AWS 的 S3、DynamoDB、Lambda、EventBridge 架構是 SAM 遷移骨架，未部署，排程預設關閉，避免產生成本。 |
| 生成式 AI 技術應用 | 簡報只使用已驗證的時間、風險、告警與調度事實，並明示調度仍要人工覆核；程式具 Amazon Bedrock `Converse` provider 與失敗時 template fallback。 | 將數值結果轉成可讀的當班摘要，同時避免幻覺影響營運決策。 | 線上 Demo 預設是可追溯的 template 摘要。**Bedrock 為可選遷移／Demo 配置，尚未部署或完成實際呼叫驗證，不能宣稱目前線上版使用 Bedrock。** |
| Live Demo | 依 [`DEMO_3MIN.md`](DEMO_3MIN.md) 展示：即時站況 → 歷史預測 → 站點判讀 → 告警 → 人工覆核調度 → 事實導向簡報。 | 完整呈現從發現、預判到介入建議的閉環。 | 已完成 Demo 流程；外部即時資料不可用時可保留最近成功快照並切至歷史情境備援。 |

## 功能到需求的可追溯性

| 功能 | 主要程式位置 | 說明 |
| --- | --- | --- |
| 官方即時站況與五分鐘比對 | `app/server/utils/live-feed.ts`、`app/pages/index.vue` | 伺服端取用官方資料，前端依發布節奏比對，資料改變才同步畫面。 |
| 新北市實景站點地圖 | `app/components/RiskMap.vue` | 以 OpenStreetMap 呈現新北市官方座標，可搜尋站名／行政區、定位異常站並回到新北全域；即時與歷史模式使用不同圖例。 |
| 歷史風險與品質規則 | `app/scripts/build-artifacts.mjs`、`app/server/data/dashboard.json` | 用站點半小時歷史型態與當前庫存計算 30／60／120 分鐘庫存失衡風險。 |
| 告警與調度建議 | `app/server/utils/ops-store.ts`、`app/pages/alerts.vue`、`app/pages/dispatch.vue` | 將持續異常與高風險轉成可由人員確認的任務。 |
| 調度影響試算 | `app/components/DispatchList.vue` | 顯示搬運前後的可借車、可還位與安全庫存檢查；明示為模擬且需人工覆核，不改寫模型預測。 |
| 受限事實摘要 | `app/server/utils/briefing.ts`、`app/aws/bedrock-narrative.ts` | 模板為預設；Bedrock adapter 不讓模型產生新的營運事實。 |
| AWS 遷移設計 | `app/infra/template.yaml`、`app/aws/README.md` | 僅是正式競賽環境的可選部署路徑，不是目前 Cloudflare Demo 的後端。 |

## 評審時應主動說明

1. 即時畫面與歷史預測有清楚模式標示，避免資料時間與預測意義混淆。
2. 調度建議是決策支援，所有確認與執行仍由人員負責。
3. AWS／Bedrock 的程式介面已預留，但沒有為了展示而宣稱不存在的雲端部署或模型推論。
