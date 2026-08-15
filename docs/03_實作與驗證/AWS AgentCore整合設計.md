# AWS AgentCore 整合設計

## 目的與競賽對齊

活動規則要求成果具備生成式 AI 技術應用與 Live Demo，且基礎模型僅限 Amazon Bedrock 或 SageMaker AI。AgentCore 不是額外的硬性規定，但能讓 Demo 的 AI 功能有明確的工具邊界、追溯性與 AWS 架構說明。

本方案把 Agent 定位為「調度決策說明／覆核助理」，而非數值預測器。站點庫存、風險分數、建議車數與全域分配仍由本專案可測試的資料管線和 `live-operations.ts` 產生；模型只能解釋已提供的事實、引用知識庫內容，並提醒人工覆核。

## 建議架構

```text
Nuxt / Cloudflare Pages
  └─ 使用者主動點選「AI 調度覆核」
       └─ AWS HTTP API + Lambda facade
            └─ AgentCore Harness（us-west-2）
                 └─ AgentCore Gateway（僅 Retrieve 工具）
                      └─ Managed Knowledge Base
                           └─ 私有 S3：命題、資料字典、調度規則、展示說明
```

- 瀏覽器只傳送縮減後的結構化 facts：選定站點、時間窗、前三筆告警、前三筆調度與摘要數字。
- Lambda 以 IAM 呼叫 Harness；瀏覽器、Cloudflare Pages 與 Git repository 都不得保存 AWS access key、Bedrock key 或 AgentCore ARN。
- Knowledge Base 只放少量、可公開展示的中文文件；不放原始 CSV、14 MB Dashboard artifact 或 `docs/資料集/`。
- AgentCore Gateway 只開啟受控的 `Retrieve` 工具，不使用 Browser、Code Interpreter、長期 Memory、Web search 或自動排程。

## Agent 可以與不可以做的事

| 可以做 | 不可以做 |
| --- | --- |
| 說明某站為何出現無車／滿位風險 | 自行捏造車數、機率、天氣、事故或營運紀錄 |
| 說明全域調度任務為何較優先 | 覆寫既有預測或直接發送真實派車指令 |
| 依 600m 替代還車規則提供行動說明 | 把知識庫檢索結果當作即時庫存 |
| 用知識庫引用生成交班摘要 | 將歷史資料集或使用者個資送往模型 |

所有輸出都必須附上「資料時間、人工覆核」提示。若 facts 不完整，Agent 應說明無法判定，而不是補齊猜測值。

## 成本與安全護欄

- 前端功能預設關閉：`NUXT_PUBLIC_AGENT_ENABLED=false`；只在使用者明確點擊時呼叫，不在頁面載入或五分鐘即時更新時自動呼叫。
- 選用活動帳號中可用的低成本 Bedrock 模型（例如 Amazon Nova Micro／Lite），並固定短 prompt、`maxTokens` 約 300、Harness `maxIterations` 2 到 3、短 timeout。
- API Gateway 設節流，Lambda 設低保留併發；每個資源加上 `project=ubike-hackathon` 與到期日標籤。
- 建立小額 AWS Budget 告警；Budget 不是即時硬性斷路，活動後仍要刪除 Harness、Gateway、Knowledge Base、S3、Lambda/API 與 CloudWatch log group。

## 實作前置條件與現況

AWS CLI 已安裝於開發機，但尚未設定 AWS profile，也尚未建立任何 AWS 資源或產生費用。實作前需要活動提供的短期憑證或使用者指定的 AWS 帳號與 region，先用 `aws sts get-caller-identity` 確認身分與權限，再建立資源。

AgentCore CLI 與 AWS CLI 是兩套工具；工作坊以 Console 與 boto3 示範為主。若採 Lambda facade 與 AWS Console 建置，第一階段不必額外安裝 AgentCore CLI 或 Python。

## 官方依據

- [2026 新北市 AI 智慧城市黑客松競賽規則](https://www.digitimes.com.tw/seminar/smartcity_hackathon/)
- [Amazon Bedrock AgentCore 概覽](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
- [Managed Knowledge Base Gateway connector](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-managed-kb.html)
- [AWS CLI for Windows](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
