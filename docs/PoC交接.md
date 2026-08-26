# PoC 交接文件（來自資料集分析 session）

> 建立：2026-08-25
> 來源 session：`a-36`，工作目錄 `c:\Users\hughc\OneDrive\文件\project\Hackthon\2026-Shinbei-Youbike\A_交通局-資料集`
> **完整討論紀錄在 `meeting.md`（路徑見下），本文只寫「你需要立刻知道的事」與「不在 meeting.md 裡的決策」。**

## 必讀檔案（絕對路徑）

| 檔案 | 內容 |
|---|---|
| `c:\Users\hughc\OneDrive\文件\project\Hackthon\2026-Shinbei-Youbike\A_交通局-資料集\meeting.md` | **主文件**。資料盤點、文獻實證、KPI 定義、參數決議、PoC 九步計畫 |
| 同目錄 `docs\research\bike-share-demand-prediction.md` | 文獻研究報告（GBFS、excess demand、預測≠調度） |
| 同目錄 `talk1.md` | 早期策略討論（反事實模擬構想的來源） |

原始 CSV 也在該目錄（6 個月、約 1.1 GB、1,300–1,400 萬筆、30 分鐘粒度、1,576 站）。

---

## 〇、進度更新（2026-08-26，CtrlCity 專案內 session）

> **本節數字取代第一節與第五節裡已過時的內容。** 細節見 git log（`Hugh_v0.0` 分支）。第一、五節原文保留不動，僅供對照歷史決策過程。

### 已完成：Step 1、2、2.5、3、4

**Step 4（全站 baseline）修正了兩次：**

| 版本 | 60分鐘 F1 | Precision | Recall | 說明 |
|---|---:|---:|---:|---|
| 217 站抽樣（第一節原始數字） | 39.2% | 35.0% | 44.5% | `hash mod 8` 抽樣，不具代表性 |
| 全站 1,578 站（未排除壞站） | 46.4% | 42.1% | 51.7% | 抽樣偏低已修正，但含長期故障站 |
| **全站 + 排除 38 站長期故障站（定案）** | **34.8%** | **28.4%** | **45.0%** | **唯一該拿來當 PoC 對照的基準** |

第二版比第三版高，是因為長期故障站（可借車數卡在 0 數週到數月）對這套規則基線是送分題——historical profile 學到「這格永遠是空的」，模型永遠猜對，貢獻零成本真陽性。**第五節「F1 > 39.2%」的成功判準已過時，改為「60分鐘 F1 > 34.8% 且 Precision 明顯高於 28.4%」。**

**新增：38 站長期故障站偵測與排除**

第七節提到的「數值連續 N 筆凍結」heuristic 已實作（`app/scripts/detect-frozen-stations.mjs`，N=48 格=24小時視為高信心）。掃出 38 站，其中 7 站與雙 0 名單重疊，31 站是全新發現（有位可還、只是沒車，卡了數週到近三個月）。**已用官網逐一核實，確認為真實暫停營運**，非資料雜訊。

排除窗登記在 `app/data/operational-adjustments.json`（可由「營運調整」頁面編輯／匯出／匯入），已接進三條管線：`station-time-profile.mjs`（ROI 統計）、`evaluate-forecast.mjs`（baseline 評估）、`build-artifacts.mjs`（正式 dashboard.json）。三者的 `ALERT_THRESHOLDS`（`risk-policy.mjs`）已同步更新為新驗證集閾值：30分=0.45、**60分=0.40（原 0.45）**、120分=0.40。

**編碼陷阱補充**（第六節之外新發現）：
- `新北AWS黑克松競賽0301-14.csv` 是 UTF-8 無 BOM 且無前導引號，其餘 8 個競賽檔才是 CP950；用「有 BOM 或開頭引號」判斷編碼會誤判，須對 header 做嚴格 UTF-8 解碼。
- **DuckDB 1.5.5 不能直接讀 Big5 檔**：CRLF 會被誤判成 `\r`，須先轉成 UTF-8 再讀。
- SQL 自我 JOIN 時，城市／行政區／站名若是 `NULL`（非空字串，13,324,945 列中有 1,514 列）會被 `NULL=NULL` 悄悄排除，須 `COALESCE` 成空字串——Node.js 版本因 `csv-parse` 給空字串而非 `NULL`，從沒踩過這個坑。

