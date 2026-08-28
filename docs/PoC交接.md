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

產出：`ml/output/selected_thresholds.json`（各視野選定閾值）、`ml/output/test_evaluation.json`（測試集混淆矩陣）。已同步一份精簡版到 `app/data/model-evaluation.json`，並接進「營運ROI」頁面的模型 F1 區塊（`app/pages/roi.vue`）。

### 已完成：候選方向 3——XGBoost 也拆成 per-district，驗證了「市區改善最多」的推論

`ml/src/evaluate.py` 加了 `confusion_by_district`，用 `features.parquet` 本來就有的 `district` 欄位分組（不用重算，跟規則 baseline 的站點/行政區對應關係一致），輸出 `ml/output/test_evaluation_by_district.json`，合併進 `app/data/model-evaluation.json` 的 `test.byDistrict`，並接進 `roi.vue`（模型 F1 卡片現在也跟著行政區選單換算，跟規則基線卡片行為一致）。

**結論：先前「baseline 在市區誤報特別多，ML 應該在市區進步最多」的推論成立，但小站區反而會被 ML 拖累**（60分鐘視野，依站數排序）：

| 行政區 | 站數 | Baseline Precision | 模型 Precision | Baseline F1 | 模型 F1 | F1 差異 |
|---|---:|---:|---:|---:|---:|---:|
| 板橋區 | 221 | 30.9% | 32.8% | 39.4% | 42.8% | **+3.4pp** |
| 新莊區 | 137 | 25.6% | 28.1% | 31.9% | 35.4% | **+3.5pp** |
| 三重區 | 135 | 25.7% | 28.7% | 32.0% | 36.3% | **+4.3pp** |
| 新店區 | 125 | 29.0% | 30.1% | 36.1% | 37.8% | +1.7pp |
| 中和區 | 115 | 24.0% | 28.6% | 29.0% | 34.4% | **+5.4pp** |
| 土城區 | 100 | 28.9% | 32.1% | 34.8% | 40.2% | **+5.4pp** |
| 林口區 | 94 | 21.9% | 25.7% | 26.6% | 30.3% | +3.7pp |
| 石碇區 | 4 | 96.4% | 36.4% | 96.7% | 12.2% | **−84.5pp（崩潰）** |
| 貢寮區 | 3 | 27.8% | 33.3% | 27.8% | 9.5% | −18.3pp |
| 雙溪區 | 2 | 22.2% | 9.3% | 26.7% | 14.5% | −12.2pp |
| 烏來區、石門區 | 2、5 | 0% | 0% | 0% | 0% | 持平（6月無事件） |

規律很清楚：**站數 ≥ 約25站的行政區，模型幾乎全面改善 precision 與 F1**（泰山26站也是+2.7pp/+2.0pp），站數愈多改善愈穩定；**站數個位數的行政區，模型經常比規則 baseline 差，甚至像石碇區這種原本 96.7% F1 的地方直接崩潰到 12.2%**——這些小站區的訓練樣本太少，XGBoost 學不出可靠的站點特有規律，規則 baseline 的「直接算歷史平均」反而更穩健。前端已加註記：選到站數 <20 的行政區時，UI 會提示樣本太少不適合直接判斷模型好壞。

### 已完成：候選方向 1——加鄰站缺車風險特徵，60分鐘視野重訓

**動機**：用既有的 `lowBikesRate`/`lowDocksRate`（`ml/output/station-time-profile-all.csv`，門檻 = max(2, ceil(總車柱數×0.1))）做了一次不重跑 F1 的探索性分析（`app/scripts/analyze-high-risk-stations.mjs`，輸出在 `docs/_scratch/`，不進版控），找出全站 combinedRisk 前60名高風險站，並用 300m／500m 半徑做地理分群。統計發現：**群內站點兩兩配對，缺車尖峰時段的命中率 51.5%，遠高於隨機基準 22.6%（約2.3倍）；滿柱尖峰時段命中率 14.8%，跟隨機基準 15.7% 幾乎相同（無相關）**。也就是缺車有地理群聚性，滿柱沒有。

**實作**：`ml/src/build_neighbors.py` 用 `app/data/operational-roi.json` 的經緯度算出 300m 內站點兩兩配對（1,577站、3,646條有向邊）。`ml/src/features.py` 新增 `neighbor_low_bikes_rate`／`neighbor_count`——某站在每個時間點，其300m內鄰站「同一時刻」有多少比例也在缺車（同時刻，非未來資訊，不算洩漏）。只加缺車不加滿柱鄰站特徵，因為驗證過滿柱沒有地理相關性，加了大概率是雜訊。

