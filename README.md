# YouBike 新北調度雷達

新北市 YouBike 營運調度 Demo。它把官方即時站況、歷史風險回放、持續異常告警與人工覆核的調度建議，放在同一個 Nuxt 4 介面中。

正式 Demo：<https://hackathon2026ctrlcity.pages.dev>

## 重點功能

- 即時模式：透過同源輕量代理讀取新北市 YouBike Open Data，每五分鐘與來源更新節奏對齊；只有資料內容真的變動才提示更新。
- 歷史回放：以 30／60／120 分鐘風險、持續無車／無位／不可用告警，以及補車建議，呈現三個可切換的歷史情境。
- 新北市地圖：使用 OpenStreetMap 底圖，顯示新北市站點、風險顏色、站名／行政區搜尋與地圖定位。
- 人工覆核：告警確認、調度接受與調度影響試算都清楚標示為 Demo 操作，不會送出真實派車。

## 1102 修正

原先的 edge SSR 會解析約 10 MB 的歷史資料、篩選站點並序列化回應，可能超出 Pages Functions 的 CPU 限制。現在的資料路徑如下：

~~~
歷史 CSV（不進 Git）
  -> 離線資料產製
  -> dashboard.json
  -> build 時輸出 3 份歷史情境 JSON
  -> Cloudflare Pages 靜態 CDN

瀏覽器即時模式
  -> /api/v1/live-stations（極薄同源代理，只串流）
  -> 新北市政府 YouBike Open Data
~~~

歷史資料只會在使用者切換到「歷史回放」或開啟告警／調度／站點詳情頁時按需載入；首頁預設的即時模式不再預取歷史情境。新北市來源 API 沒有開放任意網站直接瀏覽器呼叫，因此保留一個只轉送資料、不解析 JSON 的 Pages Function。

## 成本與資源界線

- 未建立 KV、D1、R2、Vectorize、Workers AI、Queue 或任何付費資料資源。
- 靜態頁面與歷史 JSON 由 Pages CDN 提供；只有即時資料請求會碰到單一、唯讀的 Pages Function。
- AWS SAM 與 Bedrock 程式僅是未部署的遷移骨架；線上 Demo 沒有呼叫 Bedrock，也不需要 AWS 憑證。

## 本機操作

~~~
cd app
npm install
npm test
npm run data:validate
npm run typecheck
npm run build:cloudflare
~~~

build:cloudflare 會產生 app/dist：

- 純靜態 SPA、fallback 與圖資資產
- data/replay/manifest.json 與三份情境 JSON
- 僅 /api/* 進入 Pages Function 的 _routes.json

Cloudflare Pages 已透過 Git Integration 連接 main；推送後會自動建置與部署。

## 資料與文件

- 原始活動資料集：docs/資料集/，已由 .gitignore 排除，絕不提交。
- 已產製的展示用資料：app/server/data/dashboard.json，僅用於本機建置時產生靜態情境檔。
- [需求對照](docs/REQUIREMENT_COVERAGE.md)
- [三分鐘展示講稿](docs/DEMO_3MIN.md)
- [上台檢查清單](docs/PITCH_CHECKLIST.md)
- [靜態部署與 1102 修正說明](docs/STATIC_RUNTIME.md)

即時資料來源為[新北市政府 YouBike 資料集](https://data.ntpc.gov.tw/datasets/010E5B15-3823-4B20-B401-B1CF000550C5)，地圖使用 [OpenStreetMap](https://www.openstreetmap.org/) 與 [Leaflet](https://leafletjs.com/)。
