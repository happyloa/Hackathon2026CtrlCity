# 共享單車站點供需預測研究報告：業界與學術界作法

> **與目前 Demo 的關係**：本文件整理下一階段可驗證的資料與模型方向。現行 Demo 尚未使用鄰站圖關係、天氣、OD、明確服務狀態、調度紀錄或 GNN；目前僅以即時庫存結合同站歷史時段基線產生啟發式風險指標，所有調度建議均需人工覆核。

**研究日期：** 2026-08-06
**研究範圍：** 站點式共享單車/機車系統（如 YouBike、Citi Bike、Divvy、Capital Bikeshare、Bicing 等）的站點層級供需預測（空/滿事件預測、調度預測），聚焦於：預測目標形式、特徵/影響因素、模型作法、評估方式、維修停運資料缺口處理。
**方法：** 優先搜尋一級來源——(1) 學術論文（arXiv、KDD/ACM DL、ScienceDirect、PLOS ONE、Springer 等同儕審查期刊/會議論文原文或官方摘要頁）；(2) 業界/官方技術規格（GBFS 通用共享單車資料規格，由 MobilityData 維護，是 Citi Bike/Divvy/Capital Bikeshare 等系統實際採用的資料標準）；(3) 台灣政府開放資料與新北市政府交通局委託之自行研究報告。凡只能找到二手轉述、無法追溯或驗證原文內容者，皆於文中明確標註「未找到一級來源佐證」。部分論文因 PDF 二進位格式無法被本次工具鏈解析全文，僅能引用其摘要頁（abstract page）內容，已在條目中註明。

---

## 1. 常見的預測目標形式

業界與學術界對「站點供需預測」的定義並不一致，大致可分為四種目標形式：