**60分鐘視野重訓結果**（`ml/src/train.py 60` → `threshold.py 60` → `evaluate.py 60`）：

| | 規則 Baseline | XGBoost（無鄰站特徵） | XGBoost（加鄰站特徵） |
|---|---:|---:|---:|
| F1 | 34.8% | 38.0% | **38.4%** |
| Precision | 28.4% | 30.8% | **32.2%** |
| Recall | 45.0% | 49.7% | 47.5% |

Precision 對 baseline 的提升從 +2.4pp 拉大到 +3.8pp（原本最弱的地方）；`neighbor_low_bikes_rate` 的 feature importance（gain）排全部20個特徵的第4名，僅次於 available_bikes/available_docks/bike_ratio，高於 station_id 本身，證實這個訊號有用。**30分、120分視野尚未用新特徵重訓**（`train.py`/`threshold.py`/`evaluate.py` 都已支援指定單一視野跑，不用整套重來）。

**針對「有地理相關性的11個群組」單獨驗證**（500m半徑，`app/scripts/evaluate-forecast.mjs` 新增可選的 cluster 分組評估、`ml/src/evaluate.py` 對應新增 `confusion_by_cluster`，都是讀 `ml/output/cluster_membership.csv` 這份站點→群組對照表）：

| 群組 | 站數 | Baseline F1 | 模型 F1 | F1 差異 | Precision 差異 |
|---|---:|---:|---:|---:|---:|
| 土城區_2站 | 2 | 35.4% | 46.4% | **+11.0pp** | +11.4pp |
| 板橋區_2站 | 2 | 32.1% | 38.3% | +6.2pp | +3.9pp |
| 土城區_2站(另一組) | 2 | 26.2% | 31.6% | +5.4pp | +6.0pp |
| 板橋區_2站(另一組) | 2 | 56.5% | 62.2% | +5.7pp | +5.8pp |
| 新莊區_2站(另一組) | 2 | 60.8% | 64.3% | +3.5pp | +5.0pp |
| 新莊區_2站 | 2 | 43.7% | 46.1% | +2.4pp | +2.0pp |
| 三重區_3站 | 3 | 46.4% | 50.0% | +3.6pp | +1.4pp |
| 板橋區_6站（江子翠站群） | 6 | 56.6% | 59.3% | +2.7pp | +1.4pp |
| 板橋區_5站 | 5 | 39.0% | 41.8% | +2.8pp | -0.1pp |
| 新店區_11站 | 11 | 42.6% | 44.6% | +2.0pp | +1.6pp |
| 永和區_3站 | 3 | 49.7% | 50.1% | +0.4pp | -0.3pp |

**11群全部 F1 提升，10群 Precision 提升**，比行政區拆分乾淨很多（沒有出現像石碇區那種崩潰）——因為這些群組本來就是「經統計驗證有地理相關性」的子集，正好是這個新特徵設計要捕捉的族群。

**為什麼有些群組（永和3站、新店11站、板橋5站）效益比較小？** 算了兩個相關係數（n=11，樣本少，只能當傾向不能當定律）：baseline F1 vs 提升幅度的相關係數 **-0.41**、站數 vs 提升幅度 **-0.42**，都是中度負相關——大致支持「baseline 原本就準的群、天花板效應」與「站數多、異質性高的大群組，鄰居平均訊號被稀釋」兩個假說，但都不是決定性的（例如板橋區_2站 baseline F1 已高達56.5%卻仍拿到+5.7pp，打破天花板假說）。11個群組的樣本數不足以下更精確的結論。

### 已完成：單站層級評估擴大到全部站別

原本只有60個高風險站有單站 baseline/模型 F1（見上節），發現這帶出一個容易誤判的陷阱：**平溪國中自己的baseline F1是0%，但它所屬的平溪區整體是97.3%**——區平均會完全蓋掉單站問題。原因深挖後發現是資料層面的，不是模型問題：平溪國中每天固定 18:00-06:00「雙0」（bikes=0 且 docks=0，正確被既有邏輯排除為停運，不算真事件），6月剩下的12小時營運時段內完全沒發生過一次真實缺車/滿柱事件，所以precision/recall都是0/0的邊界情況，不代表baseline預測失準。