**ML PoC 環境已建置並完成 Step 1/2/2.5/3**

`ml/` 目錄已建立（venv Python 3.12；duckdb/pyarrow/pandas/xgboost/scikit-learn 已裝；Python 3.14 的 wheel 覆蓋不全，需指定 3.12）。

| 產出 | 內容 | 交叉驗證 |
|---|---|---|
| `ml/data/clean.parquet` | 13,324,945 列、1,578 站、`is_operational` 欄（雙0＋38站排除窗） | 行數與 Node 版本 raw 行數完全對上 |
| `ml/data/features.parquet` | 30 欄：身分/時間、當前庫存、四組滯後特徵（30/60/120分/1天前）、三視窗×三種 target（empty/full/issue） | test split 60分鐘正樣本比率 3.75%，與 Node 版本 base rate 3.8% 幾乎一致 |

兩者皆用 DuckDB SQL 向量化處理（`LAG`/`LEAD` window function），初版曾誤用 Python 逐列迴圈處理 1332 萬列，已重寫修正。管線與腳本：`ml/src/clean.py`、`ml/src/features.py`。

**額外功能**（不在九步計畫內，使用者臨時需求）：「營運ROI」頁面（依星期/時段/行政區/站點檢視歷史缺車率滿柱率，含地圖與逐日明細）、「營運調整」頁面（排除窗管理）、首頁熱門度圖表的 dev-mode 修復（`npm run data:live-static`）。

### Step 5 進行中：XGBoost 訓練

`ml/src/train.py` 已完成，每個視野（30/60/120分）各訓一個 `XGBClassifier` 二元分類器，預測 `target_{h}_issue`（缺車或滿柱，對齊規則 baseline 的 combined 指標）。設定：`tree_method=hist`、`enable_categorical=True`（`station_id`/`slot`/`weekday` 直接當類別特徵）、`scale_pos_weight` 依訓練集正樣本率（約4.1%）校正、`early_stopping_rounds=50` 看 validation（5月）AUCPR。

踩過的坑：
- `station_id` 在 train/validation 各自 `astype("category")` 時類別集合不同步，validation 出現 train 沒見過的站直接讓 XGBoost 報錯。修法：跨全部資料先抓固定的 `station_id`/`slot`/`weekday` 類別清單，train/validation/test 全部套用同一份 `pd.CategoricalDtype`。
- 第一輪 `n_estimators=2000`，60分與120分視野都在樹數上限前還在漲，代表被硬性截斷而非真正 early stop；加大到4000重跑。

產出：`ml/output/model_{30,60,120}.json`、`feature_importance_{h}.json`、`val_proba_{h}.npy`/`val_target_{h}.npy`（供 Step 6 掃閾值用）。

### 新發現：規則 baseline 的表現嚴重依行政區而異

把 `evaluate-forecast.mjs` 的 6 月測試集混淆矩陣依站點所屬行政區拆分重算（新增 `evaluateTimelinesByGroup`，輸出到 `forecast-evaluation.json` 的 `test.byDistrict`，29 區 × 3 視野，檔案 45KB／限50KB），發現全站 34.8% F1 是被平均掉的假象——**站多、基礎缺車率低的市區明顯拖累分數，郊區反而很準**：

| 分類 | 例子 | Precision | F1 | 特徵（60分鐘視野） |
|---|---|---:|---:|---|
| 高分 | 平溪區、石碇區 | 97% / 96% | 97% / 97% | 站少（4-5站）、缺車事件比例高達21%/7.4% |
| 中等 | 萬里區、三芝區 | 55-70% | 55-66% | 站少、事件比例中等 |
| 低分 | 板橋區、三重區、新莊區 | 21-31% | 27-39% | 站多（100+站）、缺車事件比例只有2-6% |
| 歸零 | 烏來區、石門區 | 0% | 0% | 樣本太少或 6 月無事件 |

