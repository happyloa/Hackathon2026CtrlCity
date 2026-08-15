# 靜態執行架構與 1102 修正

## 問題

Cloudflare 1102 代表 Function 超出執行資源限制。原本的首頁 SSR 與歷史 API 會在 edge 上載入並處理約 10 MB 的歷史 artifact，再重建與序列化站點資料；這不適合免費 Pages Functions 的短 CPU 預算。

## 解法

build:cloudflare 現在執行以下步驟：

1. nuxi generate 產生 Nuxt SPA；產製腳本將 Nuxt 的 404 fallback 改為靜態 SPA fallback，支援直接開啟站點網址。
2. scripts/stage-pages-static.mjs 在一般靜態模式將 .output/public 複製到 dist；Cloudflare Pages 的 cloudflare-pages-static preset 則直接產出 dist，腳本會保留該產物。
3. scripts/export-replay-static.mjs 讀取已產製的 server/data/dashboard.json，同時輸出三份正規化回放情境至 dist/data/replay/，以及 manifest 與 48 份半小時歷史基線 shard 至 dist/data/live-profile/。
4. dist/_routes.json 只讓 /api/* 進入 Pages Functions。

歷史模式由瀏覽器按需抓取靜態情境 JSON；首頁的即時模式不下載完整情境，只讀取 manifest 與 30／60 分鐘所需的 profile shard，並在瀏覽器端結合同站即時庫存計算啟發式風險指標。

## 即時資料

functions/api/v1/live-stations.ts 唯讀串流新北市官方 API 回應。它不呼叫 response.json、不迭代站點，也不保存任何資料；站點欄位轉換、基線對照、風險計算與畫面差異判斷都在瀏覽器端完成。靜態基線檔同樣由 CDN 提供，不經過 Function。

## 成本與限制

- 靜態檔可由 Pages CDN 提供。
- 唯一的 Function 是即時資料代理。
- 不建立 KV、D1、R2、Queue、Workers AI 或 Bedrock runtime。
- Demo 的告警確認與調度接受只保留在目前瀏覽器工作階段，重新整理會重置。

這個架構適合競賽展示。正式營運版仍應增加可稽核的資料儲存、權限、調度工作流與監控。