因此把 `cluster_membership.csv` 從60站擴大到全部1,577站（`evaluate-forecast.mjs`/`evaluate.py` 的 group-by 機制本來就支援任意分組，改成「每站對應自己」即可，不用另外寫邏輯），輸出 `app/data/forecast-evaluation-clusters.json`（1,565站，1.5MB）與合併後的 `app/data/station-risk-evaluation.json`（1,565站，726KB）。ROI頁面選任何一個站都能看到該站自己的 baseline／模型數字，並在事件數為0或警報數為0時明確標示是邊界情況。

### 已嘗試但失敗：候選方向 2／3——把歷史規律直接餵給模型（兩種包裝都失敗）

**方法A：訓練期 station×slot 歷史統計 + baseline 合成風險分數（stacking）**——把 `station-time-profile-train.csv` 的 emptyRate/fullRate（依 target slot 查表，train-only 不會洩漏），加上完整複刻 `forecastRisk()` 公式算出的 `baseline_empty_risk_60`/`baseline_full_risk_60` 合成分數，一起餵給模型。結果：**訊號強到主宰所有樹的分裂**（gain遠超過其他全部特徵總和），模型只跑250棵樹就 early stop（原本要3400+棵），**測試F1直接退回34.8%，等於跟純規則baseline打平**——模型學會的是「複製baseline」而不是「修正baseline」。

**方法B：改成離散的「站點自己的尖峰窗」旗標**——不給連續機率值，改成「這個時段是否落在這站自己的歷史尖峰窗內」（`ml/src/build_station_peaks.py`，7個時段桶×工作日/假日分開算，train-only）。這次沒有崩潰（3000+棵樹、feature importance沒有失控主導），但**淨效果持平偏負**：F1 38.3%→38.1%，Precision 32.1%→30.8%。

**結論**：`station_id` + `slot` 這兩個類別特徵，配合幾千棵樹的集成，本來就能學出「這站在這時段容易怎樣」的規律——不管是用連續分數還是離散旗標，把「同一站自己的歷史規律」重新包裝餵回去都是提供模型已經學得到的資訊，沒有新增，甚至因為訊號權重分配問題而擠壓其他特徵的學習空間。**鄰站特徵之所以有效，關鍵在於它是「其他站當下的即時狀態」——station_id/slot 這兩個特徵本質上學不到的外部資訊。** 這對後續加特徵有指導意義：只有「模型自己學不到的外部資訊」才值得加，「同一站自己的歷史統計」不用刻意餵，模型已經內化了。

兩次嘗試都已還原（`ml/src/train.py`/`evaluate.py` 內用 `INCLUDE_STACKING_FEATURES`/`INCLUDE_PEAK_WINDOW_FEATURES` 兩個開關控制，目前都設為 `False`），程式碼保留供之後想調參重試時參考，不刪除。目前正式模型仍是**純鄰站特徵版本：F1 38.4%、Precision 32.2%、Recall 47.6%**。

### 下一步：2 個可選方向（尚未決定，待討論）

1. **把 30分、120分視野也重訓加上鄰站特徵**（目前只有60分鐘視野有這個特徵）。
2. **先接受現有結果，直接往下做**：全站 F1／Precision 都已改善，且對「有地理相關性的站群」效益特別顯著、特別乾淨；「同一站自己的歷史規律」這個方向已測試兩種包裝法都無效，不建議再投入。小站區（單站或無鄰站者）可以規則 baseline 跟模型並用（依站數切換，門檻仍待決定，見 [[xgboost-vs-baseline-district-tradeoff]]）。

### 可討論的方式（已測試，結論見上）:
如果總車柱數=m,可借車數=n,可還車數k=m-n, n為可設定的參數
- 先定義目前所有站點時常缺車(n<=2)或是滿車(k<=2),先計算各站點每星期幾的每個時段,看是否有規律(是否需要考慮假日).找出不管缺車或是滿車時常低於平均值的站別,針對這些站別來優化,看看是否能提升整體F1值,也就是現有的baseline預測適合人數少或是站數少的行政區,但是多的站別則使用模型來協助