根本原因：baseline 用**全站統一的單一閾值**（60分鐘=0.4），但各區基礎缺車率（`posRate`）差異極大。平溪這種觀光型站點缺車率高達21%，模型抓「歷史上常常沒車」就對，precision自然高；板橋這種市區站多、周轉快、缺車率只有3-6%，同一個門檻會把大量正常波動誤判成警報，precision被稀釋。**這代表 baseline 在市區（高流量、低基礎缺車率）誤報特別多，正是最需要 ML 模型改善的地方；郊區規則已經夠用，模型的邊際效益較低。**

前端已接上：「營運ROI」頁面新增 F1 Dashboard 區塊，規則基線卡片會跟著行政區選單切換到該區數字（`app/pages/roi.vue`，`baselineF1` 依 `selectedDistrict` 查 `test.byDistrict`），四張卡片加了滑鼠 hover 說明 Precision/Recall/F1/樣本數的白話定義（`MetricCard.vue` 新增 `tooltip` prop）；模型 F1（30/60/120分、跟著所選時段換算）目前是「尚未產生」佔位狀態，等 Step 7 產出 per-scope 資料再接上。

### 已完成：Step 6、7 —— XGBoost vs 規則 baseline 最終對照

Step 6（`ml/src/threshold.py`）用驗證集（5月）機率掃描各視野最佳 F1 閾值，邏輯對齊 `evaluate-forecast.mjs` 的 `selectThreshold`（最大化F1，同分依序比precision/recall/threshold）。Step 7（`ml/src/evaluate.py`）用選定閾值在 6月測試集（從未被訓練或選閾值用過）評估。

| 視野 | 指標 | 規則 Baseline | XGBoost | 差異 |
|---|---|---:|---:|---:|
| 30分 | F1 | 45.3% | 47.3% | +2.0pp |
| | Precision | 40.3% | 41.1% | +0.8pp |
| | Recall | 51.7% | 55.6% | +3.9pp |
| **60分（主力）** | **F1** | **34.8%** | **38.0%** | **+3.2pp** |
| | Precision | 28.4% | 30.8% | +2.4pp |
| | Recall | 45.0% | 49.7% | +4.7pp |
| 120分 | F1 | 26.3% | 31.7% | +5.4pp |
| | Precision | 22.2% | 24.9% | +2.7pp |
| | Recall | 32.4% | 43.4% | +11.0pp |

**對照成功判準「60分鐘 F1 > 34.8% 且 Precision 明顯高於 28.4%」**：F1 過了（38.0%），但 Precision 只提升2.4個百分點，改善主要來自 Recall 大幅提高（+4.7pp）而非誤報明顯減少，不算完全達成「Precision 明顯高於」的判準精神。視野越長改善越明顯（120分 F1 +5.4pp、Recall +11.0pp），可能是長視野下規則 baseline 的歷史統計失真更嚴重，模型能學到的東西更多。

產出：`ml/output/selected_thresholds.json`（各視野選定閾值）、`ml/output/test_evaluation.json`（測試集混淆矩陣）。已同步一份精簡版到 `app/data/model-evaluation.json`，並接進「營運ROI」頁面的模型 F1 區塊（`app/pages/roi.vue`）——目前只有全站彙總數字，還沒有依行政區/站點拆分，所以不會跟著頁面選單變動（跟規則基線卡片不同，那個已有 `test.byDistrict`）。

### 下一步：4 個可選方向（尚未決定，待討論）

Precision 改善幅度不大是目前最大的疑問，以下是討論過的候選方向，尚未選定：

