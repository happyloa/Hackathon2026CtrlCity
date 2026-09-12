# 新北市 29 區行政區界資料來源查證：來源、格式、授權與簡化

> **與目前 Demo 的關係**：專案要在地圖上做「行政區分區著色」(choropleth)，需要新北市 29 個行政區的邊界多邊形。**目前 repo 內確實沒有任何 GeoJSON**（已確認）。本文查證可用的資料來源、授權與處理成本，並給出最省事路徑，**不修改任何程式碼**。

**研究日期：** 2026-09-05（所有下載、檔案大小、欄位內容、Overpass 查詢皆為當日實測）
**研究範圍：** 官方來源與直接下載網址、格式與座標系、授權條款、原始檔大小與簡化策略、OpenStreetMap 替代路徑、GitHub 社群整理版、與本專案既有資料的 join key 相容性。
**方法：** 一手來源優先——(1) 實際下載官方 ZIP 並解壓、逐一讀取 `.prj` / `.CPG` / `.dbf` 內容；(2) 本機以 mapshaper 實際跑轉檔與簡化，所有檔案大小為 `stat` 與 `gzip -9` 實測，非引用二手數字；(3) 對 Overpass API 直接發查詢驗證回應；(4) 官方資料集頁面與授權條款原文。凡未實際驗證者一律標為「未查證」。

---

## 0. 一句話結論

**最省事的路徑是：從內政部國土測繪中心的「鄉鎮市區界線(TWD97經緯度)」下載全國 SHP，用一行 `mapshaper` 指令篩出新北市 29 區、簡化、輸出 GeoJSON。** 本次已實際跑通，產物 **97,884 bytes（gzip 26,389 bytes）**，**不需要座標轉換**（原始資料已是經緯度），**不需要處理 join key**（`TOWNNAME` 與專案 `dashboard.json` 的 `district` 欄位 29/29 完全一致）。詳見第 8 節。

---

## 1. 官方來源與直接下載網址

### 1.1 主要來源：內政部國土測繪中心「鄉鎮市區界線(TWD97經緯度)」

