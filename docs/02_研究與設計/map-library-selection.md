# 地圖套件選型研究：Leaflet vs MapLibre GL JS vs OpenLayers

> **與目前 Demo 的關係**：本專案目前使用 leaflet 1.9.4，兩張地圖（`RiskMap.vue`、`RoiMap.client.vue`）都掛 `tile.openstreetmap.org` 這個只有淺色的 raster tile，再用 CSS `filter: brightness(0.66) saturate(0.58)` 硬壓成偏暗。本文查證「免金鑰深色底圖」的可行路徑，以及換套件的實際成本，**不做選型結論**。

**研究日期：** 2026-09-05（所有版本號與線上端點探測皆為當日 UTC 實測）
**研究範圍：** 免金鑰深色底圖（raster / vector 兩條路）、三個地圖套件的 bundle size 實測、1600 點互動圓點的等價寫法與效能、明暗主題切換的執行期 API 成本、Nuxt 4 靜態生成整合、授權現況。
**方法：** 一手來源優先——(1) 官方文件與官方 GitHub repo；(2) tile provider 的 usage policy 原文；(3) npm registry 與 jsDelivr 的實際檔案（bundle size 由本機下載後 `gzip -9` 實測，非引用二手數字）；(4) 對候選 tile 端點直接發 HTTP 請求驗證回應。凡只找得到二手來源（部落格、Medium、教學文）的說法，一律於文中標為「僅二手來源，待驗」。

---

## 0. 專案現況的實際程式碼盤點

先把後面成本估算的基準攤開（`app/` 為 Nuxt 專案根）：

| 項目 | 現況 |
|---|---|
| `app/nuxt.config.ts` | **`ssr: false`**（純 SPA），`css: ['leaflet/dist/leaflet.css', '~/assets/css/main.css']` |
| `app/package.json` | `leaflet: ^1.9.4`、`@types/leaflet: ^1.9.22`、`nuxt: 4.5.2`、`vue: ^3.5.40`、`tailwindcss: 4.3.3` |
| `app/components/RiskMap.vue` | 587 行。`leaflet.map(..., { preferCanvas: true })`、`leaflet.canvas()` 兩個 renderer（一般 + `risk-hotspots` 自訂 pane）、`circleMarker` 逐站建立並以 `markerById` 快取、`bindTooltip({ sticky: true })`、`marker.on('click')`、`leaflet.circle(..., { radius: cluster.radiusMeters })` 畫**以公尺為半徑**的鄰近熱區、`fitBounds`、`panTo`、`ResizeObserver → invalidateSize` |
| `app/components/RoiMap.client.vue` | 176 行。每次 `render()` 都 `markerLayer.clearLayers()` 後全量重建 `circleMarker`，同樣有 tooltip 與 click |
| `app/assets/css/main.css` | 約 45 行以 `.geographic-map .leaflet-*` 開頭的樣式：`.leaflet-container`、`.leaflet-control-zoom a`、`.leaflet-control-attribution`、`.leaflet-tooltip`、以及**`.leaflet-tile-pane { filter: brightness(0.66) saturate(0.58); }`** |

**`ssr: false` 是一個重要前提**：本專案沒有伺服器端渲染元件，第 6 題的多數 SSR 疑慮因此自動消失（詳見第 6 節）。

`.leaflet-tile-pane` 的那條 filter 就是目前「深色地圖」的全部實作——它把淺色底圖整片壓暗，代價是**地圖上的文字標籤同樣被壓暗**，變成低對比的灰字壓灰底，而不是深底亮字。這正是題目描述的「視覺破口」的技術成因。

---

## 1. 免金鑰的深色底圖有哪些？

### 1.1 先回答最重要的那題：OSM 官方 tile 現在算違規嗎？

**結論：不算明文違規，但也完全沒有保障。**「違規」與「不該依賴」是兩件事，本專案踩到的是後者。

[OpenStreetMap Foundation Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) 的要求逐條對照本專案：