1. **加鄰站空間特徵**（PoC 九步計畫原訂 Step 8）：也許上下游鄰站的即時狀態能補上額外訊號，提升 precision。
2. **先接受現有結果，直接往下做**：F1 有改善即可視為「驗證過 ML 有優勢」，先把其他 PoC 項目（前端整合、demo）做完。
3. **把 XGBoost 結果也拆成 per-district**：驗證先前的推論（baseline 在市區誤報特別多，ML 應該在市區進步最多）是否成立，跟 `evaluate-forecast.mjs` 的 `test.byDistrict` 做法一致地重算模型版本。
4. **調參或加特徵再評估一次**：目前只用了當前庫存+四組滯後+動量，還沒加入 `station-time-profile` 的訓練期統計特徵（歷史同站同時段空/滿率），這是最可能大幅提升 precision 的方向，但也是「加鄰站空間特徵」之外的另一種特徵擴充，兩者可以一起做或分開驗證效果。

### 可討論的方式:
如果總車柱數=m,可借車數=n,可還車數k=m-n, n為可設定的參數
- 先定義目前所有站點時常缺車(n<=2)或是滿車(k<=2),先計算各站點每星期幾的每個時段,看是否有規律(是否需要考慮假日).找出不管缺車或是滿車時常低於平均值的站別,針對這些站別來優化,看看是否能提升整體F1值,也就是現有的baseline預測適合人數少或是站數少的行政區,但是多的站別則使用模型來協助


### AWS 部署時機

等本機 `npm run dev` 全部確認無誤才開始導入；技術方向是在既有 Lambda 模式（健康檢查、即時代理、AgentCore 說明端點）下加一個窄端點，把排除窗 JSON 寫進 S3，不建 DynamoDB。詳見 `docs/03_實作與驗證/AWS正式環境交接.md`。

---

## 一、本專案現況的定位（重要）

CtrlCity 已完成度很高且已上線。經比對，**先前規劃的多數建議你們已經實作了**：直接預測存量、停運剔除、嚴格時間切分、60 分鐘主視野、P/R/F1、貪婪配對含容量限制、反事實模擬雛形。

**唯一真正的技術缺口：目前的「模型」是啟發式規則基線，不是 ML 模型。**

6 月保留測試集實測（217 站抽樣，約 30 萬筆）：

| 視窗 | Precision | Recall | F1 |
|---|---:|---:|---:|
| 30 分 | 43.3% | 55.4% | 48.6% |
| **60 分（主力）** | **35.0%** | 44.5% | **39.2%** |
| 120 分 | 24.8% | 39.4% | 30.4% |

**最痛的是 Precision 35%**：60 分鐘視窗誤報 10,226 次 vs 命中 5,495 次，誤報是命中的兩倍。

PoC 的任務就是：**用 XGBoost 打贏這組數字**，特別是 Precision。

---

## 二、PoC 落點決策（不在 meeting.md 裡，剛談定）

**PoC 寫在本專案（CtrlCity），不寫在資料集目錄。** 理由：本專案有 git 版控、有現成 baseline 可對照、產出的預測 JSON 可直接餵前端。

**資料不必複製。** `app/scripts/build-artifacts.mjs:35` 已有環境變數機制：

```powershell
$env:CTRL_CITY_DATASET_DIR = "c:\Users\hughc\OneDrive\文件\project\Hackthon\2026-Shinbei-Youbike\A_交通局-資料集"
```

（`docs/資料集/` 目前是空的，CSV 實際只在上述路徑。）

**建議目錄結構**（Python 與 Node.js 用目錄隔離，勿把 `.py` 散進 `app/`）：

```
Hackathon2026CtrlCity/
├── app/                  現有 Nuxt（不動）
├── ml/                   ← 新增
│   ├── src/              轉檔、特徵、訓練、評估
│   ├── data/             clean.parquet / features.parquet（gitignore）
│   ├── output/           模型與評估結果
│   └── requirements.txt
└── docs/
```

`.gitignore` 需補：`ml/data/`、`ml/output/`、`ml/.venv/`、`__pycache__/`

**套件（PoC 開始前需安裝，環境目前皆無）：**

```powershell
pip install "duckdb>=1.1" "pyarrow>=18.0" "pandas>=2.2" "xgboost>=2.1" "scikit-learn>=1.5"
```

**儲存策略結論：離線轉 Parquet，線上維持靜態 JSON 不加 DB。**
現況的 Cloudflare Pages + 靜態 JSON 架構是對的，不要改成 PostgreSQL。