| 項目 | 內容 |
|---|---|
| 資料集頁面 | [政府資料開放平臺 dataset/7441](https://data.gov.tw/dataset/7441) |
| 提供機關 | 內政部國土測繪中心 |
| **直接下載網址** | `https://www.tgos.tw/tgos/VirtualDir/Product/3fe61d4a-ca23-4f45-8aca-4a536f40f290/鄉(鎮、市、區)界線1140318.zip` |
| 實測 HTTP 狀態 | **200**，`content-type: application/x-zip-compressed` |
| 實測檔案大小 | **12,801,023 bytes（約 12.2 MB）** |
| 伺服器 `last-modified` | `Thu, 10 Apr 2025 06:23:04 GMT` |
| 版本代號 | `1140318`（民國 114 年 3 月 18 日版） |
| 更新頻率 | 不定期更新 |

> **下載注意**：URL 含中文字元。以 `curl` 下載時需 percent-encode，實測可用的形式為
> `https://www.tgos.tw/tgos/VirtualDir/Product/3fe61d4a-ca23-4f45-8aca-4a536f40f290/%E9%84%89(%E9%8E%AE%E3%80%81%E5%B8%82%E3%80%81%E5%8D%80)%E7%95%8C%E7%B7%9A1140318.zip`
> 瀏覽器直接點連結則無此問題。

**ZIP 內容（實際解壓後清單）：**

| 檔案 | 大小 | 說明 |
|---|---|---|
| `TOWN_MOI_1140318.shp` | 18,402,100 bytes | **主檔**，全國 368 個鄉鎮市區 |
| `TOWN_MOI_1140318.dbf` | 35,218 bytes | 屬性表 |
| `TOWN_MOI_1140318.prj` | 148 bytes | 座標系定義 |
| `TOWN_MOI_1140318.CPG` | 5 bytes | 內容為 `UTF-8` |
| `TOWN_MOI_1140318.shx` / `.sbn` / `.sbx` | 小 | 索引 |
| `Town_Majia_Sanhe.*` | 46 KB | 瑪家鄉／三和村的補充圖層 |
| `TW-07-301000100G-614001.xml`、`修正清單_11403.xlsx` | — | 詮釋資料與本期修正說明 |

**屬性欄位（由 `.dbf` header 直接讀出）：**

```
TOWNID (C,8)  TOWNCODE (C,12)  COUNTYNAME (C,12)  TOWNNAME (C,12)
TOWNENG (C,39)  COUNTYID (C,3)  COUNTYCODE (C,8)
```

新北市的 `COUNTYCODE` 為 `65000`、`COUNTYID` 為 `F`。以 `COUNTYNAME == "新北市"` 篩選，**實測命中 29 筆，與行政區數完全相符**。

### 1.2 其他官方入口（同一份資料的不同管道）

| 管道 | 網址 | 備註 |
|---|---|---|
| 內政資料開放平臺 | [data.moi.gov.tw](https://data.moi.gov.tw/MoiOD/Data/DataContent.aspx?oid=CD02C824-45C5-48C8-B631-98B205A2E35A) | 同一資料集的機關端頁面 |
| 國土測繪圖資服務雲 下載專區 | [maps.nlsc.gov.tw](https://maps.nlsc.gov.tw/MbIndex_qryPage.action?fun=8) | 需在網頁上互動選取，**比直接抓 ZIP 麻煩** |
| 國土測繪圖資 e 商城 | [whgis-nlsc.moi.gov.tw](https://whgis-nlsc.moi.gov.tw/) | 部分圖資需申請，非本資料的最短路徑 |
| 縣市層級界線 | [dataset/7442 直轄市、縣市界線(TWD97經緯度)](https://data.gov.tw/dataset/7442) | 只到縣市層級，**本專案用不到** |

### 1.3 新北市政府資料開放平臺

[新北市資料開放平臺](https://data.ntpc.gov.tw/) 上查到的相關資料集是 **[新北市里界圖資](https://data.ntpc.gov.tw/datasets/8bbd1aca-752c-4df0-b515-1cfd88b36274)**，為 **村里（里）層級** 的 SHP，欄位含 `ADMIT`（區名）、`ADMIT_ID`、`ADMIV`（里名）、`ADMIV_ID`。

- 理論上可用 `ADMIT` 做 dissolve 合併成 29 區，但**這是多一道工序**，且里界的邊界品質不必然等同官方區界。
- **未查證**：本次未實際下載該檔，其檔案大小、座標系、更新年份均未驗證。
- **結論：不建議走這條**。既然國土測繪中心已直接提供區級界線，沒有理由從里界回推。

新北市民政局另有 [111 年版行政區域圖](https://www.ca.ntpc.gov.tw/home.jsp?id=48e44b032e4b0aa2) 頁面，但**本次未查證其是否提供向量圖資檔（可能只是圖片或印刷版）**。

---

## 2. 格式與座標系

### 2.1 提供的是 SHP，不是 GeoJSON

官方**只提供 Shapefile**，沒有 GeoJSON 或 TopoJSON 的官方版本。需要自行轉檔。

### 2.2 座標系：這是最容易搞錯的一點

`.prj` 檔的完整內容（逐字節讀出）：

```
GEOGCS["GCS_TWD97[2020]",DATUM["D_TWD_1997",SPHEROID["GRS_1980",6378137.0,298.257222101]],
PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]
```

**關鍵事實：這是 `GEOGCS`（地理座標系，單位為度），不是 `PROJCS`（投影座標系，單位為公尺）。**

- 資料集名稱中的「TWD97**經緯度**」就是字面意思——**經緯度，不是 TWD97 / TM2 二度分帶（EPSG:3826）**。
- 對應的 EPSG 代碼是 **EPSG:3824（TWD97 geographic）**，橢球體為 GRS80，**不是 EPSG:3826**。
- 網路上常見「台灣的政府圖資都是 EPSG:3826，要先投影轉換」的說法，**對這份資料不成立**。真正是 EPSG:3826 的是另外的「村里界圖(TWD97_121分帶)」等資料集（[dataset/7440](https://data.gov.tw/dataset/7440)）。

**實測驗證**：抽出新北市 29 區後，座標 bounding box 為
`121.282688, 24.673192 → 122.007503, 25.300303`
——標準的經緯度數值，完全落在新北市的實際地理範圍內。

### 2.3 需不需要轉換成 WGS84？

**實務上不需要。**

TWD97 與 WGS84 同樣以 GRS80 橢球為基準、同屬 ITRF 框架，兩者在台灣的差異為**次公尺等級**，遠小於一個網頁地圖 pixel 在任何實用 zoom 下代表的距離。對於「行政區分區著色」這種視覺用途，**直接把 TWD97 經緯度當成 WGS84 經緯度餵給 Leaflet / MapLibre，肉眼無法分辨差異**。

> **未查證**：本次未取得內政部對 TWD97↔WGS84 精確偏移量的官方數值文件，上述「次公尺等級」為一般大地測量常識而非本次查證的一手來源。若專案有公分級精度需求（本專案沒有），應另行查證。

**若仍要顯式轉換**，指令如下（需安裝 GDAL）：

```bash
# TWD97 經緯度 (EPSG:3824) → WGS84 (EPSG:4326)
ogr2ogr -f GeoJSON ntpc.geojson TOWN_MOI_1140318.shp \
  -s_srs EPSG:3824 -t_srs EPSG:4326 \
  -where "COUNTYNAME = '新北市'" \
  -lco RFC7946=YES -lco COORDINATE_PRECISION=5
```

**假設來源真的是 TWD97 / TM2 二度分帶（EPSG:3826）時**才需要這一版（本資料**不是**，列出僅供對照其他資料集使用）：

```bash
ogr2ogr -f GeoJSON out.geojson in.shp -s_srs EPSG:3826 -t_srs EPSG:4326
```

> **本機環境注意（實測）**：本專案開發機**未安裝 GDAL**（`ogr2ogr`、`ogrinfo` 皆為 command not found），但 **Node.js v24.8.0 可用**。因此第 8 節的最省事路徑改用 `npx mapshaper`，不需要安裝 GDAL。

### 2.4 編碼

`.CPG` 檔內容為 `UTF-8`，`.dbf` 中的中文欄位以 UTF-8 儲存。**實測 mapshaper 讀取後中文正確無誤**（輸出 `"TOWNNAME": "永和區"`），不需要指定 `-encoding` 參數。

---

## 3. 授權

### 3.1 條款

[dataset/7441 頁面](https://data.gov.tw/dataset/7441) 標示的授權為 **政府資料開放授權條款－第 1 版**（[條款原文](https://data.gov.tw/license)），計費方式為**免費**。

| 問題 | 答案 | 依據 |
|---|---|---|
| 可否商業利用？ | **可以。** 條款授權「不限目的、時間及地域」利用，明文包含開發商業產品或服務 | [政府資料開放授權條款第 1 版](https://data.gov.tw/license) |
| 可否重製、散布？ | **可以。** 條款明文列舉「重製、散布、公開傳輸、公開播送……編輯、改作」 | 同上 |
| 可否製作衍生物（簡化後的 GeoJSON）？ | **可以。** 「改作」在授權範圍內 | 同上 |
| 有什麼義務？ | **必須標示來源（顯名標示）。** 條款明文：「未盡顯名標示義務者，**視為自始未取得開放資料之授權**」 | 同上 |

### 3.2 對本專案的實際意義

**唯一的義務是 attribution，但這個義務是硬性的**——條款的措辭是「視為自始未取得授權」，不是「建議標示」。建議在地圖的 attribution control 加上：

```
行政區界：內政部國土測繪中心（政府資料開放授權條款第 1 版）
```

專案目前兩張地圖（`RiskMap.vue`、`RoiMap.client.vue`）都已有 attribution 機制（見 [地圖套件選型研究](map-library-selection.md) 第 1.1 節），加一行字即可，**不需要新增 UI**。

---

## 4. 檔案大小與精度：需不需要簡化？

### 4.1 原始資料的實際量體（全部為本次實測）

| 階段 | 大小 | 備註 |
|---|---|---|
| 官方 ZIP（全國） | **12,801,023 B（12.2 MB）** | HTTP `content-length` |
| 解壓後 `.shp`（全國 368 區） | **18,402,100 B（17.6 MB）** | |
| 抽出新北市 29 區、**未簡化**、座標保留 6 位小數的 GeoJSON | **2,701,583 B（2.58 MB）** | 自行以 Python 直讀 SHP 產出 |
| 同上 gzip -9 | **665,670 B（650 KB）** | |
| 29 區的原始頂點總數 | **108,805 個** | |

### 4.2 結論：**必須簡化**

對 Cloudflare Pages 這種靜態站台而言，**2.58 MB 未壓縮 / 650 KB gzip 的單一 GeoJSON 是不可接受的**：

- 這份資料只是為了畫 29 塊色塊。650 KB gzip 已經**超過整個 `maplibre-gl` 的 gzip 體積（276 KB）**，更是現行 `leaflet` 的 15 倍（見 [地圖套件選型研究](map-library-selection.md) 第 3 節）。
- 108,805 個頂點要在 Leaflet 的 Canvas renderer 上逐點繪製，會直接影響平移縮放的流暢度。
- 原始資料的精度是給地籍、國土規劃用的（包含海岸線的每一個轉折），**在市級 choropleth 的顯示尺度下，這些細節一個 pixel 都看不到**。

### 4.3 簡化工具與實測結果

**推薦工具：[mapshaper](https://github.com/mbloch/mapshaper)**（本機實測版本 **0.7.58**，可用 `npx` 免安裝執行）。理由：

- **直接讀 `.shp`**，不需要先轉 GeoJSON，也不需要 GDAL。
- 內建 `keep-shapes` 選項，保證簡化過程中**不會讓任何一個小區塊消失**（對平溪、石碇這種形狀複雜的區很重要）。
- 篩選、去欄位、簡化、輸出、控制小數位數**可以在同一行指令完成**。

**各簡化率的實測產物大小（全部為本機實跑，29 個 feature，屬性只保留 `TOWNCODE`/`TOWNNAME`/`TOWNENG`，`precision=0.00001`）：**

| `-simplify` | 檔案大小 | gzip -9 | 評價 |
|---|---|---|---|
| （不簡化） | 2,701,583 B | 665,670 B | 過大 |
| `20%` | 376,832 B | 99,212 B | 仍偏大 |
| `10%` | 192,636 B | 51,386 B | 可用，細節保留較多 |
| **`5%`** | **97,884 B** | **26,389 B** | **建議值**。落在 100–300 KB 目標的低端 |
| `2%` | 43,044 B | 10,789 B | 邊界開始明顯稜角化 |
| `1%` | 25,321 B | 6,207 B | 過度簡化 |

**建議採 `5%`**：97 KB 未壓縮 / 26 KB gzip，頂點數由 108,805 降到 **4,493**（減少 95.9%）。這個量體對靜態站台與 Canvas renderer 都完全無壓力。

> 若在實際地圖上目視覺得海岸線太粗糙，往上調到 `10%`（51 KB gzip）仍在合理範圍。**建議在決定最終值前實際看一次貢寮／石門的海岸線與烏來的山區邊界**——這三處是全市邊界最複雜的地方。

> **一個未驗證的觀察**：`5%` 的輸出中 29 個 feature 的 `geometry.type` **全部是 `Polygon`，沒有任何 `MultiPolygon`**。新北市確實沒有顯著離島，這與預期相符，但**本次未逐一核對每個區的環（ring）數量**，若前端程式碼假設一定是 `MultiPolygon` 需注意。

---

## 5. 替代來源：OpenStreetMap

### 5.1 Overpass API（本次實測可行）

**新北市在 OSM 的行政區階層（實測驗證）：**

- 新北市本身：relation **1527220**，`admin_level=4`，`name=新北市`，`name:en=New Taipei`。
- 其下的 `admin_level=7` **正好 29 個 relation**，與官方 29 區數量一致（`name:en` 抽樣：Tamsui / Sanzhi / Shimen / Jinshan / Wanli / Xizhi / Shenkeng / Ruifang District）。
- 查詢 `admin_level` 6 與 8 均為 0 筆——**新北市的區在 OSM 中固定是 `admin_level=7`**。

**實測可用的查詢**（area id = 3600000000 + relation id）：

```bash
curl -G "https://overpass-api.de/api/interpreter" --data-urlencode \
'data=[out:json][timeout:240];
rel(area:3601527220)["boundary"="administrative"]["admin_level"="7"];
out geom;'
```

**實測回應大小：2,306,639 B（2.2 MB），gzip 後 344,394 B。**

**但這條路比官方來源麻煩**，原因是：

1. Overpass 回傳的是 **OSM 原生 JSON，不是 GeoJSON**。relation 的多段 `way` 必須先組裝成封閉的 polygon，需要額外工具（如 `osmtogeojson`）。這是官方 SHP 路徑沒有的一道工序。
2. 屬性欄位是 OSM tag（`name`、`name:en`、`ref` 等），**不保證與專案的 `district` 欄位字串一致**，可能需要對照表。
3. Overpass API 是**公共服務、無 SLA、有速率限制**，`out geom` 這種重查詢在尖峰時段可能逾時。

### 5.2 osm-boundaries.com

[osm-boundaries.com](https://osm-boundaries.com/) 提供互動式介面挑選 admin_level 並下載，但：

- **必須以 OpenStreetMap 帳號 OAuth 登入才能下載**，未登入僅能瀏覽。
- 網站聲明資料按月從 OSM 匯入、原樣提供，並要求「提供連結到該服務作為資料來源」，且**禁止轉售、再散布其平台材料**。
- **未查證**：其免費額度的具體上限、輸出格式清單、是否有付費牆，本次均未驗證。

對一個時間有限的黑客松，**「先去註冊一個 OSM 帳號」本身就已經比直接抓官方 ZIP 貴了**。

### 5.3 授權：ODbL

Overpass API 回應的 `copyright` 欄位逐字如下（本次實測直接讀到）：

> "The data included in this document is from www.openstreetmap.org. The data is made available under **ODbL**."

**ODbL 是 share-alike 授權**——若散布衍生資料庫，須以相同授權釋出，並保留 attribution。相較之下，**政府資料開放授權條款第 1 版只要求 attribution、沒有 share-alike 義務，對本專案更寬鬆**。

> 專案的底圖若採用 OSM 系來源（見 [地圖套件選型研究](map-library-selection.md)），本來就已負有 ODbL 的 attribution 義務；但**區界資料另外引入 ODbL，會讓授權面多一層 share-alike 的考量**。這是選官方來源而非 OSM 的另一個理由。

---

## 6. 現成的社群整理版

| 專案 | 內容 | 授權 | 資料年份 | 評估 |
|---|---|---|---|---|
| **[dkaoster/taiwan-atlas](https://github.com/dkaoster/taiwan-atlas)** | 預先建好的 **TopoJSON**（nation / counties / towns / villages，含 mercator 投影版），來源自陳為「the shapefiles provided by Taiwan's Ministry of the Interior」 | npm 上為 **MIT**（實測 `registry.npmjs.org` 的 `license` 欄位） | npm 版本 **2021.9.20**，**比官方 1140318（2025 年）舊約 4 年** | **最接近可用的社群版**。`towns-10t.json` 實測 **512,094 B**（全國），可經 jsDelivr CDN 取得 |
| **[g0v/twgeojson](https://github.com/g0v/twgeojson)** | 台灣行政區 GeoJSON，已用 d3.simplify 簡化 | **CC0 1.0 Universal**（作者 Chia-liang Kao 放棄著作權） | 含 1982 與 2010 年版本，**明顯過舊** | **不建議**。2010 年版早於 2010 年底的五都改制與後續調整 |
| **[ronnywang/twgeojson](https://github.com/ronnywang/twgeojson)** | 縣市／鄉鎮市區／村里三級，附 `simplify.php` | **未查證** | **未查證** | 本次未驗證，不建議在查明前採用 |
| **[jason2506/Taiwan.TopoJSON](https://github.com/jason2506/Taiwan.TopoJSON)** | 縣市／鄉鎮／村里 TopoJSON | **未查證** | **未查證** | 同上 |

### 為什麼社群版不是最省事的路

直覺上「別人已經轉好了」應該最快，但實際盤算下來**並沒有比較省事**：

1. **taiwan-atlas 是 TopoJSON，不是 GeoJSON。** 要餵給 Leaflet 或 MapLibre 必須先用 `topojson-client` 的 `feature()` 轉回 GeoJSON，等於**多一個執行期相依套件**或多一道建置步驟。
2. **它是全國資料（512 KB）**，仍需篩出新北市，篩選工作一步都沒省。
3. **資料是 2021 年版**，官方最新是 2025 年版。行政區界雖然變動不頻繁，但**用舊資料的唯一好處是省事，而它並沒有省到**。
4. **MIT 授權標的是「程式碼」還是「資料」有模糊空間**——底層資料仍是內政部的開放資料，attribution 義務不會因為包一層 npm 套件而消失。

**相較之下，第 8 節的官方路徑是一行指令、最新版本、輸出直接就是 GeoJSON。**

---

## 7. 新北市 29 區清單（由官方 `.dbf` 直接讀出）

**與本專案既有資料的相容性（實測）**：把上表的 `TOWNNAME` 與 `app/data/dashboard.json` 的 `districts` 陣列比對，結果是 **29 對 29 完全一致，雙向差集皆為空集合**。專案內 `station.district` 的值（如 `新莊區`、`平溪區`、`永和區`、`板橋區`）可**直接**與 GeoJSON 的 `TOWNNAME` 字串比對，**不需要任何名稱正規化或對照表**。

| # | TOWNCODE | 區名 | TOWNENG |
|---|---|---|---|
| 1 | 65000010 | 板橋區 | Banqiao District |
| 2 | 65000020 | 三重區 | Sanchong District |
| 3 | 65000030 | 中和區 | Zhonghe District |
| 4 | 65000040 | 永和區 | Yonghe District |
| 5 | 65000050 | 新莊區 | Xinzhuang District |
| 6 | 65000060 | 新店區 | Xindian District |
| 7 | 65000070 | 樹林區 | Shulin District |
| 8 | 65000080 | 鶯歌區 | Yingge District |
| 9 | 65000090 | 三峽區 | Sanxia District |
| 10 | 65000100 | 淡水區 | Tamsui District |
| 11 | 65000110 | 汐止區 | Xizhi District |
| 12 | 65000120 | 瑞芳區 | Ruifang District |
| 13 | 65000130 | 土城區 | Tucheng District |
| 14 | 65000140 | 蘆洲區 | Luzhou District |
| 15 | 65000150 | 五股區 | Wugu District |
| 16 | 65000160 | 泰山區 | Taishan District |
| 17 | 65000170 | 林口區 | Linkou District |
| 18 | 65000180 | 深坑區 | Shenkeng District |
| 19 | 65000190 | 石碇區 | Shiding District |
| 20 | 65000200 | 坪林區 | Pinglin District |
| 21 | 65000210 | 三芝區 | Sanzhi District |
| 22 | 65000220 | 石門區 | Shimen District |
| 23 | 65000230 | 八里區 | Bali District |
| 24 | 65000240 | 平溪區 | Pingxi District |
| 25 | 65000250 | 雙溪區 | Shuangxi District |
| 26 | 65000260 | 貢寮區 | Gongliao District |
| 27 | 65000270 | 金山區 | Jinshan District |
| 28 | 65000280 | 萬里區 | Wanli District |
| 29 | 65000290 | 烏來區 | Wulai District |

> `TOWNCODE` 是穩定的官方代碼，**比中文名稱更適合當 GeoJSON feature 的 `id`**（不受未來改名影響、不受字元編碼問題影響）。建議 `promoteId` 或 join key 用 `TOWNCODE`，`TOWNNAME` 只拿來顯示。

### 面積差異的實務提醒

題目提到 29 區面積差異極大，這在 choropleth 上是**真實的視覺陷阱**，值得先知道：

- 平溪、貢寮、烏來、石碇、坪林等山區面積廣大，在地圖上佔據絕大部分視覺面積，但**站點數極少**。
- 板橋、永和、三重等區面積小、站點密集，**在 choropleth 上幾乎看不見**，卻是資料量最大的地方。
- 直接用「該區指標值」上色，視覺重心會被大而空的山區完全主導。

**本文不對配色或指標設計下結論**（超出查證範圍），僅指出這是必須在設計階段處理的問題，可能的方向包括改用 cartogram、對面積做正規化、或把小區另外以 inset 呈現。**這些方案本次均未查證其實作成本。**

---

## 8. 最省事路徑（具體步驟）

**前提：本機已有 Node.js（實測 v24.8.0），不需要安裝 GDAL、QGIS 或 Python 套件。**

### 步驟 1：下載並解壓官方 ZIP

```bash
curl -L -o town.zip \
  "https://www.tgos.tw/tgos/VirtualDir/Product/3fe61d4a-ca23-4f45-8aca-4a536f40f290/%E9%84%89(%E9%8E%AE%E3%80%81%E5%B8%82%E3%80%81%E5%8D%80)%E7%95%8C%E7%B7%9A1140318.zip"
unzip -o town.zip -d town
```

得到 `town/TOWN_MOI_1140318.shp`（約 12 MB 下載、17.6 MB 解壓）。

### 步驟 2：一行指令完成篩選 + 去欄位 + 簡化 + 輸出 GeoJSON

```bash
npx -y mapshaper town/TOWN_MOI_1140318.shp \
  -filter '"新北市" === COUNTYNAME' \
  -filter-fields TOWNCODE,TOWNNAME,TOWNENG \
  -simplify 5% keep-shapes \
  -o app/public/data/ntpc-districts.geojson format=geojson precision=0.00001
```

**本次已實際跑過這行指令**，mapshaper 輸出 `[filter] Retained 29 of 368 features`，產物 **97,884 bytes**，屬性中文正確（`"TOWNNAME": "永和區"`），座標為經緯度（bbox `121.28269, 24.67319 → 122.00693, 25.29998`），**未發生任何重投影**。

各參數的作用：

| 參數 | 作用 | 為什麼需要 |
|---|---|---|
| `-filter '"新北市" === COUNTYNAME'` | 從全國 368 區篩出 29 區 | 不篩的話檔案大 12 倍 |
| `-filter-fields TOWNCODE,TOWNNAME,TOWNENG` | 只留 3 個欄位 | 丟掉 `COUNTYNAME` 等 4 個對每個 feature 都相同的冗餘欄位 |
| `-simplify 5% keep-shapes` | 簡化到 5%，且保證不弄丟任何區塊 | 見第 4.3 節。`keep-shapes` 是必要的，否則複雜小區塊可能被整個消掉 |
| `precision=0.00001` | 座標保留 5 位小數（約 1 公尺） | 6 位以上的小數在此顯示尺度下純屬浪費 bytes |

### 步驟 3：確認與收尾

1. **目視檢查**：把產物丟進 [geojson.io](https://geojson.io/) 或直接掛上專案地圖，**重點看貢寮／石門的海岸線與烏來的山區邊界**。若太粗糙，把 `5%` 改成 `10%`（51 KB gzip）重跑。
2. **加 attribution**：在地圖的 attribution 加上「行政區界：內政部國土測繪中心（政府資料開放授權條款第 1 版）」。**這是授權的硬性義務，不是選配**（第 3.2 節）。
3. **join**：前端以 `feature.properties.TOWNCODE` 為 key（顯示用 `TOWNNAME`），與 `dashboard.json` 的 `district` 對應。**實測 29/29 完全吻合，不需要對照表。**

### 為什麼這是最省事的路

| 常見的「應該要做」的步驟 | 本路徑是否需要 | 原因 |
|---|---|---|
| 安裝 GDAL / QGIS | **不需要** | mapshaper 直讀 SHP，`npx` 免安裝 |
| 座標系轉換（EPSG:3826 → 4326） | **不需要** | 原始資料已是經緯度（第 2.2 節） |
| 處理中文編碼 | **不需要** | `.CPG` 為 UTF-8，mapshaper 自動處理（實測） |
| 建立區名對照表 | **不需要** | 與專案 `district` 欄位 29/29 完全一致（第 7 節） |
| TopoJSON → GeoJSON 轉換 | **不需要** | mapshaper 直接輸出 GeoJSON（走 taiwan-atlas 才會需要） |
| 註冊帳號 / 申請金鑰 | **不需要** | 直接 HTTP GET（走 osm-boundaries 才會需要） |

**淨工作量：兩行指令 + 一次目視檢查 + 一行 attribution 文字。**

---

## 9. 時效性與不確定性聲明

### 有時效性的資訊

1. **所有檔案大小、HTTP 回應、欄位內容、Overpass 查詢結果皆實測於 2026-09-05。**
2. **官方 ZIP 的下載網址內嵌版本代號 `1140318`。** 資料集為「不定期更新」，**下一版發布時這個 URL 會改變**（歷史上的命名慣例是換成新的日期代號）。若指令在未來失效，應回 [dataset/7441](https://data.gov.tw/dataset/7441) 取得當時的 resource URL，**不要假設 URL 永久有效**。
3. **mapshaper 版本為 0.7.58**（`npx` 當日取得）。`-simplify` 的預設演算法若在未來版本變更，各簡化率的產物大小可能與本文的實測表不同。建議在腳本中**釘住版本**（`npx mapshaper@0.7.58`）以求可重現。
4. **taiwan-atlas 的 npm 版本為 2021.9.20**，若未來發布新版，其資料年份的劣勢可能消失。
5. **OSM 的 relation id（新北市 = 1527220）與 `admin_level=7` 的分級**是當日實測，OSM 資料可被任何人編輯，理論上會變動。

### 查證後仍不確定的事項（不要當事實引用）

1. **TWD97 與 WGS84 的精確偏移量未查證。** 本文的「次公尺等級、可視為等同」是大地測量常識，非本次取得的一手官方數值。公分級需求須另行查證。
2. **新北市里界圖資（data.ntpc.gov.tw）未實際下載。** 其座標系、檔案大小、更新年份、dissolve 成 29 區的可行性均未驗證。
3. **新北市民政局「111 年版行政區域圖」是否提供向量圖資檔未查證**，可能只是圖片或印刷版。
4. **`ronnywang/twgeojson` 與 `jason2506/Taiwan.TopoJSON` 的授權與資料年份完全未查證。**
5. **osm-boundaries.com 的免費額度、輸出格式清單、付費結構未查證**，只確認了「下載須 OAuth 登入」與其禁止再散布的聲明。
6. **簡化後的視覺品質未經目視驗證。** 第 4.3 節的建議值 `5%` 是依據檔案大小與頂點數的推論，**本次沒有把產物實際掛上地圖看過**。海岸線複雜的貢寮、石門與山區的烏來，是最可能在 5% 下失真的地方，**採用前務必目視確認**。
7. **`5%` 產物全為 `Polygon` 而無 `MultiPolygon`**，符合「新北市無顯著離島」的預期，但**未逐一核對每個區的 ring 數量**，也未驗證簡化是否影響了相鄰區之間的拓樸一致性（mapshaper 的簡化預設會保持共享邊界一致，但**本次未實際檢查是否有縫隙或重疊**）。
8. **choropleth 的面積失衡問題（第 7 節末）只提出現象，未查證任何解法的實作成本。**
9. **官方資料本身的邊界精度與現實行政區的一致性未查證。** ZIP 內附有 `修正清單_11403.xlsx`，顯示本期有修正項目，但**本次未開啟該檔確認修正了哪些區域**。