| 政策要求（原文重點） | 本專案現況 | 判定 |
|---|---|---|
| 使用 `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | 兩個元件都是這個 URL | 符合 |
| 「Provide visible license attribution, typically: 『© OpenStreetMap contributors』」 | `RiskMap.vue` 有帶連結的 attribution control；`RoiMap.client.vue` 有純文字版 | 符合 |
| 「From web pages, ensure valid HTTP Referer headers are sent」 | 瀏覽器自動送出 | 符合 |
| 「Bulk downloading is any pre-emptive fetching of tiles other than those a user is actively viewing」為禁止行為 | 只在使用者實際檢視時載入，無預取、無離線快取 | 符合 |
| 「Cache tiles locally according to HTTP caching headers」 | 瀏覽器預設快取，未送 no-cache | 符合 |
| 送出可識別應用程式的 User-Agent | 瀏覽器情境下無法自訂 User-Agent；政策該段主要針對非瀏覽器 client，瀏覽器情境由 Referer 取代 | 不適用 |

**但政策同時明講的三句話，才是真正的風險：**

- 「Availability is best-effort: there is no SLA or guarantee.」
- 「We may block access, without notice, if your usage degrades the service.」
- 「Commercial services, or those that seek donations, should be especially aware that access may be withdrawn at any point.」

本專案是**公開 demo、非商業競賽作品、約 1600 個點但底圖流量與點數無關（只跟視野範圍與縮放次數有關）**，流量量級遠低於會「degrade the service」的門檻。所以**現況不構成違規，也不構成被封鎖的高風險**。政策原文也直接把找替代方案的責任推給使用者，指向 [Raster tile providers 社群清單](https://wiki.openstreetmap.org/wiki/Raster_tile_providers) 與 [switch2osm 供應商清單](https://switch2osm.org/providers/)。

換句話說：**「換掉 OSM 官方 tile」的正當理由是「它只有淺色」，不是「它違規」。** 不要用合規理由去說服自己做遷移，那個理由站不住。

### 1.2 Raster tile（Leaflet 可直接用）的深色候選

這一節的結論非常關鍵：**目前沒有一個「不需金鑰、不需註冊、可用於公開部署、明確允許商用、且有深色樣式」的 raster tile 供應商。**

依 [OSM Wiki 的 Raster tile providers 清單](https://wiki.openstreetmap.org/wiki/Raster_tile_providers)逐項檢查，**清單中所有標示為深色（dark）樣式的供應商，無一例外都需要 API key 或帳號**：CARTO Dark Matter、Tracestrack、Geoapify、Stadia Alidade Smooth Dark。清單中所有免金鑰的項目（OSM Standard、德國/法國變體、Humanitarian、CyclOSM、ÖPNVKarte、OpenTopoMap）**全部沒有深色樣式**。

逐一查證細節：

| 候選 | 需金鑰？ | 商用／公開 demo | 台灣涵蓋 | 一手來源 |
|---|---|---|---|---|
| **CARTO `dark_all`**（`basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`） | **是** | 免費額度 500 萬 tile/月，超量後「if it is commercial we may ask you to move onto a commercial agreement」；免費層要求標註 CARTO 與 OSM | 全球 | [CARTO Basemaps FAQ](https://docs.carto.com/faqs/carto-basemaps) |
| **Stadia `alidade_smooth_dark`** | **公開網域需帳號** | 官方：「As long as you're running via a development server accessed via `localhost` or `127.0.0.1`, you don't need an API key!」；公開站台需在 dashboard 設定網域白名單，**必須有帳號**。未認證請求「face strict rate limits… HTTP 429」 | 全球 | [Stadia Maps Authentication](https://docs.stadiamaps.com/authentication/) |
| **Esri World Dark Gray Base**（`services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`） | 無金鑰即可取得（2026-09-05 實測 HTTP 200，16,269 bytes） | **未查證** | 全球 | 端點行為為本次實測；**授權條款本次未取得 Esri 官方 ToU 原文，標為待驗，不建議在未查明前採用** |
| **OSM 官方 tile + CSS filter** | 否 | 見 1.1 | 全球 | 現況 |

**CARTO 的關鍵變化（有時效性，且對本專案是壞消息）**：CARTO 官方 FAQ 明講 raster basemap「require an API key and are being retired」，並且「考慮停止對 raster basemap 的資料更新」。實測 2026-09-05 該端點無金鑰仍回 HTTP 200，但依官方說明，**無金鑰取得的 tile 會被蓋上「API KEY REQUIRED」浮水印**——CARTO 的原文是「Your map still works. The watermark is a notice, not an outage.」對一個要拿去 demo 的看板來說，滿版浮水印等同不能用。

> 附帶查證：CARTO 表示「You do not need a CARTO account」就能申請 key（申請頁 `carto.com/basemaps/apikey`），但那仍是一個「部署期要管理的憑證」，正是題目要避免的東西。

**這一節的實質結論是：路線 A（留在 Leaflet 只換 tile）在「免金鑰」這個硬條件下，幾乎沒有乾淨的選項。** 這一點會直接決定第 8 節的成本評估。

### 1.3 Vector style（MapLibre 用）的深色候選

vector 這條路的狀況完全相反——**有一個乾淨、可驗證、免金鑰的深色選項。**

#### OpenFreeMap（本次查證中唯一完全符合硬條件者）

- **樣式 JSON URL（2026-09-05 逐一實測皆 HTTP 200）**：

  | 樣式 | URL | 大小 | 圖層數 |
  |---|---|---|---|
  | `dark` | `https://tiles.openfreemap.org/styles/dark` | 20,959 B | 47 |
  | `positron`（淺） | `https://tiles.openfreemap.org/styles/positron` | 25,153 B | 55 |
  | `bright` | `https://tiles.openfreemap.org/styles/bright` | 48,713 B | 119 |
  | `liberty` | `https://tiles.openfreemap.org/styles/liberty` | 43,079 B | 111 |
  | `fiord` | `https://tiles.openfreemap.org/styles/fiord` | 22,234 B | 48 |

