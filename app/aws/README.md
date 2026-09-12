# AWS 正式環境交接

競賽 Demo 使用 `us-west-2` 的 `ctrlcity-hackathon` stack。

- AWS 網址：<https://d1j270xi5vh8gd.cloudfront.net>
- GitHub：`happyloa/Hackathon2026CtrlCity`，推送 `main` 觸發 `.github/workflows/deploy-aws.yml`。
- GitHub Actions 先執行測試與型別檢查，再建置並驗證 Lambda bundle、更新 API、發布前端、等待 CloudFront 快取失效，最後執行線上 smoke test。
- GitHub 使用 OIDC role `ctrlcity-github-deploy`，信任限於該 repo 的 `main`；role ARN 存在 repository variable `AWS_DEPLOY_ROLE_ARN`，不需要保存 AWS access key。
- `infra/github-deploy-policy.json` 記錄這次部署的資源權限。若重建 stack，需更新其中的 bucket、distribution、Lambda ARN，再更新 role policy。
- `infra/github-deploy-trust.json` 記錄 OIDC 信任條件；此 repo 使用含 owner ID／repo ID 的 immutable subject，不能改成舊版只含名稱的格式。Lambda 更新等待器需要 `lambda:GetFunction`，權限仍限本 Demo 函式。
- 自動部署更新前端、API 與已啟用的快照 Lambda 程式；修改基礎設施模板時，另執行下方 `aws:deploy`。CI role 沒有建立 IAM 或變更基礎設施的權限。

Cloudflare Pages 的 Git Integration 繼續使用同一個 `main`，兩個平台各自建置。AWS 使用主辦方臨時帳號，活動後的保留期限依主辦方設定。

## 最小架構

```text
CloudFront
├─ 私有 S3：Nuxt dist、歷史基線
└─ /api/* → HTTP API → Lambda
   ├─ GET  /api/health
   ├─ GET  /api/v1/live-stations → 新北市官方資料
   └─ POST /api/v1/agent-review → AgentCore Harness（選配）
```

預設不建立排程擷取、建置 runner 或登入資源；三阶段可依下方旗標啟用。不建立 DynamoDB、SageMaker 或常駐向量資料庫。現有預測使用靜態歷史基線、官方即時快照與可測試的前端邏輯。

## AgentCore

預設 `AgentCoreHarnessArn` 為空，AI 端點回傳 `503 AGENTCORE_DISABLED`，不會呼叫模型。

正式帳號可二選一：

1. 傳入工作坊或主辦方既有 Harness ARN。
2. 明確加上 `--create-harness --model-id <核准模型>`，由 stack 建立最小 Harness。

Stack 建立的 Harness 固定關閉 Memory，最多 2 次迭代、300 tokens、20 秒；Lambda 不接受瀏覽器覆寫 model、system prompt 或 tools。Stack 管理的模型權限限定在同 region 的指定 model ID；若主辦方給的是跨 region inference profile，優先使用已建好的 Harness ARN。瀏覽器只收到同源 API 路徑，不會收到 ARN 或 AWS 憑證。

Agent request 最多 16 KB、12 筆 facts，且只接受指定欄位。成功 response 固定為：

```json
{
  "data": {
    "headline": "...",
    "narrative": "...",
    "cautions": [],
    "citations": [{ "label": "...", "source": "..." }]
  },
  "meta": {
    "provider": "agentcore",
    "generatedAt": "...",
    "requestId": "..."
  }
}
```

## 精選知識文件

`aws/knowledge/` 只放可公開展示的精簡 Markdown，不含原始 CSV。部署時加上 `--knowledge-source` 才會建立獨立私有 S3 bucket，再上傳精選文件：

```powershell
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION> --knowledge-source
npm run aws:knowledge -- --stack ctrlcity-hackathon --region <REGION>
```

這只會上傳 Markdown，不會建立 Knowledge Base、S3 Vectors、Gateway 或啟動 ingestion。正式帳號確認 region、embedding model 與 IAM 權限後，再把該 bucket 接到主辦方允許的知識庫。

## 正式帳號部署

先安裝 AWS CLI v2 與 SAM CLI，使用 SSO、臨時角色或 CloudShell；不要建立長期 access key。

```powershell
npm run aws:preflight -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:publish -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:smoke -- --stack ctrlcity-hackathon --region <REGION>
```

`aws:publish` 會先讀取 stack output，再以相同來源路徑自動建置前端；只有 `AgentReviewEnabled=true` 時才把 AI 分析說明入口編入 AWS 版本。

發布時先上傳帶雜湊檔名的 JS/CSS，再更新頁面與資料，並保留舊版 `_nuxt` 資源讓已開啟的分頁仍能載入。完成後使 CloudFront 全站快取失效。

既有 Harness：

```powershell
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION> --harness-arn <ARN>
```

Stack 管理 Harness（會產生 AgentCore／Bedrock 用量）：

```powershell
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION> --create-harness --model-id <MODEL_ID>
```

Smoke test 預設不呼叫 Agent。只有同時加入 `--include-agent --confirm-agent-cost` 才會送出一筆付費分析請求。