---

## 三、四個必須遵守的技術約束（違反會毀掉簡報論述）

### 1. 切分必須沿用「1–4 月訓練 / 5 月選閾值 / 6 月測試」

使用者原本決議「1–5 月訓練」，但**現有 baseline 是 1–4 月訓練、5 月選閾值**。
若 XGBoost 吃 1–5 月，就比 baseline 多用一個月資料，**贏了也說不清是模型好還是資料多**，會毀掉「規則 → ML 改善 X%」這句核心話術。且 5 月被拿去訓練後就沒地方選閾值，只能拿 6 月調 = 過擬合測試集。

> XGBoost 輸出 0~1 機率，需掃描切點找 F1 最高值。缺車事件僅約 4%（12,344/301,564），預設 0.5 會幾乎不發警報。現有 baseline 選出的閾值是 30/60 分 = 0.45、120 分 = 0.40。

### 2. 反事實模擬要跑 6 月，不是 4 月

現況 `operational-impact.json` 的三個場景是 **2026-04-26、2026-04-27**、2026-06-30 —— **兩個落在訓練期**（歷史基線正是用 1–4 月算的），改善幅度會虛高。PoC 應一併移到 6 月。

模擬與預測是**串行**的：訓好模型 → 在 6 月跑預測 → 用預測驅動模擬。

### 3. 「服務成功率」必須拆成兩個，且要標註是代理指標

借不到車與還不了車是**相反的失效模式**，合併會互相抵銷。官方數字本身就是分開的（見車率 93%、見位率 99%，差距證明缺車遠比滿站嚴重）。

| 指標 | 定義 | 對應官方 |
|---|---|---|
| 借車可用率 | `1 −(可借車數 ≤ 門檻 的站點時段數 / 營運中站點時段數)` | 見車率 |
| 還車可用率 | `1 −(可還位數 ≤ 門檻 的站點時段數 / 營運中站點時段數)` | 見位率 |

分母只計營運中時段（排除停運）。必須標註這是**站點可用性**，不是真實使用者成功率（後者需 App 端借車嘗試紀錄，資料不存在 —— censored demand）。

### 4. baseline 要重跑到全 1,576 站

現況用 `hash mod 8 = 0` 只抽樣 217 站（`歷史風險基線評估.md` 自承「上線前應重跑全站」）。不重跑就沒有可比的基準。

---

## 四、參數修正（依新聞實證）

> 新聞：台北市 YouBike 逾 1,300 站，僅 **40 台**小貨車調度，**每車一次最多載運 14 輛**。

程式碼裡現有三個容易混淆的參數，實際意義各不同：

| 參數 | 現值 | 位置 | 意義 |
|---|---:|---|---|
| `MAX_MOVE_BIKES` | 8 | `build-artifacts.mjs:46` | **單筆**搬運上限（A站→B站一次） |
| `vehicleCapacity` | 12 | `dispatch-route-planner.ts:96` | **車輛容量**（車上同時最多載） |
| `MAX_DISPATCHES` | 12 | `build-artifacts.mjs:44` | 每次更新產生的建議筆數上限（與上面 12 同值是巧合） |

**修正項：**

- `vehicleCapacity: 12 → 14`（新聞實證）
- **新增 `fleetSize` 參數**：現有系統完全沒有「車隊規模」概念，`MAX_DISPATCHES = 12` 沒有物理依據。新北實際車隊數不明，預設用台北比例推估 40/1300 × 1576 ≈ **48 台**，須標註為假設且可調
- `MAX_DISPATCHES` 應改為由 `fleetSize × 每小時趟數` 推導，而非固定 12
- 其他決議值：每台車每小時 1 趟、單筆上限維持 8 台、來源站安全庫存 15%、目的站空位緩衝 10%
- **所有可調參數要集中到單一設定檔**（使用者明確要求），建議 `config/params.json`

**重要影響：** 48 台 × 1 趟 × 14 台 ≈ 每小時可搬 672 台次，而現況模擬每次只搬 45–57 台 —— **現有模擬只用了車隊理論能力的一小部分**，這解釋了為何 `reductionRate` 僅 5.2%–10.1%。修正後改善幅度應明顯上升，且有物理依據可回應評審追問。

