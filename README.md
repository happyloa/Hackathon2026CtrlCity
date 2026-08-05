# YouBike 調度雷達

新北市公共自行車營運調度數據視覺化及預測模型的 Hackathon 原型。它把「現在有沒有車／位」、「下一小時可能失衡在哪裡」和「由人員覆核的調度建議」放在同一個工作流。

## 可以展示什麼

- **官方即時站況**：首頁預設接入新北市政府 Open Data，顯示全站地圖、空車／滿位／暫停狀態；先立即取得一次資料，再配合來源節奏於每個五分鐘邊界後比對。只有資料時間或庫存變動才替換畫面並給同步效果。
- **歷史預測**：六個月、12 份 CSV、約 1,332 萬筆站點快照產生可重現的早尖峰、晚尖峰與一般情境，預測 30／60／120 分鐘的庫存失衡風險。
- **持續異常與調度**：連續半小時 bucket 回推空車／滿位／暫停的開始時間與持續時間；調度建議依安全庫存、距離與優先分數配對，永遠由人員確認。
- **事實受限的 AI 摘要**：本機 template 是可追溯的預設；可選 Amazon Bedrock adapter 只改寫既有事實，不能生成新的站名、數字或派車動作。
- **可讀性**：淺／深色模式、持久化主題選擇、自訂高對比 scrollbar，所有使用者可見的 UI 文字與圖表字級皆不低於 16px。

## 命題對應

| 命題需求 | 原型實作 |
| --- | --- |
| 易理解的即時站點視覺化 | 「即時站況」以官方資料驅動同一張全站地圖、指標和站點卡。 |
| AI 預測或即時租借需求呈現 | 「歷史預測」以站點、星期與半小時時槽計算未來庫存風險；即時模式只顯示現況，不冒充預測。 |
| 持續空車／滿位介入 | 以連續歷史 bucket 建立開始時間、持續時長、告警與人工確認流程。 |
| 優化調度 | 對高風險需求站配對不會跌破安全庫存的鄰近供給站，呈現台數、距離、理由與人工覆核。 |
| 生成式 AI 應用 | 受限事實摘要 + Amazon Bedrock migration adapter；線上 Demo 預設不宣稱已實際呼叫 Bedrock。 |

完整的命題對照在 [docs/REQUIREMENT_COVERAGE.md](docs/REQUIREMENT_COVERAGE.md)，三分鐘講稿在 [docs/DEMO_3MIN.md](docs/DEMO_3MIN.md)。

## 基線驗證結果

歷史啟發式模型採 1–4 月訓練、5 月選閾值、6 月保留測試；固定 217 站樣本的 6 月 F1 為 30 分鐘 **48.6%**、60 分鐘 **39.2%**、120 分鐘 **30.4%**。這是可解釋的原型基線，並非宣稱可直接自動調度的最終模型；完整方法、precision／recall、Brier score 與限制請看 [docs/MODEL_EVALUATION.md](docs/MODEL_EVALUATION.md)。

## 本機啟動

```powershell
cd app
npm install
npm run data:build
npm run data:validate
npm run dev
```

## 驗證與部署

```powershell
cd app
npm test
npm run typecheck
npm run build:cloudflare
npm run deploy:cloudflare
```

`deploy:cloudflare` 是目前 Pages Direct Upload 的部署流程。`wrangler.toml` 不建立 KV、D1、R2、Workers AI 或任何付費 binding；即時資料為公開 API，資料產製在本機完成。

## 資料與隱私

- 原始資料 `docs/資料集/` 已加入 `.gitignore`，不會被 commit 或推送。
- 產製後只有網站所需的 `app/server/data/dashboard.json` 進入專案；前端不讀取原始 CSV。
- 所有時間正規化為 `Asia/Taipei` 的半小時 bucket；UTF-8 與 CP950／Big5 輸入、站名別名、容量差與暫不可用狀態均在產製流程處理。
- 可借車與可還位同時為零時標為「暫不可用」，不會重複計入空車與滿位。

## 架構與 AWS 遷移

```text
已忽略的 CSV + 新北市政府官方即時 API
  -> Node 資料清洗、品質規則、時槽風險與連續異常
  -> dashboard artifact + Nuxt 4 / Nitro API
  -> 即時地圖、歷史預測、告警、調度、事實摘要
  -> Cloudflare Pages Demo

正式競賽 AWS 版本：S3 -> Lambda / EventBridge -> DynamoDB -> API Gateway
                                   \-> Amazon Bedrock（受限事實摘要）
```

`app/infra/template.yaml` 與 `app/aws/` 是可遷移的 SAM／Bedrock 邊界，不代表 AWS 後端或 Bedrock 已部署。若取得競賽 AWS 帳號與核准的模型 ID，再設定 AWS 環境變數並完成實際驗證。

## Demo 順序

1. 以「即時站況」顯示官方資料時間、五分鐘比對與異常站點地圖。
2. 切到「歷史預測」，選擇尖峰情境與 60 分鐘時間窗。
3. 點站點看可借／可還位、趨勢、風險理由與資料品質提示。
4. 到告警中心確認持續異常，再到調度工作台指派一筆建議。
5. 產生本班摘要，說明 AI 只整理已驗證事實且不會自動派車。