## 成本與清理

- CloudFront 使用 `PriceClass_100`；API 不快取，AI route 有節流，Lambda reserved concurrency 為 2。
- CloudWatch logs 保留 7 天；選配知識來源 bucket 物件 90 天後到期。
- AWS Budgets 有延遲，不能代替節流、token 上限與功能開關。
- 刪除 stack 前先清空網站與知識 S3 bucket，否則 CloudFormation 無法刪除非空 bucket。


## 本地與 AWS 分離（三階段）

依 `.scratch/dispatch-homepage-redesign/AWS三階段實作步驟.md` 整合。三階段資源預設關閉；AWS 發布一律使用 `storageMode=aws`，不讀寫 localStorage。

| 資料 | 本地／Cloudflare | AWS 開啟對應旗標後 |
|---|---|---|
| 最新站況 | 現有 API 代理 | S3 `/snapshots/latest.json`；15 分鐘過期或讀取失敗退回代理 |
| 狀態持續時間 | 瀏覽器快照 | Scheduler 每 5 分鐘呼叫 Lambda，計算並寫 S3 `/state/persistence.json` |
| 30 分鐘動量 | 記憶體＋localStorage 快照 | 分頁記憶體；持續時間由 AWS 提供 |
| 排除窗／活動／手動路線 | localStorage | 同源 API → Lambda → S3；公開 GET、Cognito 保護 PUT、ETag 衝突檢查 |
| 歷史剖面 | 本地 CSV 管線 | 按需 CodeBuild，使用私有 S3 CSV／累積快照 |
| 主題、預測模式、側欄 | localStorage | 僅分頁記憶體，重新整理回預設，不使用 localStorage |

開啟 AWS 功能時，前端設定由 `aws:publish` 讀 stack outputs 自動注入；不要在 Cloudflare 設定 AWS 的 `NUXT_PUBLIC_*` 變數。
AWS 版未開啟 `--dispatcher-login` 時，營運編輯為唯讀，不會偷偷改存 localStorage。快照由 Lambda 寫入，瀏覽器透過 CloudFront 讀取公開 JSON；營運資料由瀏覽器呼叫同源 API，Lambda 才能讀寫 S3。

```powershell
# 先有基礎 stack，再開三階段；每次部署都帶上要保留的旗標。
npm run aws:preflight -- --stack ctrlcity-hackathon --region us-west-2
npm run aws:deploy -- --stack ctrlcity-hackathon --region us-west-2 --enable-capture --build-runner --dispatcher-login
npm run aws:publish -- --stack ctrlcity-hackathon --region us-west-2
npm run aws:smoke -- --stack ctrlcity-hackathon --region us-west-2
```

`--alert-email <email>` 選配；需收件者確認 SNS 訂閱。未提供 email 時仍建立 CloudWatch alarms。
`DispatcherSiteUrl` 由既有 stack 的 SiteUrl 自動取得，或 `--site-url https://...` 指定；這避免 Cognito callback 與 CloudFront/API 的循環依賴。

### 快照與歷史重建

- 每 5 分鐘擷取。超過 15 分鐘空窗會重設持續時間；checkpoint 最後寫入，重試可補齊 raw/latest。
- raw 依台北日期分資料夾，寫入獨立私有 `HistoryDataBucket`；不作為 CloudFront 來源。capture 只有此 bucket 的 `raw/*` 寫入權，CodeBuild 只有讀取權。
- 歷史 bucket 設定 raw 30 天後轉 Glacier Instant Retrieval、180 天到期。S3 預設小於 128 KB 的物件不轉儲存類別，仍會到期；目前壓縮快照約 105 KB。參考 [AWS Lifecycle 說明](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html)。
- 舊 site bucket 的 raw 拒絕公開政策、發布排除與生命週期暫時保留，保護尚未刪除的遷移來源；新快照不再寫入 site bucket 的 raw。
- `/snapshots/*` 與 `/state/*` 使用 60 秒快取（上限 120 秒）。過期持續時間不使用。
- `aws:publish` 與 CodeBuild 共用發布程式，保留 raw、snapshots、state、三份 operator JSON 及舊 `_nuxt` 資源。
- 首次啟用登入時以 `IfNoneMatch: *` 初始化排除窗，已存在的雲端版本不會被覆蓋。

```powershell
# 上傳目前 HEAD 的 source zip 並觸發一次 CodeBuild（未 commit 的修改不會納入）
npm run aws:rebuild -- --stack ctrlcity-hackathon --region us-west-2
```

CodeBuild 使用 Node 24、12 GB heap，先讀 `RawDataBucket/dataset/` 的 CSV 與 `HistoryDataBucket/raw/` 每半小時一筆快照，再讀雲端排除窗、執行原有資料管線、測試、型別檢查，成功後才發布。來源 zip 每次使用唯一 key，最多一個建置同時執行。產物備份於 `RawDataBucket/artifacts/<UTC時間>/`。歷史重建不重新訓練 XGBoost，也不覆寫或刪除另行上傳的 `data/xgboost/model-*.json`。
CodeBuild 設定 `CTRL_CITY_ROLLING_HISTORY=true`，描述性 ROI 剖面的全期範圍延伸至台北當天；本地預設仍固定一至六月。訓練期一至四月不變，避免污染凍結評估。CSV 轉換會去除官方 YouBike 名稱前綴，使新快照與主辦方 CSV 使用相同站點 ID。