> 這個想法對應到上面「候選方向2/3」的實測：把每站自己的歷史缺車/滿柱規律（不管是連續分數還是離散尖峰窗旗標）額外餵給模型，兩種包裝法都沒有讓F1提升，反而略微退步或直接崩潰退回baseline水準。根本原因是模型透過 `station_id`+`slot` 兩個類別特徵配合大量樹的組合，本來就已經能學到「這站這時段容易怎樣」，重複餵同樣的資訊不會加分。這個方向已驗證完畢，不建議繼續深挖；「現有baseline適合小站區、模型適合大站區」的並用策略（見上方「已完成：驗證3個可選方向之1」小節與 `xgboost-vs-baseline-district-tradeoff` 記憶）仍然成立且已證實有效，是目前該採用的混合策略。


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



Baseline層（12小區，63,059筆）	XGBoost層（17大區，2,117,596筆）	混合系統整體
F1	70.3%	38.0%	38.6%
Precision	69.3%	31.7%	32.3%
Recall	71.3%	47.3%	47.9%



按「不用重訓 / 成本低 / 成本高」排序，四個可行方向：

1. 分群調閾值（零成本，馬上能試）
目前 60分鐘視野全站共用同一個閾值 0.84，是在驗證集上對「全部站」最大化F1選出來的。但17個XGBoost層的行政區彼此base rate差很多（板橋 vs 泰山），共用一個閾值不是最優解。改成對每個行政區（或至少對 XGBoost 層）在驗證集上各自選一次閾值，不用重訓模型、幾分鐘內就能跑完，是目前最便宜的免費午餐。

2. 把規則 baseline 自己的風險分數當成模型的輸入特徵（stacking）
evaluate-forecast.mjs 的 forecastRisk() 算出來的 emptyRisk/fullRisk 本身就是「歷史站點×時段統計」的濃縮結果。與其讓 XGBoost 自己從 lag/momentum 重新摸索這個規律，不如直接把 baseline 算出來的分數當一個新特徵餵給它——model 學的是「baseline 什麼時候可信、什麼時候該用即時訊號修正它」，這通常比重新學一次歷史規律更有效率，而且 baseline 的計算邏輯已經現成。

3. 加入 station-time-profile 的訓練期歷史統計特徵（原本列的候選3，還沒做）
ml/output/station-time-profile-*.csv 已經有現成的訓練期統計，只是還沒接進 features.py。這是最直接針對「baseline 的訊號模型能不能學到」這件事，預期對 precision 幫助最大，因為這是baseline唯一依賴的資訊來源。跟第2點方向類似但更細緻（每站每時段一個數字 vs 用baseline算出來的合成分數），可以挑一個先試,或兩個一起做互相印證。

4. 精準度優先的閾值選擇準則
目前 threshold.py 選閾值的準則是「純最大化F1」。可以改成「在 precision ≥ 某個下限（例如35%）的限制下最大化F1」，直接針對「Precision 明顯高於baseline」這句判準去優化，而不是任由F1自動決定要犧牲多少precision換recall。這個也是零成本，只要改 select_threshold 的排序邏輯重跑。

建議順序：先做 1（幾分鐘驗證有沒有用），如果有感再做

1. N-Beat VS xBGoost
2. 增加 TFT (加上時間序列特徵,weather, holiday, etc)

### 已嘗試但失敗：候選方向 N-BEATS（純時間序列模型，單站獨立訓練）

用 top15 缺車率最高的站，各自獨立訓練 N-BEATS（generic、from-scratch、PyTorch），60分鐘視野，跟規則基線/XGBoost 同一批站做逐站比較。

結果：N-BEATS 在 14/15 有效比較的站全部墊底（13站三者最差、1站略贏 XGBoost 但仍輸基線）。平溪國中是 0/0 邊界情況三者同。

| 站點 | 規則基線 F1 | XGBoost F1 | N-BEATS F1 |
|---|---|---|---|
| 新北捷運環狀線南機廠 | 43.5 | 53.4 | 33.7 |
| 金城裕民路口 | 30.0 | 26.1 | 28.3 |
| 台水新莊服務所 | 59.8 | 60.6 | 51.7 |
| 中正思源路口 | 61.7 | 66.1 | 53.5 |
| 捷運七張站 | 51.8 | 55.2 | 43.4 |
| 捷運十四張站 | 37.1 | 40.3 | 29.7 |
| 捷運大坪林站 | 51.3 | 56.0 | 47.7 |
| 板橋戶政事務所 | 32.9 | 38.0 | 27.7 |
| 忠誠里 | 47.6 | 52.7 | 28.9 |
| 中正民權路口 | 33.3 | 33.5 | 24.4 |
| 文化路二段182巷 | 65.9 | 72.3 | 66.2 |
| 捷運新埔站 | 57.8 | 61.8 | 53.0 |
| 十分遊客中心 | 22.2 | 25.0 | 21.1 |
| 捷運新北產業園區站 | 44.6 | 50.2 | 34.3 |