---

## 五、PoC 九步計畫與成功判準

| # | 步驟 | 產出 |
|---|---|---|
| 1 | DuckDB 讀 CSV → 清理層 | `clean.parquet`（處理 Big5/CP950 編碼、建 `station_key`） |
| 2 | 標記停運（雙 0）並排除 | 加 `is_operational` 欄 |
| 2.5 | 建 30 分鐘網格 + lag 特徵 | `features.parquet` |
| 3 | 建 target（+30/+60/+120 是否缺車／滿柱） | 分類標籤 |
| 4 | **重跑規則 baseline 到全 1,576 站** | 可比對的基準分數 |
| 5 | 訓 XGBoost（**1–4 月**） | model artifact |
| 6 | **用 5 月掃描閾值** | 各視窗選定閾值 |
| 7 | **6 月測試集**評估，與 baseline 對照 | **P/R/F1 對照表 ← PoC 成敗判準** |
| 8 | 加鄰站空間特徵 | 消融對照 |
| 9 | 反事實模擬跑 **6 月** | ROI 數字 |

**成功判準：** 60 分鐘 **F1 > 39.2%** 且 **Precision 明顯高於 35%**。
若 F1 升了但 Precision 沒改善，代表只是把門檻調鬆，**不算成功**。

**停損點：** 做到第 7 步拿到對照表就先檢視。提升有限就立刻停損，轉去做模擬升級 —— 「我們驗證過 ML 沒有顯著優勢，因此保留可解釋的規則」也是誠實且站得住腳的敘事。

---

## 六、編碼陷阱（務必處理）

`improvement-point.md` 已記錄：**3/15–5/31 的競賽檔是 Big5／CP950，其他檔多為 UTF-8**。直接合併會使站名與行政區亂碼，導致 `station_key` 對不上。

補充實測：一月檔時間格式是 `2026/01/11 18:00`（無秒數），三月競賽檔是 `2026-03-01 23:30:40`（有秒數且非整點）—— **兩種格式要分別 parse 後對齊到 30 分鐘網格**。

---

## 七、停運資料實測（供 heuristic 參考）

六月資料：可借=0 且 可還=0 共 **33,749 筆（1.5%）**，涉及 **51 站（3.2%）**。

| 雙 0 筆數 | 意義 | 代表站點 |
|---|---|---|
| 1,440（= 30 天 × 48，整月每筆） | 整月完全停運 | 德泰公園、捷運三民高中站(1號出口)、金城龍山二街口、汐止公園等 |
| 720（恰好半個月） | 月中啟用或停用 | 雙溪車站、菁桐老街、猴硐火車站、富基漁港、翡翠灣停車場等 |

720 那批高度集中在**平溪線與北海岸觀光景點**，疑似季節性／觀光型站點或月中新啟用。使用者決議：先做小型站點主檔（需查官網公告、站名變更），先分析後補充。

⚠️ 雙 0 只抓得到「完全停運」。若某站「可借 0、可還 20」持續數日不動，需另一個 heuristic：**數值連續 N 筆凍結**（N 待 EDA 決定）。

---

## 八、其他待辦（使用者已決議，優先度較低）

- 站點主檔用 **CSV／JSON 人工維護**（1,576 筆、要人工編輯、要版控、要能 diff），**不要放進 DB**
- 天氣特徵暫緩（決議「不考慮極端／特殊條件」），第 7 步跑完視提升幅度再決定
- 不做多折 forward-chaining（已決議），但若 6 月分數異常低於 5 月，要想到是季節 regime shift 而非模型壞掉
- 連續 replay 模擬：有時間再做，優先度低於 XGBoost
- Demo 形式：6 月歷史回放為主、當天即時為輔

## 九、團隊分工

4 人團隊，**Hugh 親自做 PoC**。另外 3 人的平行工作（不搶同一路徑）：站點主檔建置、參數集中化重構、Demo 腳本與簡報敘事。
