# AWS 正式環境交接

競賽 Demo 使用 `us-west-2` 的 `ctrlcity-hackathon` stack。

- AWS 網址：<https://d1j270xi5vh8gd.cloudfront.net>
- GitHub：`happyloa/Hackathon2026CtrlCity`，推送 `main` 觸發 `.github/workflows/deploy-aws.yml`。
- GitHub Actions 先執行測試與型別檢查，再建置並驗證 Lambda bundle、更新 API、發布前端、等待 CloudFront 快取失效，最後執行線上 smoke test。
- GitHub 使用 OIDC role `ctrlcity-github-deploy`，信任限於該 repo 的 `main`；role ARN 存在 repository variable `AWS_DEPLOY_ROLE_ARN`，不需要保存 AWS access key。
- `infra/github-deploy-policy.json` 記錄這次部署的資源權限。若重建 stack，需更新其中的 bucket、distribution、Lambda ARN，再更新 role policy。
- `infra/github-deploy-trust.json` 記錄 OIDC 信任條件；此 repo 使用含 owner ID／repo ID 的 immutable subject，不能改成舊版只含名稱的格式。Lambda 更新等待器需要 `lambda:GetFunction`，權限仍限本 Demo 函式。
- 自動部署更新前端與 Lambda 程式；修改基礎設施模板時，另執行下方 `aws:deploy`。CI role 沒有建立 IAM 或變更基礎設施的權限。

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

不建立 DynamoDB、排程 worker、SageMaker 或常駐向量資料庫。現有預測使用靜態歷史基線、官方即時快照與可測試的前端邏輯。

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