判讀：
1. 滿柱（docks==0）事件太稀有，N-BEATS 的驗證期門檻搜尋幾乎都選到「永不觸發」（`threshold=-0.5, val F1=0.000`），滿柱這條線基本失能。
2. 單站獨立訓練、純時間序列——完全看不到鄰站狀態、跨站共用的 station_id 樹狀切分等 XGBoost 已證實有效的資訊。
3. 單站訓練樣本量（train ~5,700 筆）對深度網路偏薄，XGBoost 在這種中小型表格資料上本來就有優勢。

結論：問題出在架構本身（單站獨立、無跨站資訊、對稀有事件不敏感），不是樣本數不夠，所以沒有繼續擴大到 60 站或做 global N-BEATS，改試 TFT（見下）。程式碼保留在 `ml/src/train_nbeats.py`，輸出 `ml/output/nbeats_evaluation.json`。

### 已嘗試但同樣落後：候選方向 TFT（Temporal Fusion Transformer，加天氣/假日特徵）

跟 N-BEATS 不同，TFT 是跨站共用權重的 global model（`station_id` 當 static categorical），同一批 top15 站一起訓練。特徵：own history（bikes/docks）+ 天氣（`docs/_scratch/weather_hourly.csv`，兩站平均展開成30分鐘格）+ `is_holiday`/`is_workday`（`docs/_scratch/calandar.md` 的6段日期）+ slot/weekday 的 sin/cos 週期編碼。用 `pytorch-forecasting` 的 `TemporalFusionTransformer`，60分鐘視野，Jan-Apr train / May 選閾值 / June test，跟其他模型同一凍結切分。

因為是 global model，沒有做逐站拆分，直接看 15 站合併（pooled）的結果，跟 baseline / XGBoost 同樣把這15站的 tp/fp/fn/tn 加總比較：

| | Precision | Recall | F1 |
|---|---|---|---|
| 規則基線（pooled） | 37.7% | 75.5% | 50.3% |
| XGBoost（pooled） | 42.7% | 75.7% | **54.6%** |
| TFT（pooled） | 36.6% | 51.4% | 42.8% |

TFT 一樣兩者都輸，但輸的原因跟 N-BEATS 不同：
1. Precision 其實跟基線差不多（36.6% vs 37.7%），問題主要出在 **Recall 只有 51.4%**，比基線/XGBoost 的 75% 低了 24 個百分點——閾值搜尋出來的模型明顯偏保守，漏掉大量真實事件。
2. 滿柱（docks）目標的驗證期 F1 只有 0.111，比 N-BEATS 的 0（完全失能）好一點但仍然很弱，稀有事件對這兩種深度模型都是共同弱點。
3. 跨站共用權重確實比 N-BEATS 的單站獨立訓練好上一截（pooled F1 42.8% vs N-BEATS 各站多半在 20-35% 之間），驗證了「有跨站資訊」的方向是對的，但目前這個小 hidden_size（16）、CPU-only、僅12 epoch 的設定還沒能追上 XGBoost。

結論：兩個深度學習方向（N-BEATS、TFT）目前都輸給 XGBoost，且 XGBoost 額外具備「不用GPU、訓練快、可解釋」的優勢。除非有人手/算力可以繼續調 TFT（更大 hidden_size、更多 epoch、GPU），否則現階段建議維持 XGBoost + 規則基線的混合部署策略，不繼續往深度學習方向投入。程式碼保留在 `ml/src/train_tft.py`，輸出 `ml/output/tft_evaluation.json`。

### 目前所有模型測試結果總覽（2026-08-28 整理）

#### 1. 全站規則基線 F1 分布（1,565站，60分鐘視野）