- **迴歸（連續值）**：直接預測未來某時間窗的可借車數 / 可還位數，或淨流量（net flow = 到達數 − 離開數）。GCNN-DDGF 論文即以「站點每小時需求量（迴歸）」為目標，使用 RMSE、MAE、R² 評估 [Predicting Station-level Hourly Demands in a Large-scale Bike-sharing Network: A Graph Convolutional Neural Network Approach](https://arxiv.org/pdf/1712.04997)。
- **分類（空/滿事件機率）**：預測站點在未來時間點是否進入「關鍵狀態」（critical / non-critical，即無車可借或無位可還），而非連續數值。STOP（STation Occupancy Predictor）框架即以此為目標，使用 Bayesian 與 associative classifier 對 NYC 資料進行分類預測——[Predicting critical conditions in bicycle sharing systems](https://link.springer.com/article/10.1007/s00607-016-0505-x)（該頁面因登入牆無法取得全文，僅能引用其摘要層級描述，內容經搜尋引擎摘要片段驗證，**建議讀者自行查證全文**）。
- **淨流量與到達/離開速率分離建模**：部分研究不直接預測庫存數，而是分別建模「到達率」與「離開率」，再合成淨流量，用以指導調度。KDD 2016 論文提出以多來源資料（天氣、事件等）優化調度的框架 [Rebalancing Bike Sharing Systems: A Multi-source Data Smart Optimization](https://www.kdd.org/kdd2016/papers/files/rfp0553-liuAemb.pdf)（PDF 內容因編碼問題本次無法完整解析，僅能確認其存在於 KDD 2016 官方論文集，建議直接查閱原文）。
- **超額需求（excess demand）建模**——這是一個容易被忽略但很關鍵的目標形式：觀測到的借還記錄本身有偏差，因為「站點沒車時的借車嘗試」根本不會被系統記錄下來。PLOS ONE 的論文明確指出「excess demand」（未被觀測到的租借嘗試，因無車可借而未發生）需要被建模，而非只用觀測到的歷史交易量訓練模型；他們用 **Skellam regression**（直接建模兩個高相關 Poisson 分布之差）預測「淨總需求」，並證明「用總需求（觀測值+推估的超額需求）訓練，比只用觀測值訓練的預測效果顯著更好」[Excess demand prediction for bike sharing systems](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0252894)。**這對我們專案是重要提醒**：我們手上的歷史資料本質上也只是觀測值，尖峰時段「借不到車」的真實需求量可能被系統性低估。

## 2. 常見的特徵/影響因素清單

### 2.1 時間類（時段、星期、假日）
幾乎所有論文都將時間特徵作為基礎輸入：時段（hour-of-day）、星期（day-of-week）、假日旗標。多篇論文用週期性編碼（sin/cos）表示日、週、年週期性，例如 [ST-BDP 模型](https://pmc.ncbi.nlm.nih.gov/articles/PMC11623223/) 使用 sine/cosine 訊號捕捉日、週、年週期。Context-aware 論文將此類特徵歸類為「calendrical context」[Context-aware demand prediction in bike sharing systems](https://arxiv.org/abs/2105.01125)。

### 2.2 天氣類
- 常用變數：溫度、降雨、濕度、風速/風向、氣壓、天候狀況（晴/雨/雪）。ST-BDP 論文具體使用「溫度、露點、濕度、風速/風向（轉為向量）、氣壓、降雨量」（來自機場氣象站資料）[A bike-sharing demand prediction model based on Spatio-Temporal Graph Convolutional Networks](https://pmc.ncbi.nlm.nih.gov/articles/PMC11623223/)。
- 天氣對「極端/劣化天候」下的預測誤差影響特別顯著：一篇 2024 年論文專門處理「劣化天候情境」下的圖神經網路預測，發現**加入天氣資料可將劣化天候情境下的預測誤差降低超過 20%** [Contextual Data Integration for Bike-sharing Demand Prediction with Graph Neural Networks in Degraded Weather Conditions](https://arxiv.org/abs/2412.03307)。
- COVID-19 期間的研究也將天氣（溫度、降雨、風速、相對濕度）與時間特徵並列為輸入，並發現「疫情後各社群的整體需求皆低於疫情前，且失去了原本通勤尖峰的模式」[Bike-Sharing Demand Prediction at Community Level under COVID-19 Using Deep Learning](https://pmc.ncbi.nlm.nih.gov/articles/PMC8838375/)。

### 2.3 空間類（鄰近站點、路網結構）
這是近年學術界最活躍的方向——**站點需求不是獨立的**，鄰近站點的借還會互相影響：
- Context-aware 論文明確將「spatial context：高/低負載站點如何影響鄰近站點」列為核心貢獻之一 [Context-aware demand prediction](https://arxiv.org/abs/2105.01125)。
- GCNN-DDGF 論文用「資料驅動的圖過濾器（data-driven graph filter）」自動學習站點間隱藏的異質性相關（而非只用地理距離），並用四種不同的鄰接矩陣建構方式（空間距離、需求相關性、平均行程時間等）比較 [GCNN-DDGF](https://arxiv.org/pdf/1712.04997)。
- ST-BDP 論文用 Tobler 地理學第一定律（距離越近影響越大）建構需求圖的邊權重 [ST-BDP](https://pmc.ncbi.nlm.nih.gov/articles/PMC11623223/)。
- 多篇論文指出「多數既有方法依賴預先定義的空間相關性（如地理距離），限制了模型表現」，因此近期方法改用動態學習的圖結構（如 Multi-Task Dynamic Graph-based Network）[Predicting short-Term bike-Sharing demand at station level: A multi-Task dynamic graph-based spatiotemporal approach](https://www.sciencedirect.com/science/article/pii/S0950705125020246)。

### 2.4 站點屬性類
站點本身的物理與地理類型屬性（車柱數/容量、鄰近捷運站/校園/商圈/住宅區等地理類型）常被作為靜態特徵或用於分群。COVID-19 論文用 Louvain 演算法將 671 個站點分成 6 個「社群（community）」，而非逐站建模，理由是**降低雜訊並考量站點間交互作用**[Bike-Sharing Demand Prediction at Community Level under COVID-19](https://pmc.ncbi.nlm.nih.gov/articles/PMC8838375/)。「捷運站周邊」是常見的特殊站點類型，一篇論文專門針對「捷運站周邊共享單車需求」設計 STAGCN 模型（[Demand prediction for shared bicycles around metro stations incorporating STAGCN](https://pmc.ncbi.nlm.nih.gov/articles/PMC12262888/)——本次未深入抽取全文細節，僅列為方向性佐證，**建議進一步查證**）。

### 2.5 維修/停運事件
見第 5 節專門討論。

### 2.6 活動/賽事等特殊事件
- 搜尋結果顯示「研究人員關注會影響單車使用的事件，例如球賽、演唱會等會暫時提升或降低使用量的情況，目標是改善預測演算法」，但本次搜尋**未能找到針對演唱會/馬拉松量化影響的一級來源論文**——這類「特殊事件」因素在文獻中常被提及為重要方向，但具體量化研究相對少見，**此點僅供參考，未找到強力一級來源佐證**。
- 相對而言，COVID-19 這類「大規模持續性特殊狀態」則有紮實的一級來源佐證（見 2.2 節），顯示「非常態日」對模式的破壞性影響是被廣泛驗證的現象，只是具體到「單場活動」層級的公開研究較少。

## 3. 常見的模型作法

| 類型 | 代表方法 | 優點 | 缺點/適用情境 |
|---|---|---|---|
| 統計/歷史平均 | ARIMA、歷史平均 | 簡單、可解釋、不需大量運算資源 | 無法捕捉空間相關性與非線性天氣效應；COVID-19 研究中作為 baseline，被深度學習模型全面超越（如 CNN-LSTM 的 MAE 3.00 vs ARIMA 明顯較差）[COVID-19 論文](https://pmc.ncbi.nlm.nih.gov/articles/PMC8838375/) |
| 機器學習 | XGBoost、神經網路（feed-forward） | 能處理非線性特徵交互，訓練/推論速度快於深度學習 | 在 PLOS ONE 的比較中，peak hour 表現不如專門設計的 Skellam regression，但整體仍是常見有力 baseline [Excess demand 論文](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0252894) |
| 深度學習（時間序列） | LSTM/GRU、CNN-LSTM（TreNet）、TCN | 捕捉長期時間依賴與非線性模式；COVID-19 論文中 CNN-LSTM 表現最佳 | 需要足夠訓練資料，且本身不處理空間相關性，須額外設計 |
| 深度學習（圖神經網路 GNN） | GCNN-DDGF、STGCN、ST-BDP、多圖卷積網路 | 直接建模「站點之間互相影響」的空間相關性，是目前學術界處理「鄰近站點交互作用」的主流做法；ST-BDP 論文報告其模型優於 12 個基準模型，且比 GCGRU 快 5.6 倍 [ST-BDP](https://pmc.ncbi.nlm.nih.gov/articles/PMC11623223/) | 模型複雜度高、訓練成本較高，需要建構圖結構（鄰接矩陣），若圖結構定義不當（如僅用地理距離）可能限制表現 [Multi-Task Dynamic Graph 論文](https://www.sciencedirect.com/science/article/pii/S0950705125020246) |
| 情境感知（Context-aware）RNN | 多層序列 LSTM + 歷史/前瞻情境遮罩 | 明確分離「歷史情境」與「前瞻情境」（如天氣預報）輸入層 | 論文自陳「並非所有情境感知帶來的改善都具統計顯著性」，顯示效果因情境類型而異 [Context-aware 論文](https://arxiv.org/abs/2105.01125) |

**重要提醒（來自一級來源的反直覺發現）**：預測準確度高，不代表調度決策就會更好。一篇論文明確指出「更準確的預測不必然轉化為更好的庫存/調度決策」，主張預測模型與調度優化模型必須「一起被評估與協調（harmonized），而非分開優化」[Predictive and prescriptive performance of bike-sharing demand forecasts for inventory management](https://www.sciencedirect.com/science/article/pii/S0968090X22000183)（原文全文因付費牆本次僅能取得摘要層級內容，建議查證 arXiv 版本 [2108.00858](https://arxiv.org/pdf/2108.00858) 全文）。**這對我們專案的啟示是：模型的 RMSE 表現好看，不代表產出的調度建議真的有用，最終仍要以「是否減少了空/滿事件」這類業務指標驗收。**

## 4. 常見的評估方式

### 4.1 統計/迴歸指標
RMSE、MAE、MAPE、SMAPE、R² 是迴歸型預測最常見的指標組合。多篇論文說明**選 RMSE 而非 MAE 作為主要指標的理由**：「RMSE 對大誤差的懲罰比 MAE 更重，這對共享單車調度而言至關重要，因為大幅度的低估或高估都可能直接導致空站或滿站」——此說法在多篇論文中被反覆強調，但本次搜尋主要是透過搜尋引擎聚合摘要取得，**未能定位到單一明確可引用的一級來源原文句子，標註為僅供參考**。ST-BDP 論文提供了具體數字可佐證跨模型比較的常見做法（MAE、MAPE、SMAPE、RMSE 並列比較 ST-BDP vs STGCN vs BiLSTM）[ST-BDP](https://pmc.ncbi.nlm.nih.gov/articles/PMC11623223/)。

### 4.2 分類/事件型指標
針對「空/滿事件」這種二元分類目標，STOP 框架採用分類器（Bayesian、associative classifier）進行「critical / non-critical」二分類 [STOP 論文](https://link.springer.com/article/10.1007/s00607-016-0505-x)（**同前述，本次僅取得摘要層級資訊，未能驗證其具體使用 precision/recall 或其他分類指標，建議查證全文**）。整體而言，本次搜尋顯示**多數已發表論文仍以迴歸指標（MAE/RMSE/MAPE）為主流**，而非直接針對空/滿事件的 precision/recall——這點值得我們專案注意：如果我們的目標是「預測會不會空/滿」這種分類問題，直接套用大多數論文的迴歸評估框架未必合適，需要自行設計以「事件」為單位的評估（例如：在該站點真的發生空站的時間段中，模型提前多久且以多高的準確率示警）。

### 4.3 業務/營運 KPI
- 「更準確的預測不代表更好的調度決策」這一發現本身即指出：**業界真正關心的最終指標，是調度成本、事件發生次數等營運 KPI，而非統計誤差**[Predictive and prescriptive performance 論文](https://www.sciencedirect.com/science/article/pii/S0968090X22000183)。
- GBFS 規格本身雖非預測評估方法，但其資料是所有「見車率」「見位率」等營運監控指標的基礎（見第 5 節）。新北市政府 2026 年重啟 30 分鐘免費方案首日的官方施政成果報導中，即使用「見車率 93%、見位率 99%」作為營運健康度的量化 KPI 範例 [新北市政府施政成果網](https://wedid.ntpc.gov.tw/Governance/Detail/bRpVL3n0P5qj)——顯示「見車率／見位率」是台灣本地既有的業務 KPI 慣例，與我們專案「預測會不會無車可借/無位可還」的目標高度呼應。

## 5. 維修/停運資料缺口的常見處理方式

這是我們專案特別需要注意的一點：**站點「顯示沒車」可能有兩種完全不同的原因——(a) 單純被借光了（真實需求訊號）、(b) 站點本身故障/維修/停止營運（非需求訊號，若誤當作需求特徵訓練模型會汙染資料）**。

業界標準做法（一級來源：GBFS 規格）給出了明確答案。**GBFS（General Bikeshare Feed Specification）由 MobilityData 維護，是 Citi Bike、Divvy、Capital Bikeshare 等主流系統實際採用的即時資料標準**，其 `station_status.json` 明確定義了區分兩種情境的欄位：

- `is_installed`：「站點目前是否實體裝設在路上（true/false）」
- `is_renting`：「站點目前是否可供租借車輛。**即使站點是空的，只要它原本允許租借，這個值就必須是 true**」
- `is_returning`：「站點目前是否可接受車輛歸還。**即使站點是滿的，只要它原本允許歸還，這個值就必須是 true**」
- `num_docks_disabled` / `num_vehicles_disabled`（v3.0 前為 `num_bikes_disabled`）：「站點內故障、無法使用的椿位/車輛數量」

引用來源：[General Bikeshare Feed Specification (GBFS) Reference](https://gbfs.org/documentation/reference/)、欄位細節另見 [MobilityData/gbfs GitHub Issue #94: Number of bikes and docks available during non service hours or out of service stations](https://github.com/NABSA/gbfs/issues/94)。

**這給我們專案的直接啟示**：
- 「可借車數 = 0」且「is_renting = true」代表真實的空站需求事件（值得預測）。
- 「is_renting = false」或「is_installed = false」代表站點本身停止服務（維修/搬遷/暫停營運），此時的「無車可借」是**系統性缺口**，不是需求訊號，應該從訓練標籤中剔除或另外標記，否則模型會把「維修停運」誤學成「正常需求模式的一部分」。
- 若我們拿到的新北市 YouBike 歷史資料**沒有**明確的「站點是否在服務中」旗標（題目描述的欄位是「時間、行政區、站名、總車柱數、可借車數、可還位數、經緯度」，並未提及服務狀態欄位），可以參考業界慣例，用「總車柱數為 0」「可借車數與可還位數同時長時間為 0（不像正常空站會被調度補車）」「該站點在資料中整段時間完全無變化（數值凍結）」作為間接判斷維修/停運的 heuristic——但**這是我們自行推論的處理建議，並非直接來自一級來源的既定作法，需標註為推論性建議**。

另外，Barcelona 共享單車系統 Bicing 的維修預測研究提供了另一個角度——**維修本身也可以被預測**：該論文結合「行程資料」與「維修工單資料」，用統計/機器學習/深度學習存活模型（survival model）預測車輛/元件何時需要維修，發現電動車與傳統車的使用模式差異「對維修需求有相當大的影響」[Cycling into the workshop: predictive maintenance for Barcelona's bike-sharing system](https://arxiv.org/abs/2404.17217)。這說明維修事件不只是「該剔除的雜訊」，本身也是一個有價值的次要預測目標（例如：可以反向利用「異常凍結的站點資料」去偵測疑似故障站點，提供給營運單位排查）。

Metro Bike Share（LA）公開資料頁面確認業界普遍會在站點資料表中標註 `Active`/`Inactive` 狀態，但**該頁面本身並未說明維修期間的行程資料如何被過濾**，此細節屬於「未找到一級來源佐證，僅供參考」[Metro Bike Share – Data](https://bikeshare.metro.net/about/data/)。

## 6. 台灣本地資料（新北市/台北市 YouBike）

搜尋過程中找到以下政府一級來源，但受限於本次工具鏈無法完整解析其 PDF 全文（PDF 為二進位壓縮流，本次環境無法轉換文字層），僅能引用透過搜尋引擎摘要片段驗證到的內容，**建議直接下載原始 PDF 人工查證細節**：

- 新北市政府 104 年度自行研究報告《公共自行車 YouBike 營運資料分析及精進作為》（研究機關：交通局；研究人員：葉燿墩、林昭賢、劉心荷）。摘要片段顯示：受訪者對 YouBike 不滿意的主因之一是「常常借不到車」，報告建議「檢討尖離峰無車可借及無車可還之系統性問題」「租借資料分析各站租借之尖離峰，加以優化調度路線或規劃機動支援之調度人員」。原文連結：[PDF](https://www.rde.ntpc.gov.tw/userfiles/ntpc/files/%E5%85%AC%E5%85%B1%E8%87%AA%E8%A1%8C%E8%BB%8AYouBike%E7%87%9F%E9%81%8B%E8%B3%87%E6%96%99%E5%88%86%E6%9E%90%E5%8F%8A%E7%B2%BE%E9%80%B2%E4%BD%9C%E7%82%BA(%E5%90%AB%E5%95%8F%E5%8D%B7).pdf)。
- 新北市政府 111 年度自行研究報告《新北市公共自行車（YouBike）1.0 及 2.0 雙核心服務》。僅確認其存在與標題，**本次未能取得可驗證的內文細節，標註為未找到一級來源佐證的延伸閱讀**：[PDF](https://www.rde.ntpc.gov.tw/userfiles/1160700/files/29_%E6%96%B0%E5%8C%97%E5%B8%82%E5%85%AC%E5%85%B1%E8%87%AA%E8%A1%8C%E8%BB%8A%EF%BC%88YouBike%EF%BC%891_0%E5%8F%8A2_0%E9%9B%99%E6%A0%B8%E5%BF%83%E6%9C%8D%E5%8B%99.pdf)。
- 新北市政府施政成果網：2026 年重啟 30 分鐘免費方案首日「總租借次數達 11.12 萬次，較上週六成長 72%，平均見車率 93%，平均見位率 99%」，且該日「適逢 228 連假且是好天氣」——直接印證假日+天氣是實際觀測到會顯著改變借還量體的因素 [新北市政府施政成果網](https://wedid.ntpc.gov.tw/Governance/Detail/bRpVL3n0P5qj)。
- 新北市/台北市公共自行車開放資料集，可作為天氣、假日等外部特徵的比對基礎：[新北市公共自行車租賃系統(YouBike2.0) - 政府資料開放平臺](https://data.gov.tw/dataset/146969)。

---

## 對本專案最關鍵的發現（總覽）

1. **維修/停運狀態必須從訓練資料中明確分離**——業界標準（GBFS 的 `is_renting`/`is_returning`/`is_installed`/`num_docks_disabled`）證明這是被廣泛採用的正式作法，不是我們自己想像出來的邊角問題。若拿到的新北市資料沒有服務狀態欄位，需要自行設計 heuristic（如數值長時間凍結、總車柱數異常）來偵測，否則模型會把停運誤學成需求模式。
2. **空間相關性（鄰近站點互相影響）是目前學術界的主流方向，且被證明優於獨立逐站預測**——多篇 GNN/圖卷積論文（GCNN-DDGF、ST-BDP、Multi-Task Dynamic Graph）都顯示用學習出來的站點間關係（而非只用地理距離）表現更好；即使我們沒有資源做完整 GNN，至少應該把「鄰近站點的即時狀態」納入特徵，而不是把每站當獨立問題。
3. **預測準確度不等於調度決策品質，也不等於觀測資料完整**——兩個獨立發現都指向同一個陷阱：(a) 「更準確的預測不必然帶來更好的調度決策」，最終應以業務 KPI（如減少空/滿事件次數）驗收而非只看 RMSE；(b) 觀測到的借還記錄本身可能低估真實需求（因為「借不到車」的嘗試根本不會被記錄），尖峰時段的模型訓練標籤可能存在系統性偏差，需要謹慎解讀。
