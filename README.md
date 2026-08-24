# CtrlCity｜新北市 YouBike 營運工作台

以新北市官方即時站況對照主辦方六個月歷史資料，產生 60 分鐘空／滿站風險、可解釋優先分數與多站搬運路線。公開 Demo：<https://hackathon2026ctrlcity.pages.dev>

## Demo 主線

- 即時分析：每 5 分鐘檢查官方資料，也可手動更新；來源失敗時不以歷史資料冒充即時資料。
- 站況預判：把即時庫存與同站歷史基線比對，找出未來 60 分鐘的缺車／缺位風險。
- 站點總覽：依行政區查看全部狀態；定位判斷不明時顯示全新北市。
- 地圖判讀：標示 300 公尺風險群，以及穩定站偏車多、偏空位多的情況。
- 路線規劃：風險決定先後、庫存決定搬多少，再以距離和 12 台車輛容量整合鄰近需求。

歷史資料只用於基線與離線驗證。平台不建立工單，也不送出派車命令。

## 本機執行

```powershell
cd app
npm install
npm run dev
```

完整驗證：

```powershell
npm test
npm run data:validate
npm run impact:evaluate
npm run typecheck
npm run build
```

`npm run build:cloudflare` 會輸出 `app/dist/`，供 Cloudflare Pages 的 Git Integration 部署。前端與精簡歷史基線皆為靜態產物；只有 `/api/v1/live-stations` 經過唯讀代理，因此不會把大型資料或 Nuxt server bundle 送進 Pages Functions。

## AWS 正式環境

程式已備妥私有 S3、CloudFront、HTTP API／Lambda、選配 AgentCore Harness 與獨立知識文件 bucket。預設不建立知識來源、不啟用 Agent，也不會在本機驗證時建立任何 AWS 資源。

正式帳號到手後，先依 [AWS 技術交接](app/aws/README.md)執行 preflight，再部署、發布與 smoke test。帳號、region、核准模型與 Harness／Knowledge Base 權限尚未確認前，不應執行部署。

## 資料與文件

- `docs/資料集/` 約 1.1 GB，只保留本機且已由 `.gitignore` 排除；不會進入 Git、瀏覽器 bundle 或知識庫。
- [文件索引](docs/文件索引.md)
- [命題需求對照](docs/03_實作與驗證/命題需求對照.md)
- [預測與資料方法](docs/03_實作與驗證/預測與資料方法.md)
- [操作使用說明](docs/04_展示與交付/操作使用說明.md)
- [三分鐘展示講稿](docs/04_展示與交付/三分鐘展示講稿.md)
- [AWS 正式環境交接](docs/03_實作與驗證/AWS正式環境交接.md)

即時資料來源為[新北市政府 YouBike 公開資料](https://data.ntpc.gov.tw/datasets/010E5B15-3823-4B20-B401-B1CF000550C5)，底圖使用 [OpenStreetMap](https://www.openstreetmap.org/) 與 [Leaflet](https://leafletjs.com/)。
