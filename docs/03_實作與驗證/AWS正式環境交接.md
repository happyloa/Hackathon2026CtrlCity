# AWS 正式環境交接

## 已備妥

- 私有 S3＋CloudFront 靜態網站。
- HTTP API／Lambda：健康檢查、官方即時資料代理、AgentCore 分析說明端點。
- 選配 AgentCore Harness；預設關閉 Memory，限制 2 次迭代、300 tokens、20 秒。
- 選配獨立知識文件 S3；只上傳 `app/aws/knowledge/*.md`，不含原始 CSV。
- preflight、部署、發布、知識上傳與 smoke test 指令。

目前沒有建立任何正式 AWS 資源；公開 Demo 仍在 Cloudflare Pages。

## 正式帳號到手後請提供

- `aws sts get-caller-identity` 輸出、正式 region 與可用 role。
- S3、CloudFront、CloudFormation、Lambda、API Gateway、IAM／PassRole、CloudWatch 與 AgentCore 權限。
- 主辦方核准的 foundation model ID，或已完成知識庫／Gateway 串接的 Harness ARN。
- Knowledge Base／S3 Vectors／embedding model 的允許範圍，以及活動 credit／預算上限。

不要把 access key、secret、session token 或 ARN 寫進 Git、前端環境變數或對話截圖。

## 部署主線

在 `app/` 執行；`<REGION>` 以正式帳號規定為準：

```powershell
npm run aws:preflight -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:publish -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:smoke -- --stack ctrlcity-hackathon --region <REGION>
```

`aws:publish` 會依 stack output 自動建置，再上傳前端；Agent 未啟用時不會顯示分析說明入口。

既有 Harness 加上 `--harness-arn <ARN>`。若要由 stack 建立最小 Harness，明確加上 `--create-harness --model-id <MODEL_ID>`；這會開始產生 AgentCore／Bedrock 用量。

知識文件另加 `--knowledge-source` 部署，再執行：

```powershell
npm run aws:knowledge -- --stack ctrlcity-hackathon --region <REGION>
```

此步只上傳 Markdown，不建立向量庫或啟動 ingestion；等正式 region、embedding model 與主辦方流程確認後，再接 Managed Knowledge Base／Gateway。

## 成本界線

- Agent、知識 bucket 與付費 smoke test皆預設關閉；smoke test 只有加上 `--include-agent --confirm-agent-cost` 才呼叫一次 Agent。
- 不建立 DynamoDB、排程 worker、SageMaker endpoint 或常駐向量資料庫。
- 部署前先設 Budget 告警；展示後先清空 S3，再刪除 stack。

詳細參數與 API 契約見 [app/aws/README.md](../../app/aws/README.md)。