| F1 區段 | 站數 | 佔比（排除0/0後） |
|---|---|---|
| ≥80% | 3 | 0.2% |
| 60%~80% | 31 | 2.1% |
| 40%~60% | 237 | 15.8% |
| 20%~40% | 768 | 51.2% |
| 0%~20%（有真實事件） | 460 | 30.7% |
| 0/0 邊界情況（測試期無真實事件，不算F1） | 66 | — |

過半數站落在 20%~40%，加上 0%~20% 超過 8 成站點 baseline F1 低於 40%。F1≥60% 的站只有 34 站（2.3%），是極少數。

#### 2. 全站合併版（缺車+滿車 issue，60分鐘，1,565站）

| | Precision | Recall | F1 |
|---|---|---|---|
| 規則基線 | 28.4% | 45.0% | 34.8% |
| XGBoost（含鄰站特徵） | 32.2% | 47.6% | **38.4%**（+3.6pp） |

#### 3. 缺車單獨（不含滿車），限定 baseline 60分鐘合併F1≤60% 的 1,469 站

用既有已訓練 `model_60.json`（含鄰站特徵），只重新在驗證集挑一次閾值（因為 target 從 issue 換成 empty），未重訓模型。

| | Precision | Recall | F1 |
|---|---|---|---|
| 規則基線（threshold=0.4，沿用系統既有值） | 26.9% | 49.4% | 34.8% |
| XGBoost（threshold=0.85，針對這個target重選） | 30.5% | 47.4% | **37.1%**（+2.3pp） |

腳本：`ml/src/evaluate_lowf1_bikeshortage.py`，輸出 `ml/output/lowf1_bikeshortage_evaluation.json`。

#### 4. N-BEATS vs TFT vs XGBoost，逐站/pooled（top15_bikerisk，見上方兩節完整表格）

- N-BEATS（單站獨立訓練）：14/15 站全部墊底，兩者都輸。
- TFT（跨站 global model，加天氣+假日特徵）：pooled F1 42.8%，比 N-BEATS 好但仍輸 baseline（50.3%）與 XGBoost（54.6%）。

#### 5. 嚴重度分層（complete=完全缺車 n=0 / near=即將沒車 n≤2），限定 baseline F1<40% 的 5 站（top15_bikerisk 子集）

規則基線刻意不重算，維持原定義。N-BEATS/TFT 重訓為缺車單一目標（不含滿車），三模型都用各自驗證集挑過的閾值。

| | complete (n=0) F1 | near (n≤2) F1 |
|---|---|---|
| XGBoost | **35.9%**（P26.4/R56.3） | **61.3%**（P52.7/R73.1） |
| N-BEATS | 28.1%（P23.2/R35.7） | 55.6%（P46.0/R70.4） |
| TFT | 24.8%（P15.4/R62.9） | 54.7%（P49.3/R61.4） |

XGBoost 在兩個嚴重度層級都領先，`near`（早期預警）門檻的三個模型 F1 都比 `complete`（嚴格等於0）高出一大截，代表「即將缺車」這個較寬鬆的定義本身就更容易預測準確，可以考慮作為警報系統的實際觸發條件（比等到真的空了才報快一步）。

腳本：`ml/src/evaluate_severity_tiers.py`，輸出 `ml/output/severity_tier_evaluation.json`，站點清單 `docs/_scratch/lowf1_bikerisk.csv`（baseline F1<40%）與 `docs/_scratch/lowf1_60_all.csv`（baseline F1≤60%，1469站）。

**總結論**：目前所有嘗試（全站、低F1子集、不同嚴重度定義）都指向同一個結論——XGBoost（含鄰站特徵）穩定小幅領先規則基線，兩個深度學習方向（N-BEATS單站、TFT跨站）都還打不過 XGBoost。建議維持 XGBoost + 規則基線的混合部署，`near`(n≤2) 早期預警門檻值得納入警報系統設計討論。

### 即時 XGBoost 缺車/滿車警報：為什麼現在只能手動 demo，以及 AWS 上怎麼平移

**目標**：營運總覽頁面加 Baseline/XGBoost 切換，XGBoost 模式下對「baseline 60分鐘F1≤60%」的站（既有混合部署門檻，見上方「已完成：候選方向1」與 `xgboost-vs-baseline-district-tradeoff` 記憶）改用 XGBoost 算 30/60分鐘的缺車/滿車風險，並用整數（無條件進位）顯示要補幾台車、要拉幾台車，用類似購物車的懸浮警報 icon（Warning-30／Warning-60）呈現。

