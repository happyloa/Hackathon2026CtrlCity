# App

Nuxt 4 的靜態 SPA。正式 Pages 產物放在 dist，歷史回放是靜態 JSON；只有新北即時資料保留一條極薄的 Pages Function 代理。

~~~
npm install
npm run dev
npm test
npm run data:validate
npm run impact:evaluate
npm run typecheck
npm run build:cloudflare
~~~

build:cloudflare 會先以 nuxi generate 產出 SPA，再把內容 stage 至 dist，並產生：

- dist/data/replay/manifest.json
- 三份正規化的歷史 DashboardArtifact 情境與按半小時分片的 live profile
- 即時告警／雙向搬運建議由瀏覽器純函式產生，不需要資料庫或額外雲端服務
- dist/_routes.json，只允許 /api/* 觸發 Function

不要把 docs/資料集/ 或建置產物加入 Git。