本次使用者指定的歷史來源為 `ml/data/_normalized_csv`，共 12 個 UTF-8 CSV，涵蓋 2026 年 1–6 月；使用 `CTRL_CITY_DATASET_DIR` 接入現有管線。本機預設來源仍為 `docs/資料集`，可指定環境變數切換。重建前必須先上傳基礎 CSV；沒有 CSV 時建置會停止，避免用少量即時快照取代完整歷史剖面。

```powershell
$datasetBucket = aws cloudformation describe-stacks --stack-name ctrlcity-hackathon --region us-west-2 --query 'Stacks[0].Outputs[?OutputKey==`RawDataBucketName`].OutputValue | [0]' --output text
# 從 repo 根目錄執行，只上傳 CSV，不刪除雲端資料。
aws s3 sync ml/data/_normalized_csv "s3://$datasetBucket/dataset/" --exclude '*' --include '*.csv' --region us-west-2
```

雲端重建的 `dashboard.json` 與 ROI 是執行時產物；repo 內的檔案仍是本機開發快照，不會自動被雲端回寫。

### 調度登入與資料編輯

- `/admin/adjustments`、`/admin/events` 和 `/dispatch` 手動路線可匿名閱讀；管理員建立 Cognito 帳號後才能編輯。
- Hosted UI 使用 authorization code + PKCE。token 僅存記憶體，重新整理後需重新登入；PKCE transaction 暫存 sessionStorage。
- 編輯後按「儲存到雲端」。失敗時保留本分頁草稿；412 會鎖住儲存，須重新載入最新版本再編輯。草稿不會自動覆蓋 S3。
- 排除窗使用歷史管線的站點 ID；品質旗標的「登記排除窗」會依站名與行政區對應。
- 活動格式：`{schemaVersion:'1.0', events:[{id,name,stationIds,startAt,endAt,note}]}`，起訖為台北 `YYYY-MM-DDTHH:mm`。目前活動為管理紀錄，未加入額外模型修正。
- PUT 限制 64 KB、完整檔案驗證、access token claims 與 IfMatch／IfNoneMatch；未啟用登入不建立 PUT 路由（404），啟用後匿名寫入由 API Gateway 回 401。公開 GET 不依賴登入是否啟用。
- 營運 GET／PUT 與 SAM 路由共用 `OperationsApi.DefinitionBody`，避免 API 更新時覆蓋獨立 Route 資源。瀏覽器用戶端將原生 fetch 綁定 globalThis，避免 `Illegal invocation`。
- 儲存排除窗後執行 `aws:rebuild`，才會讓歷史統計與預測基線套用新排除窗。

建立帳號範例（暫時密碼由管理員安全提供，請勿放入 git）：

```powershell
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <EMAIL> --user-attributes Name=email,Value=<EMAIL> Name=email_verified,Value=true --region us-west-2
```

GitHub OIDC 部署 role 需套用更新後的 `infra/github-deploy-policy.json`，以更新 capture Lambda；CI 不負責部署基礎設施。回滾時移除對應旗標後重新部署**並重新發布前端**，以清除登入與快照設定。RawDataBucket 使用 Retain；若完全刪除整個 stack，仍需另行備份 site bucket 的 raw/state/operator 資料。

### 不部署的本地驗證

`npm test` 驗證 Lambda、S3 版本衝突、CSV 相容性與 AWS storage guard；`npm run typecheck` 驗證型別。`aws:preflight` 與 `aws:deploy` 先由 `aws-template.mjs` 產生 `.aws-sam/source/template.json`，未要求建立 Harness 時移除選配資源，再執行 SAM lint；避免 us-west-2 對未支援資源類型的檢查阻擋歷史功能部署。Lambda 的 SAM build 設定 `npm_config_ignore_scripts=true`，避免 production dependencies 安裝誤執行 Nuxt postinstall。

`tests/browser/aws-live-storage-check.js` 是正式網站唯讀驗證：封鎖 localStorage 後，確認首頁與三種營運文件均取得雲端 JSON。CI 仍只更新程式與前端，新增歷史基礎設施須先執行 `aws:deploy`；CI 現在會先檢查 `HistoryDataBucketName`，缺少時停止，避免發布不能運作的 capture 程式。

`tests/browser/aws-storage-check.js` 是 Playwright CLI 腳本：對本地 AWS 設定的靜態站（`http://127.0.0.1:4174`）模擬 OIDC/API/快照，將 `window.localStorage` 的 getter 設為立即拋錯，驗證匿名唯讀、PKCE callback、排除窗／活動／路線儲存、412 衝突、跨分頁讀取與過期回退。這是模擬整合驗證，不能代替實際 AWS 部署後的 smoke 與登入測試。