- **`dark` 的背景色實測為 `rgb(12,12,12)`**（從回傳 JSON 的 `background` layer 直接讀出），與本專案 near-black 的 UI 底色是同一個色域，不需要再疊 CSS filter。
- **免金鑰**：官方 README 原文「There's no registration, no user database, no API keys, and no cookies」。
- **無流量上限**：官方原文「there are no limits on the number of map views or requests」。
- **允許商用**：官網 FAQ 對商用問題直接回答「Yes」。
- **授權**：專案程式碼 MIT，地圖資料為 OpenStreetMap（ODbL）。來源：[hyperknot/openfreemap](https://github.com/hyperknot/openfreemap)、[openfreemap.org](https://openfreemap.org/)。
- **台灣涵蓋（實測驗證）**：抓取新北市範圍的 vector tile `https://tiles.openfreemap.org/planet/20260830_080001_pt/14/13719/7015.pbf`（z14，對應 25.0106N/121.4626E），回傳 HTTP 200、**346,325 bytes**、`content-type: application/vnd.mapbox-vector-tile`。資料密度正常，不是空 tile。
- **資料新鮮度（實測）**：`https://tiles.openfreemap.org/planet` 的 TileJSON 顯示當前 planet build 為 `20260830_080001_pt`，即查證日前六天的 OSM 快照。

**OpenFreeMap 的風險，也必須誠實寫下來：**

- **沒有 SLA**。官方以捐款支撐營運，README 明講靠 GitHub Sponsors 與租用伺服器維持。這是一個**單一維護者主導**的服務。
- **`dark` 樣式官方自陳未完成**：[openfreemap-styles](https://github.com/hyperknot/openfreemap-styles) README 原文「Dark and Fiord is not yet complete. They are unmodified, which means they are exactly as they are on their source repo, with the only difference that fonts are set to Noto Sans」，且「Dark and Fiord are not offered on the Quick Start guide for the moment」。**它可用、但不是官方主推的一級樣式**，未來變動或下架的機率高於 `positron`/`liberty`。

#### 其他 vector 候選

| 候選 | 需金鑰？ | 狀況 |
|---|---|---|
| **MapLibre demotiles**（`https://demotiles.maplibre.org/style.json`） | 否 | **不可用於本專案**。官方 repo 自述用途為「Demo vector tiles and map style for web, helloworld and CI tests… Hosted directly on GitHub Pages, serverless, no keys」——即 demo 與 CI 測試用途，**內容只有國界與國名，沒有街道、沒有 POI**。以 GitHub Pages 靜態託管，repo 中未對生產可用性或服務保證作任何承諾。來源：[maplibre/demotiles](https://github.com/maplibre/demotiles) |
| **CARTO vector（`dark-matter-gl-style`）**（`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`，2026-09-05 實測 HTTP 200、70,431 B） | **目前否** | CARTO FAQ：vector 目前不需金鑰，但明講「may extend the key requirement to vector in future」。500 萬 tile/月 fair use、必須標註 CARTO + OSM。**「未來可能加上金鑰要求」對黑客松後續維運是實質風險** |
| **VersaTiles**（`https://tiles.versatiles.org/assets/styles/eclipse/style.json`，2026-09-05 實測 HTTP 200、168,044 B） | 端點免金鑰 | **本次未取得其官方 usage policy 原文，商用條款與流量政策未查證，標為待驗** |
| **Protomaps 自架 PMTiles** | 否（自架就沒有金鑰問題） | Protomaps 的**託管 API 需要金鑰**；但其 basemap 以單一 PMTiles 檔發布，可放在任何支援 HTTP Range 的靜態主機（含 Cloudflare R2 / S3），並提供 `light`/`dark`/`white`/`black`/`grayscale` 等 flavor。可用 `pmtiles` CLI 從 planet build 抽出台灣範圍。來源：[protomaps/basemaps](https://github.com/protomaps/basemaps)、[Basemaps for MapLibre](https://docs.protomaps.com/basemaps/maplibre)。**代價是新增一個建置步驟與一份需要託管的資料檔——對時間有限的黑客松是實質成本，但它是唯一「完全不依賴他人服務可用性」的選項** |

---

## 2. MapLibre GL JS 的免金鑰 style 現況（小結）

把第 1.3 節的查證收攏成可決策的三句話：

1. **有一個現成可用的免金鑰深色 style：OpenFreeMap `dark`**。vector tile 由 OpenFreeMap 自營基礎設施供應（`tiles.openfreemap.org`），資料來自 OSM planet，字型與 sprite 也由同一網域供應。無金鑰、無註冊、官方宣稱無流量上限、允許商用。
2. **可靠度沒有任何契約保障**，靠捐款營運，且 `dark` 樣式被官方標記為「尚未完成、暫不列入 Quick Start」。
3. **demotiles 不是選項**——它是 CI 與 hello-world 用的國界圖，沒有街道資料。任何把 demotiles 當替代方案的說法都應直接排除。

若要求「連他人服務可用性都不依賴」，唯一路徑是自架（Protomaps PMTiles 放 Cloudflare R2，或 OpenFreeMap 自架），代價是額外的資料建置與託管步驟。

---

## 3. Bundle size 實測

**量測方法（一手、可重現）**：2026-09-05 UTC 從 jsDelivr 下載 npm 官方發布的 dist 檔案，本機以 `gzip -9` 與 `brotli -q 11` 實際壓縮後取 byte 數。版本號取自 npm registry 的 `latest` tag（`https://registry.npmjs.org/<pkg>/latest`）。**未引用 bundlephobia 的快取數字**（該服務當時回 HTTP 429）。

### 3.1 原始數據

| 套件 | 版本 | 檔案 | minified (bytes) | gzip (bytes) | brotli (bytes) |
|---|---|---|---|---|---|
| leaflet | **1.9.4** | `dist/leaflet.js` | 147,552 | **42,356** | 36,938 |
| leaflet | 1.9.4 | `dist/leaflet.css` | 14,806 | 3,534 | 2,967 |
| maplibre-gl | **6.7.0** | `dist/maplibre-gl.mjs` | 578,187 | 145,117 | 122,802 |
| maplibre-gl | 6.7.0 | `dist/maplibre-gl-shared.mjs` | 492,183 | 137,486 | 113,197 |
| maplibre-gl | 6.7.0 | `dist/maplibre-gl-worker.mjs` | 19,181 | 6,165 | 5,508 |
| maplibre-gl | 6.7.0 | `dist/maplibre-gl.css` | 83,195 | 10,473 | 8,617 |
| ol | **10.10.0** | `dist/ol.js`（完整 bundle） | 1,043,059 | **289,433** | 212,872 |
| ol | 10.10.0 | `ol.css` | 6,343 | 1,473 | 1,235 |

### 3.2 可比較的「主執行緒 JS」數字

| 套件 | 主執行緒 JS（min / gzip） | 加上 CSS（gzip） | 相對 Leaflet |
|---|---|---|---|
| **leaflet 1.9.4** | 144 KB / **41.4 KB** | 44.8 KB | 基準 |
| **maplibre-gl 6.7.0** | 1,045 KB / **276.0 KB** | 286.2 KB（+ worker 6.0 KB 於背景執行緒） | **約 6.7 倍，+235 KB gzip** |
| **ol 10.10.0**（完整 bundle） | 1,019 KB / **282.6 KB** | 284.0 KB | 約 6.8 倍 |

**兩個必須註明的量測條件：**

1. **maplibre-gl 6.7.0 只發布 ESM**（v6 移除 UMD，見第 7 節）。主執行緒實際載入 `maplibre-gl.mjs` + `maplibre-gl-shared.mjs`，故取兩者相加。**交叉驗證**：改量 maplibre-gl **5.24.0** 的單一 UMD bundle `dist/maplibre-gl.js` 得 1,056,837 min / **275,089 gzip**，與 v6 的 276.0 KB 一致，確認加總方式正確。
2. **`ol` 的 289 KB 是「完整 bundle」，不是實際專案數字**。OpenLayers README 明講「Import just what you need for your application」，實務上以 ESM 具名匯入後由 Vite tree-shake，只用到 `Map`/`View`/`VectorLayer`/`TileLayer` 的話會遠小於此。**本次未實際建置量測 tree-shaken 後的體積，此數字僅為上界，標為待驗。** MapLibre 的 276 KB 則沒有這個折扣空間——它是一個整體的 WebGL 渲染引擎，tree-shaking 效果有限。

---

## 4. 1600 個互動圓點：三者的等價寫法與差異

### 4.1 現況（Leaflet）在做什麼

`RiskMap.vue` 的 `renderMarkers()` 是「**逐 marker diff 更新**」：維護 `markerById: Map<string, CircleMarker>`，已存在的呼叫 `setLatLng` / `setRadius` / `setStyle` / `setTooltipContent`，新的才 `circleMarker(...)` 建立，不在可視集合的移除。所有 marker 共用一個 `leaflet.canvas({ padding: .5 })` renderer，因此 1600 個點是畫在**單一 canvas** 上，而不是 1600 個 DOM 節點——這是 Leaflet 在此規模仍可用的關鍵。

實際上大部分時候畫的**不是 1600 個點**：預設 `mappedStations` 只回傳 `isActionable(station) || station.id === selectedId` 的子集，只有按下「查看全部」或搜尋時才展開到全量。

`RoiMap.client.vue` 相反，每次 `render()` 都 `clearLayers()` 後全量重建，沒有 diff。

### 4.2 MapLibre 的等價寫法

MapLibre 的模型是「**一個 GeoJSON source + 一個 circle layer + 資料驅動的 paint 運算式**」，不存在「每個點一個物件」的概念。1600 個點的更新是一次 `setData`。

```ts
// 1) 建立 source + layer（只做一次）
// promoteId 讓 feature 有穩定 id，才能用 feature-state 做 hover/選取高亮
map.addSource('stations', {
  type: 'geojson',
  promoteId: 'id',
  data: { type: 'FeatureCollection', features: [] },
})

map.addLayer({
  id: 'stations-circles',
  type: 'circle',
  source: 'stations',
  paint: {
    // 半徑：把 markerOptions() 算好的數值放進 properties，用 ['get'] 取
    'circle-radius': [
      '+',
      ['get', 'radius'],
      ['case', ['boolean', ['feature-state', 'selected'], false], 2, 0],
    ],
    // 顏色：markerColor() 的結果直接寫進 properties.color
    'circle-color': ['get', 'color'],
    'circle-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.92],
    'circle-stroke-color': [
      'case', ['boolean', ['feature-state', 'selected'], false], '#f4f4f5', '#242428',
    ],
    'circle-stroke-width': [
      'case', ['boolean', ['feature-state', 'selected'], false], 3, 1.25,
    ],
  },
})

// 2) 每次資料變動：一次呼叫，取代 1600 次 setStyle
function renderMarkers() {
  const source = map.getSource('stations') as maplibregl.GeoJSONSource
  source.setData({
    type: 'FeatureCollection',
    features: mappedStations.value.map(station => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [station.longitude, station.latitude] }, // 注意 [lng, lat]
      properties: {
        id: station.id,
        radius: markerOptions(station).radius,
        color: markerColor(station),
        tooltip: tooltipContent(station),
      },
    })),
  })
}

// 3) 互動：事件掛在 layer 上，不是掛在每個點上
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 })
let hoveredId: string | number | null = null

map.on('mousemove', 'stations-circles', (event) => {
  const feature = event.features?.[0]
  if (!feature) return
  map.getCanvas().style.cursor = 'pointer'
  if (hoveredId !== null) map.setFeatureState({ source: 'stations', id: hoveredId }, { hover: false })
  hoveredId = feature.id!
  map.setFeatureState({ source: 'stations', id: hoveredId }, { hover: true })
  popup.setLngLat(event.lngLat).setHTML(feature.properties.tooltip).addTo(map)
})

map.on('mouseleave', 'stations-circles', () => {
  map.getCanvas().style.cursor = ''
  if (hoveredId !== null) map.setFeatureState({ source: 'stations', id: hoveredId }, { hover: false })
  hoveredId = null
  popup.remove()
})

map.on('click', 'stations-circles', (event) => {
  const feature = event.features?.[0]
  if (feature) emit('select', String(feature.properties.id))
})
```

一手依據：`circle-radius`、`circle-color`、`circle-opacity`、`circle-stroke-width`、`circle-stroke-color` 五個 paint 屬性**全部支援 data-driven 運算式與 `feature-state`**，見 [MapLibre Style Spec — circle layer](https://maplibre.org/maplibre-style-spec/layers/#circle)。`queryRenderedFeatures` 與 `querySourceFeatures` 的 API 見 [Map class](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/)。

**與 Leaflet 相比，1600 點規模下的實際差異：**

| 面向 | Leaflet `circleMarker` + canvas renderer | MapLibre GeoJSON + circle layer |
|---|---|---|
| 渲染 | CPU 上的 Canvas 2D 逐點繪製 | GPU（WebGL2）批次繪製 |
| 1600 點靜態顯示 | 兩者都不會是瓶頸。**這個規模對 Leaflet canvas renderer 並不吃力，「MapLibre 比較快」在此規模不構成換套件的理由** | 同左 |
| 平移／縮放流暢度 | 每幀重繪整張 canvas，1600 點在中低階裝置上可能掉幀 | GPU 批次，優勢在此才顯現 |
| 資料更新 | 1600 次 `setStyle`（現況已做 diff 最佳化） | 1 次 `setData` |
| hover tooltip | `bindTooltip({ sticky: true })` **內建** | **無等價 API**，須自行組 `mousemove` + `Popup` + cursor 切換 + `feature-state`（見上方程式碼，這是實質工作量） |
| click 取得 feature | 每個 marker 自己 `.on('click')` | layer 層級事件，`event.features[0]` |
| 座標順序 | `[lat, lng]` | **`[lng, lat]`（全部要翻）** |
| 以公尺為半徑的圓 | `leaflet.circle(latlng, { radius: meters })` **內建** | **無等價 primitive**。`circle-radius` 單位是像素。要畫 `RiskMap.vue` 那個 `radiusMeters` 的鄰近熱區，必須改用預先計算的 GeoJSON 多邊形（自行實作或引入 turf），或用隨 zoom 內插的 `circle-radius` 運算式近似 |

**最後一列是最容易被低估的遷移成本**，也是 `RiskMap.vue` 特有的問題——`renderRiskHotspots()` 依賴 `cluster.radiusMeters`，這在 MapLibre 沒有一行對一行的替代寫法。

### 4.3 OpenLayers 的對應做法

兩條路：

- **Canvas 路（與 Leaflet 對等）**：`VectorLayer` + `VectorSource`，每個站點一個 `Feature(new Point(...))`，樣式用 `ol/style/Style` + `ol/style/Circle`。互動用 `map.forEachFeatureAtPixel()` / `map.getFeaturesAtPixel()`，tooltip 用 `ol/Overlay`。心智模型最接近現況，但一樣沒有內建 sticky tooltip。
- **WebGL 路**：`WebGLVectorLayer`（10.x 起）以 `circle-radius` / `circle-fill-color` 等宣告式樣式屬性描述點，內部轉成 shader。官方教材 [Rendering points with WebGL](https://openlayers.org/workshop/en/webgl/points.html) 與 [WebGL points layer 範例](https://openlayers.org/en/latest/examples/webgl-points-layer.html)。OpenLayers 團隊在 [Discussion #16187](https://github.com/openlayers/openlayers/discussions/16187) 中討論以 `WebGLVectorLayer` 取代舊的 `WebGLPointsLayer`。

**但 OpenLayers 對本專案的核心問題（深色底圖）毫無幫助**：它跟 Leaflet 一樣主要吃 raster tile，第 1.2 節的困境原封不動。若要吃 vector style，需要額外的 `ol-mapbox-style` 套件。換到 OpenLayers 等於付出接近 MapLibre 的 bundle 與改寫成本，卻沒有拿到 MapLibre 最主要的好處。

> `ol/style/Circle` 的半徑單位同樣是像素，公尺半徑的熱區在 OpenLayers 也要自行換算（可用 `ol/geom/Polygon.circular`）。

---

## 5. 明暗切換的實際 API 成本（本題直接決定主題切換的改動量）

### 5.1 MapLibre：`setStyle()` 會不會弄丟既有 layer/source？

**會。但這是可控的，且官方有明文建議的做法。以下每一句都可在原始碼中驗證。**

**事實 1：`diff` 預設為 true。** `maplibre-gl-js` v6.7.0 `src/ui/map.ts` 的 `setStyle` 實作：

```ts
if ((options.diff !== false && options.localIdeographFontFamily === this._localIdeographFontFamily) && this.style && style) {
    this._diffStyle(style, options);
    return this;
} else {
    this._localIdeographFontFamily = options.localIdeographFontFamily;
    return this._updateStyle(style, options);
}
```

`StyleSwapOptions.diff` 的官方註解（`src/style/style.ts`）：「If false, force a 'full' update, removing the current style and building the given one instead of attempting a diff-based update.」

**事實 2：即使走 diff，執行期加上去的 source/layer 仍會被移除。** 因為 diff 是拿「目前 style 狀態」跟「新 style JSON」比對；你用 `addSource('stations')` / `addLayer('stations-circles')` 加的東西存在於前者、不存在於後者，diff 因此產生移除操作。**這就是為什麼「換底圖」會弄丟站點圖層。**

**事實 3：官方建議的保留做法是 `transformStyle`，不是 `styledata` 重掛。** `setStyle` 的官方 JSDoc 範例（`src/ui/map.ts`，v6.7.0）就直接示範這件事：

```ts
map.setStyle('https://demotiles.maplibre.org/style.json', {
  transformStyle: (previousStyle, nextStyle) => ({
      ...nextStyle,
      sources: {
          ...nextStyle.sources,
          // copy a source from previous style
          'osm': previousStyle.sources.osm
      },
      layers: [
          // background layer
          nextStyle.layers[0],
          // copy a layer from previous style
          previousStyle.layers[0],
          // other layers from the next style
          ...nextStyle.layers.slice(1).map(...)
      ]
  })
});
```

官方對 `transformStyle` 的定義（[TransformStyleFunction](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/TransformStyleFunction/)）：「a convenience function that allows to modify a style after it is fetched but before it is committed to the map state」。**這是同步發生在 style 套用之前的**，因此不會有「圖層短暫消失再出現」的閃爍——這比監聽 `styledata` 事後重掛乾淨。

用在本專案就是：

```ts
function setTheme(theme: 'dark' | 'light') {
  const url = theme === 'dark'
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/positron'

  map.setStyle(url, {
    transformStyle: (previous, next) => ({
      ...next,
      sources: {
        ...next.sources,
        stations: previous.sources.stations,   // 站點 GeoJSON source 帶過去
        hotspots: previous.sources.hotspots,
      },
      layers: [
        ...next.layers,                        // 新底圖的所有圖層
        ...previous.layers.filter(layer =>     // 我們自己的圖層疊在最上面
          layer.id === 'stations-circles' || layer.id === 'hotspots-fill'),
      ],
    }),
  })
}
```

**事實 4（本次額外驗證，對本專案是好消息）：sprite/glyph 差異會強制 full update，但 OpenFreeMap 的五個樣式沒有這個問題。** `setStyle` 的官方 JSDoc 明講：

> 「Changes in sprites (images used for icons and patterns) and glyphs (fonts for label text) **cannot** be diffed. If the sprites or fonts used in the current style and the given style are different in any way, the map renderer will force a full update, removing the current style and building the given one from scratch.」

實測 2026-09-05，OpenFreeMap 五個樣式的 `sprite` 與 `glyphs` 完全相同：

| 樣式 | sprite | glyphs |
|---|---|---|
| positron / dark / bright / liberty / fiord | `https://tiles.openfreemap.org/sprites/ofm_f384/ofm` | `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf` |

**所以在 OpenFreeMap 的 dark ⇄ positron 之間切換，不會觸發強制 full rebuild，diff 路徑成立，`transformStyle` 一次搞定。** 若日後改用不同供應商的 dark/light 配對（例如 dark 用 A、light 用 B），sprite 網址不同就會退化成完整重建，屆時 `transformStyle` 仍能保住圖層定義，但 GPU 資源會整批重建，切換時會有可感知的停頓。

**MapLibre 的主題切換工作量小結**：一個 `setTheme()` 函式（約 20 行），加上把 `paint` 中寫死的顏色（`'#242428'`、`'#f4f4f5'`）改成讀 CSS 變數或依主題分支。**不需要重建 1600 個點的資料**。

### 5.2 Leaflet 換 tileLayer 的成本

**接近零。**

```ts
darkTiles.remove()
lightTiles.addTo(leafletMap)
```

Leaflet 的 tile 與 marker 位於不同的 pane（`leaflet-tile-pane` vs `leaflet-overlay-pane` / 自訂 pane），`markerById`、`hotspotLayer`、`markerLayer` 全部不受影響，也不需要 `fitBounds` 重來。地圖視野、縮放、選取狀態全部保留。

**這是 Leaflet 在本題上的明確優勢**：換底圖是一行；而 MapLibre 需要 `transformStyle` 手動搬運圖層定義。**但這個優勢的前提是「有兩套 raster tile 可換」——而第 1.2 節已經證明，免金鑰的深色 raster tile 並不存在。**

若走「維持 OSM tile + CSS filter」的路，主題切換更簡單：把 `.leaflet-tile-pane` 的 filter 值改成 CSS 變數，`:root` 與 `[data-theme="light"]` 各給一組即可，**JS 完全不用改**。代價是深色模式的地圖標籤仍然是壓暗的灰字，不是重新設計的深色配色。

---

## 6. Vue / Nuxt 4 靜態生成與 SSR

**最重要的前提：本專案 `nuxt.config.ts` 已設定 `ssr: false`。** 這是純 SPA，`nuxi generate` 只產出 HTML 殼，元件完全不在 Node 端執行。因此「MapLibre 在 SSR 時存取 `window` 會炸」這個常見問題**在本專案不存在**。

| 面向 | Leaflet（現況） | MapLibre GL JS | OpenLayers |
|---|---|---|---|
| 必須 client-only？ | 是（現況已用 `await import('leaflet')` 於 `onMounted` 中處理） | 是，同樣做法即可 | 是，同樣做法即可 |
| CSS 引入 | `nuxt.config.ts` 的 `css: ['leaflet/dist/leaflet.css']` | 換成 `'maplibre-gl/dist/maplibre-gl.css'`（10.2 KB gzip，比 Leaflet 的 3.5 KB 大） | `'ol/ol.css'` |
| 執行環境前提 | Canvas 2D，全數瀏覽器可用 | **WebGL2 為硬性要求**（見下） | Canvas 2D；WebGL 路徑才需 WebGL |
| 無頭環境 | 無問題 | **有問題**：一般無頭瀏覽器（未啟用 SwiftShader）沒有 WebGL2，地圖無法初始化。**在本專案影響有限**——`ssr: false` 表示建置時不會渲染元件；但若日後導入 Playwright 截圖、e2e 或視覺回歸測試，就必須顯式啟用 GPU/SwiftShader | 若走 Canvas 路則無問題 |

**MapLibre v6 的兩個破壞性變更（有時效性，直接影響整合方式）**，來源為 [v6.0.0 release notes](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.0.0)：

1. 「WebGL (v1) support has been removed; **WebGL2 is now required**.」v5 還能透過 `canvasContextAttributes.contextType` 退回 WebGL1，v6 不行。
2. 「Switch to an **ESM-only distribution** (`maplibre-gl.mjs`). The UMD bundles (`maplibre-gl.js`, `maplibre-gl-csp.js`) are no longer published.」且 `import maplibregl from 'maplibre-gl'` 須改為 `import * as maplibregl from 'maplibre-gl'` 或具名匯入。

第 2 點對本專案影響不大（Vite + ESM 原生支援），但**若沿用網路上以 `maplibre-gl@5` 為前提的範例程式碼，import 寫法會不對**。第 1 點則意味著要接受「不支援 WebGL2 的裝置看不到地圖」——這在 2026 年的一般使用者裝置上風險很低，但在受管制的企業環境或舊裝置上仍是真實的失敗模式，且**失敗是整張地圖不出現，不是降級**。

---

## 7. 授權現況

| 套件 | 授權 | 一手來源 |
|---|---|---|
| **Leaflet 1.9.4** | BSD 2-Clause（「Copyright (c) 2010-2026, Volodymyr Agafonkin / Copyright (c) 2010-2011, CloudMade」） | [Leaflet/Leaflet LICENSE](https://github.com/Leaflet/Leaflet/blob/main/LICENSE) |
| **MapLibre GL JS 6.7.0** | 3-Clause BSD。dist 檔頭亦內嵌：「@license 3-Clause BSD. Full text of license: https://github.com/maplibre/maplibre-gl-js/blob/v6.7.0/LICENSE.txt」（本次下載檔案時直接讀到） | [maplibre/maplibre-gl-js](https://github.com/maplibre/maplibre-gl-js) |
| **OpenLayers 10.10.0** | BSD 2-Clause。README：「It is completely free, Open Source JavaScript, released under the BSD 2-Clause License.」 | [openlayers/openlayers](https://github.com/openlayers/openlayers) |
| **Mapbox GL JS v2+**（對照組） | **專有**。LICENSE.txt：「The software and files in this repository (collectively, 'Software') are licensed under the Mapbox TOS for use only with the relevant Mapbox product(s) listed at www.mapbox.com/pricing.」需有效 Mapbox 帳號；禁止修改計費／統計相關程式碼；SDK 會回傳去識別化的位置與使用資料 | [mapbox/mapbox-gl-js LICENSE.txt](https://github.com/mapbox/mapbox-gl-js/blob/main/LICENSE.txt) |

**MapLibre 的 fork 緣由**，官方 README 原文：

> 「It originated as an open-source fork of mapbox-gl-js, before their switch to a non-OSS license in December 2020.」

即 Mapbox 在 2020 年 12 月隨 mapbox-gl-js v2.0 把授權從 BSD-3-Clause 改為專有的 Mapbox TOS，社群 fork 出 MapLibre 並維持在 3-Clause BSD。**對本專案的實際意義**：三個候選（Leaflet / MapLibre / OpenLayers）都是寬鬆的 BSD 系授權，商用、閉源、競賽作品皆無限制，**授權不構成任何一方的差異化因素**。真正有授權與條款風險的是**底圖資料供應商**（第 1 節），不是渲染套件。

底圖資料端的授權責任：OSM 資料為 ODbL，**必須保留 attribution**。目前兩個元件都有做，換供應商時務必一併更新歸屬文字（OpenFreeMap 用 OSM 資料；CARTO 要求同時標註 CARTO 與 OSM）。

---

## 8. 路線 A：最小改動解決深色底圖（留在 Leaflet，只換 tile）

### 改動範圍（對照真實程式碼）

| 檔案 | 改動 |
|---|---|
| `RiskMap.vue:322` | `leaflet.tileLayer(...)` 的 URL 與 attribution |
| `RoiMap.client.vue:129` | 同上 |
| `main.css:169-171` | `.leaflet-tile-pane` 的 filter（依選項調整或移除） |

**程式碼改動量：2 行 URL + 1 條 CSS 規則。** 主題切換：把 filter 值改成 CSS 變數，或準備兩個 `tileLayer` 實例互換（第 5.2 節，兩行）。**站點繪製、tooltip、click、cluster 熱區、fitBounds 全部零改動。**

### 但這條路線的核心問題

**第 1.2 節已經證明：不需要金鑰、允許公開部署、且有深色樣式的 raster tile 供應商，本次查證下來一個都沒有。** 所以路線 A 實際上要在下列四個都不完美的子選項中挑一個：

| 子選項 | 成本 | 風險 |
|---|---|---|
| **A1：維持 OSM tile，把 CSS filter 調得更深** | 最低，只改 CSS。可加 `invert(1) hue-rotate(180deg)` 之類做「反相深色」 | **視覺品質是這條路的天花板**。壓暗會讓標籤變低對比灰字；反相會讓水體與綠地顏色錯亂（藍色水域反相成橘色）。這是濾鏡而非配色設計，**不會達到 OpenFreeMap dark 那種「為深色而設計」的品質** |
| **A2：Stadia `alidade_smooth_dark`** | 改 2 行 URL | **違反「不新增部署期金鑰/帳號」的前提**。localhost 免金鑰，但 Cloudflare Pages 的公開網域必須在 Stadia dashboard 註冊網域白名單，而註冊需要帳號。未認證請求會被 HTTP 429 限流。**在 demo 現場才發現被限流是最糟的失敗模式** |
| **A3：CARTO `dark_all`** | 改 2 行 URL | **無金鑰會蓋滿版「API KEY REQUIRED」浮水印**，等同不能用；且官方明講 raster 正在退場並考慮停止資料更新。申請金鑰雖不需 CARTO 帳號，但仍是部署期憑證 |
| **A4：Esri World Dark Gray Base** | 改 2 行 URL | 實測無金鑰可取得，但**本次未查證 Esri 官方使用條款**。在未查明前採用，等於把授權風險帶進競賽作品。**不建議**，除非先補查 Esri ToU |

### 路線 A 的整體評估

- **時間成本**：A1 約 0.5–1 小時（含反覆調 filter 數值直到可接受）。A2/A3/A4 各約 0.5 小時改碼，但各自帶一個未解的前提條件。
- **回歸風險**：**極低**。不動 JS 邏輯，不動元件結構，不動 CSS 選擇器，1600 點的繪製路徑完全不變。
- **bundle 影響**：0。
- **主題切換的後續成本**：**最低**。第 4 項工作只需在 `:root` / light theme 各給一組 filter 值或 tile URL，`RiskMap.vue` 與 `RoiMap.client.vue` 的 JS 都不用動。
- **實質限制**：**這條路解決的是「地圖太亮」，不是「地圖不是深色設計」。** 若評審或使用者的標準是「地圖看起來像產品的一部分」，濾鏡方案大機率仍會被看出是濾鏡。

---

## 9. 路線 B：更換套件（以 MapLibre GL JS 為對象估算）

假設目標為 MapLibre GL JS 6.7.0 + OpenFreeMap `dark`/`positron`。（OpenLayers 不在此估算，理由見第 4.3 節：成本相當但不解決核心問題。）

### 改動範圍（對照真實程式碼，逐項）

| 檔案／區塊 | 改動性質 | 估計 |
|---|---|---|
| `nuxt.config.ts` `css` 陣列 | 換一個字串 | 極小 |
| `app/package.json` | 移除 `leaflet` / `@types/leaflet`，加 `maplibre-gl` | 極小 |
| `RiskMap.vue` `initialiseMap()`（L310-343） | `leaflet.map()` → `new maplibregl.Map()`；`preferCanvas` / `leaflet.canvas()` 兩個 renderer 與自訂 pane 全部作廢（MapLibre 用 layer 順序取代 pane）；`attributionControl` 設定方式不同 | 重寫，約 40 行 |
| `RiskMap.vue` `renderMarkers()`（L236-275） | `markerById` diff 迴圈整段刪除，改為建立 GeoJSON FeatureCollection + `setData`。**這一段是淨簡化** | 重寫，約 40 行 → 約 25 行 |
| `RiskMap.vue` `markerOptions()`（L205-215） | 回傳值從 Leaflet options 物件改為寫入 feature `properties` 的純量 | 小改 |
| `RiskMap.vue` tooltip（L259-264） | **`bindTooltip({ sticky: true })` 無等價 API**，須自建 `mousemove` + `Popup` + cursor + `mouseleave` 清除 | 新寫，約 30 行 |
| `RiskMap.vue` `renderRiskHotspots()`（L217-234） | **`leaflet.circle(..., { radius: cluster.radiusMeters })` 無等價 primitive**。須改為產生圓形 GeoJSON Polygon（自行實作經緯度換算，或引入 turf 增加相依）或用 zoom 內插的 `circle-radius` 近似 | **重新設計**，約 30-50 行，且需驗證不同 zoom 下的視覺正確性 |
| `RiskMap.vue` `fitCurrentScope()` / `focusSelectedStation()`（L277-308） | `latLngBounds` → `LngLatBounds`；`panTo` 簽章不同；`animate`/`duration` 選項名稱不同 | 小改 |
| **所有座標字面值** | `[lat, lng]` → `[lng, lat]`，兩個檔案全部 | **易錯**，需逐一核對 |
| `resizeObserver → invalidateSize`（L341） | MapLibre 內建 resize observer（`_setupResizeObserver`），這段可刪 | 淨簡化 |
| `RoiMap.client.vue` `render()`（L77-115） | 同樣的 clearLayers → setData 轉換，加上 tooltip 重建 | 重寫，約 40 行 |
| `main.css` L126-171 | **約 45 行 `.geographic-map .leaflet-*` 選擇器全部失效**，須改寫為 `.maplibregl-*`（`.maplibregl-canvas-container`、`.maplibregl-ctrl-group`、`.maplibregl-ctrl-attrib`、`.maplibregl-popup-content`…）。`.leaflet-tile-pane` 的 filter 規則可直接刪除 | 重寫，約 45 行 |
| 主題切換（新功能） | `setTheme()` + `transformStyle`（第 5.1 節），約 20 行 | 新寫 |

### 成本與風險

- **時間成本估計**：`RiskMap.vue` 約 4–8 小時（熱區與 tooltip 是最大變數），`RoiMap.client.vue` 約 2–3 小時，CSS 約 1–2 小時，整合驗證約 2 小時。**合計約 1.5–2 個工作天。** 這是估算而非實測，實際會受「熱區圓形怎麼畫」的決策影響甚大。
- **bundle 影響**：**+235 KB gzip**（41.4 → 276.0 KB），CSS +7 KB gzip。對 Cloudflare Pages 的靜態站台是首次載入變慢，但兩個地圖元件都是動態 import，只影響有地圖的頁面。
- **回歸風險**：**高**。座標順序翻轉、tooltip 行為、熱區半徑、CSS 選擇器全面更名——每一項都可能在 demo 當天才被發現。`RiskMap.vue` 有 `selectedId` 深連結、行政區篩選、搜尋、`showAllStations` 切換等多路互動，全部要重測。
- **執行環境風險**：WebGL2 為硬性要求（第 6 節）。**失敗模式是整張地圖不出現，沒有降級路徑。** 建議在 demo 前於實際展示機器上驗證。
- **底圖供應商風險**：OpenFreeMap 無 SLA、單一維護者、`dark` 樣式官方自陳「not yet complete」。**對黑客松而言，「不需金鑰」換來的是「不保證可用」——這只是把風險從『部署期憑證』換到『展示期可用性』，不是消除風險。** 可用 Protomaps PMTiles 自架消除此風險，但那是額外的建置與託管工作。

### 路線 B 換到的東西

- 真正為深色設計的底圖配色（`rgb(12,12,12)` 底 + 為深底調校的標籤與道路色），不是濾鏡。
- 主題切換的完整能力：dark ⇄ positron 走 diff 路徑（sprite/glyph 相同，已實測驗證），一個 `setTheme()` 搞定。
- 1600 點的更新從 1600 次 `setStyle` 變成 1 次 `setData`；平移縮放走 GPU。
- 未來若要加 3D、地形、傾斜視角、資料驅動的熱力圖，MapLibre 有現成能力，Leaflet 沒有。

### 一個介於 A 與 B 之間的選項（值得知道它存在）

`@maplibre/maplibre-gl-leaflet`（npm 上最新為 **0.1.4**，ISC 授權，2026-08-16 發布，peerDependencies 已宣告支援 `maplibre-gl` `^6.0.0`）可以把 MapLibre 的 vector style 當成一個 **Leaflet layer** 掛上去。

- **保留**：`RiskMap.vue` / `RoiMap.client.vue` 的全部 marker 程式碼、tooltip、cluster 熱區、`main.css` 的所有 `.leaflet-*` 選擇器、座標順序。
- **取得**：OpenFreeMap `dark` 的真實深色底圖。
- **付出**：仍然要載入完整的 `maplibre-gl`（+276 KB gzip），因為它只是渲染器；且多一層社群維護的黏合套件（版本 0.1.x，**未查證其維護活躍度與已知問題，標為待驗**）。主題切換須查證該套件是否轉發 `setStyle`（**本次未查證**）。

這個選項本次**未做深入查證**，列出來是因為它在成本結構上與 A、B 都不同——低改動量但高 bundle 成本——使用者在決策時應該知道它存在，而不是把選擇誤以為只有兩個。

---

## 10. 時效性與不確定性聲明

### 有時效性的資訊（未來查閱時必須重新確認）

1. **所有版本號與 bundle size**：實測於 **2026-09-05 UTC**。leaflet 1.9.4、maplibre-gl 6.7.0、ol 10.10.0 為當日 npm `latest`。MapLibre 與 OpenLayers 都在活躍開發，體積會隨版本變動。
2. **CARTO raster basemap 正在退場**。官方 FAQ 明講 raster「are being retired」且「考慮停止資料更新」。**這個狀態隨時可能變成完全停止服務。** vector 目前免金鑰，但官方保留「may extend the key requirement to vector in future」。
3. **OpenFreeMap 的所有端點與樣式內容**：`dark` 樣式的存在、內容、背景色（`rgb(12,12,12)`）、圖層數（47）、sprite/glyph 網址皆為當日實測。官方自陳 `dark` 與 `fiord`「is not yet complete」且「not offered on the Quick Start guide for the moment」——**這兩個樣式的變動或下架風險高於 positron/liberty**。
4. **OpenFreeMap 的 planet build 為 `20260830_080001_pt`**（查證日前六天）。URL 中含日期戳記，實際使用應透過 `https://tiles.openfreemap.org/planet` 的 TileJSON 動態取得，不要硬寫。
5. **OpenFreeMap 的營運持續性**：無 SLA、捐款支撐、單一維護者。**這是本文中最不穩定的單一依賴。**
6. **MapLibre v6 的破壞性變更**（WebGL2 強制、ESM-only）於 v6.0.0 生效。**網路上絕大多數範例仍以 v5 為前提，import 寫法不同。**
7. **OSM tile usage policy 原文**可能修訂。政策本身也聲明「Availability is best-effort: there is no SLA or guarantee」與「We may block access, without notice」——這是一個**單方面可隨時變更**的條件。

### 查證後仍不確定的事項（明確標示，不要當事實引用）

1. **`ol` 經 tree-shaking 後的真實體積未量測**。本文的 282.6 KB gzip 是 `dist/ol.js` 完整 bundle，是**上界不是實際值**。要得到真數字必須實際建一個只 import 所需模組的 Vite bundle，本次未做。
2. **Esri World Dark Gray Base 的使用條款未查證**。端點無金鑰可取得（HTTP 200 實測），但 ArcGIS Online 的 Terms of Use 原文本次未取得。**在查明前不應採用。**
3. **VersaTiles 的 usage policy、商用條款、流量限制均未查證**。只驗證了端點回應 HTTP 200。
4. **`@maplibre/maplibre-gl-leaflet` 的實際成熟度未查證**：只確認了 npm 上的版本（0.1.4）、授權（ISC）、發布日（2026-08-16）與 peerDependencies。**未查證其 issue 狀況、已知限制、是否支援執行期 `setStyle` 換主題。**
5. **「MapLibre 在 1600 點下比 Leaflet canvas renderer 快多少」沒有實測**。本文只做架構層面的推論（GPU 批次 vs CPU 逐點）。**在 1600 這個量級，兩者都可能完全不是瓶頸**，不應把效能當作換套件的主要理由。真要知道，得在目標裝置上實際量 FPS。
6. **Protomaps 自架 PMTiles 的實際建置成本未評估**：台灣範圍抽取後的檔案大小、Cloudflare R2 的 Range request 行為、建置腳本的複雜度，本次都未實測。
7. **路線 B 的「1.5–2 個工作天」是估算，不是實測**。最大的不確定性在 `renderRiskHotspots()` 的公尺半徑圓——這個功能在 MapLibre 沒有直接對應，實作方式的選擇會顯著改變工時。
8. **OSM tile policy 中「User-Agent」要求對純瀏覽器應用的適用性**是本文的推論（認為由 Referer 要求取代），**政策原文未明確處理瀏覽器情境**。此判斷未經 OSMF 確認。
9. **MapLibre v6 對 CJK（中文）字型的處理**未查證。`localIdeographFontFamily` 預設為 `'sans-serif'`（會用本機字型繪製中日韓字元以省頻寬），但**本專案站名全是中文，實際在 OpenFreeMap glyph 供應下的中文標籤呈現效果未實測**——這對一個新北市站點地圖是相當重要的視覺細節，**建議在決策前先做一次目視驗證**。