**卡關點：模型檔案太大，塞不進純靜態的 Cloudflare Pages。**

把 `model_30.json`/`model_60.json` 匯出成瀏覽器能讀的格式後，實測分別是 **80MB／134MB**——主因是 `station_id` 有 1,569 種類別，很多樹節點在對 station_id 做類別分裂時得存下多達一千多個候選類別代碼，撐大了檔案。這遠遠超過 Cloudflare Pages 單一靜態資產 25MiB 的硬上限（就是先前 `station-details.bin` 卡住部署的同一個限制），瀏覽器也不可能為了算風險分數下載這麼大的檔案。

過程中還修正了一個關鍵 bug：手刻的 JS/Python 樹狀模型辨識器，一開始把「類別分裂時，特徵值有在類別清單裡」的方向搞反了（應該是走右子節點，不是左子節點）。修正後用500筆測試資料對照官方 `predict_proba()`，機率誤差降到平均0.25個百分點、最大約3.8個百分點（殘餘誤差來自 XGBoost 內部用 float32、比較切分門檻時的浮點精度差異，屬已知且可接受的小落差）。這套驗證過的樹狀分裂邏輯，程式碼在 `ml/src/validate_tree_walker.py`。

**現階段（純靜態 Cloudflare Pages）做法：本機手動觸發 demo**

新增 `npm run predict:xgboost`（`ml/src/export_model_for_web.py` 匯出模型 + 一支 Node 腳本讀取匯出檔跑推論），流程：

1. 抓一次官方即時資料
2. 只對 `app/data/station-risk-evaluation.json` 裡 baseline 60分鐘 F1≤60% 的站（既有混合部署站清單）算 XGBoost 風險分數（30分鐘用 `model_30.json`，18個特徵、無鄰站特徵；60分鐘用 `model_60.json`，20個特徵、含鄰站特徵）
3. 鄰站缺車率用即時資料現場算（300m半徑，跟 `ml/src/build_neighbors.py` 同一套邏輯）；lag特徵這次demo沒有歷史快照可用，一率視為缺值——XGBoost樹本身就有缺值繞行邏輯（`default_left`），不會噴錯，只是準確度會比有完整lag特徵時低
4. 輸出一份小的靜態 JSON（`app/public/data/xgboost/live-predictions.json`，只含預測分數與整數台數建議，不含134MB的模型本身）
5. 這份小 JSON 手動 commit 進版控、正常部署——網友看到的是「你最後一次手動跑的結果」，不是每次刷新都重新推論

`model_30.json`/`model_60.json`（134MB/80MB）**不進版控**，只留在本機/CI環境跑這支腳本用。

**之後如果要部署到 AWS，可以怎麼平移**

Cloudflare Pages 這個 25MiB 限制是「純靜態託管平台」特有的，AWS 上有真正的伺服器端運算，完全不需要現在這種「手動觸發、寫死小JSON」的變通做法：

| | 現況（Cloudflare Pages） | AWS 平移後 |
|---|---|---|
| 模型存放 | 不能進版控/部署（134MB > 25MiB上限） | **S3**，沒有這種檔案大小限制 |
| 推論引擎 | 手刻的 JS/Python 樹狀模型辨識器（有已知的浮點精度誤差） | 直接用**正牌 Python `xgboost` 套件**的 `predict_proba()`，類別特徵原生正確處理，沒有精度誤差問題 |
| 觸發方式 | 人工手動跑 `npm run predict:xgboost`，結果是靜態快照 | **Lambda + API Gateway**：Lambda 冷啟動時從 S3 載入模型進記憶體，前端每次打 API 即時算最新風險分數，做法跟現有 `useLiveDashboard` 呼叫官方即時資料的模式幾乎一樣，只是多一個真的會跑 XGBoost 的後端端點 |
| 更新頻率 | 只在手動觸發那一刻 | 可以做到跟官方即時資料一樣「每次刷新都算最新」 |

也就是說：現在的手動demo版本完全可以直接沿用同一套特徵計算邏輯（鄰站300m即時缺車率、混合部署站點清單、整數補車/拉車台數），差別只在於「用 Node 手刻樹狀模型辨識器」換成「用 Lambda 跑正牌 Python xgboost」，以及「手動觸發存靜態檔」換成「即時 API」。兩邊都能重用同一批已經驗證過的 `ml/output/model_{30,60}.json`。