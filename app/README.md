# App

Nuxt 4 的靜態 SPA。正式 Pages 產物放在 dist，歷史回放是靜態 JSON；只有新北即時資料保留一條極薄的 Pages Function 代理。

~~~
npm install
npm run dev
npm test
npm run data:validate
npm run impact:evaluate
npm run typecheck
npm run build
npm run build:cloudflare
~~~

`build` 是可部署到任一靜態主機的產物流程；`build:cloudflare` 暫時保留為 Pages Git 部署的相容別名。兩者都會先以 nuxi generate 產出 SPA，再把內容 stage 至 dist，並產生：

- dist/data/replay/manifest.json
- 三份正規化的歷史 DashboardArtifact 情境與按半小時分片的 live profile
- 即時告警／雙向搬運建議由瀏覽器純函式產生，不需要資料庫或額外雲端服務
- dist/_routes.json，只允許 /api/* 觸發 Function

不要把 docs/資料集/ 或建置產物加入 Git。

## 部署邊界

目前的 Cloudflare Pages 是取得競賽專用 AWS 帳號前的暫時展示環境。`dist/` 本身是平台無關的靜態前端；Cloudflare 特有的即時資料代理位於 `functions/api/v1/live-stations.ts`。

前端以 `NUXT_PUBLIC_LIVE_STATIONS_ENDPOINT` 讀取即時資料，預設為同源 `/api/v1/live-stations`。最終 AWS Demo 可讓 CloudFront 將此路徑轉送至 API Gateway／Lambda，或在建置時改成公開 API Gateway URL；瀏覽器不保存任何 AWS 憑證。AgentCore、知識庫與 S3 的正式整合另見 `docs/03_實作與驗證/AWS AgentCore整合設計.md`。
