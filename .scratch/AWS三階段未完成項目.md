# AWS 三階段未完成項目

> 對照 `.scratch/dispatch-homepage-redesign/AWS三階段實作步驟.md` 逐項實測後的結果。
> 本文只記錄**還沒完成的部分**與剩餘步驟；已完成的不重複列。

**查核時間：** 2026-09-12 17:20（Asia/Taipei）／09:20 UTC
**查核對象：** commit `3e25498`、stack `ctrlcity-hackathon`、region `us-west-2`、帳號 `953694300276`
**網站：** https://d1j270xi5vh8gd.cloudfront.net

**查核方式：** AWS CLI 實際查詢已部署資源、觸發 Lambda、讀取 S3 與 CloudFront 回應、瀏覽器載入線上頁面；程式碼以 `origin/main` 為準。

---

## 總覽

| 階段 | 程式碼 | 部署 | 狀態 |
|---|---|---|---|
| 第一階段 快照擷取 | ✅ 在 main | ✅ 已上線運作 | ⚠️ 4 項未完成 |
| 第二階段 歷史重建 | ✅ 在 main | ❌ 完全未部署 | ❌ 未開始 |
| 第三階段 營運資料雲端化 | ✅ 在 main | ⚠️ API 已上線、登入未部署 | ⚠️ 功能尚不可用 |

**目前 stack 參數：** `EnableSnapshotCapture=true`、`CreateBuildRunner=false`、`EnableDispatcherLogin=false`、`AlertEmail=`（空）

---

## 第一階段：已上線，4 項未完成

**已確認正常運作：** EventBridge Scheduler（`rate(5 minutes)`，ENABLED）→ capture Lambda → S3。09:15 UTC 排程自動寫入新快照，1,606 站。前端已改讀 `/snapshots/latest.json` 與 `/state/persistence.json`，不再呼叫 `/api/v1/live-stations`。CloudFront 以 60 秒快取政策供應，零 console 錯誤。

### 1-A. 歷史資料未存放於獨立 bucket（**使用者明確要求**）

| | |
|---|---|
| **現況** | main 把 `raw/` 快照存在 **site bucket**（`ctrlcity-hackathon-sitebucket-dbultpgfkry4/raw/`），以 bucket policy 的 `DenyPublicRawSnapshots` 阻擋 CloudFront 讀取。實測 `GET /raw/2026/09/12/1630.json.gz` → **HTTP 403**，防護有效。 |
| **為何未完成** | 使用者要求的是**實體隔離的獨立 bucket**，不是同一 bucket 內以政策隔離。先前建立的 `ctrlcity-hackathon-historydatabucket-yhwhkjqxsfwz` 在對齊 main 時已脫離 stack（`DeletionPolicy: Retain`，其中 9 個檔案仍保留）。 |
| **風險** | site bucket 是 CloudFront 來源，且會被 `aws:publish --delete` 掃過。雖然目前有 `protectedPublishPaths` 與 Deny 政策兩層保護，但任何一層被改動就會暴露或誤刪歷史資料。 |

**剩餘步驟**

1. 在 `app/infra/template.yaml` 新增獨立的歷史 bucket 資源（建議 `DeletionPolicy: Retain`、封鎖所有公開存取、不作為 CloudFront 來源、`raw/` 生命週期 30 天轉 Glacier IR、180 天到期）
2. capture Lambda 增加 `HISTORY_BUCKET` 環境變數；IAM 拆成兩條 —— site bucket 僅 `snapshots/*` 與 `state/*`，歷史 bucket 僅 `raw/*` 的 `PutObject`
3. `app/aws/capture.ts` 的 `rawKeyFor` 寫入目標改指向歷史 bucket
4. 移除 site bucket 的 `DenyPublicRawSnapshots` 與 `raw/` 生命週期規則（不再需要）
5. `app/scripts/aws-publish-config.mjs` 的 `protectedPublishPaths` 移除 `raw/*`
6. **第二階段連動**：`app/infra/buildspec-history.yml` 目前傳 `--bucket "$SITE_BUCKET"` 給 `raw-snapshots-to-csv.mjs`，需改成歷史 bucket
7. 把 `ctrlcity-hackathon-historydatabucket-yhwhkjqxsfwz` 內既有的 9 個快照搬到新 bucket，確認後刪除舊 bucket
8. commit 並 push，由 CI 部署

### 1-B. 兩個核心功能從未實際觸發

capture 自 2026-09-12 08:30 UTC 才開始累積，查核當下最長僅 50 分鐘：

| 功能 | 門檻 | 目前達標站數 |
|---|---|---|
| 缺車 ≥1 小時告警 | 60 分鐘 | **0 站** |
| 疑似壞車偵測 | 庫存 180 分鐘未變 | **0 站** |

目前缺車 93 站，其中持續 ≥30 分鐘者 21 站。

**剩餘步驟**：等待累積後實際觀察。首次可觀測時間約 09:30 UTC（缺車告警）與 11:30 UTC（壞車偵測）。需確認 `AlertList.vue:110` 的「已缺車 N 小時 M 分」確實出現，以及 `useLiveDashboard.ts:130` 推入的壞車 `qualityFlags` 有被顯示。

> 注意：`persistence.json` 的時鐘在中斷超過 15 分鐘時會重設（`RESET_GAP_MINUTES`）。若期間曾重新部署或排程中斷，計時會歸零重算。

### 1-C. 壞車面板在首頁被註解停用

`app/pages/index.vue:160`：

```
<!-- <FrozenStationPanel v-if="dashboard" :stations="dashboard.stations" :frozen-stations="dashboard.frozenStations"
  @select="selectedStationId = $event" /> -->
```

後端邏輯完整（`useFrozenStations.ts` + `useStationSnapshots.ts` + `FROZEN_STATION_POLICY`，並在 `useLiveDashboard.ts:130` 依 `persistence.unchangedMinutes >= 180` 推入 `qualityFlags`），但**首頁沒有任何地方呈現**。目前只有 `StationDetailPanel.vue:389` 有一個依 `qualityFlags` 內容判斷的連結。

**剩餘步驟**：確認是刻意停用還是尚未完成。若要啟用，取消註解並驗證 `dashboard.frozenStations` 的資料流，以及與 1-B 的門檻一起實測。

### 1-D. CloudWatch 告警沒有通知對象

`SnapshotCaptureErrorsAlarm`（連續兩次失敗）與 `SnapshotCaptureSilentAlarm`（15 分鐘無執行）都已部署，但 `AlertEmail` 為空 → `CaptureAlertsEnabled` 條件為 false → 未建立 SNS topic，`AlarmActions` 是空陣列。**擷取停擺時不會有人收到通知。**

**剩餘步驟**：`aws:deploy` 加 `--alert-email <address>`，部署後至信箱點擊 SNS 訂閱確認信。

---

## 第二階段：完全未部署

**程式碼已齊備**（都在 main）：`app/infra/buildspec-history.yml`、`app/scripts/aws-rebuild.mjs`、`app/scripts/raw-snapshots-to-csv.mjs`、`app/scripts/aws-prepare-history.mjs`、`app/shared/history-period.mjs`。

**AWS 上的實測結果：** `RawDataBucket` 不存在、CodeBuild project **0 個**、stack 參數 `CreateBuildRunner=false`。

目前網站使用的歷史剖面仍是 **2026-08-26 在本機用 1–6 月 CSV 產製後 commit 的靜態檔**（1,578 站、75,600 格），與新累積的快照之間沒有任何回填機制。

**剩餘步驟**

1. **先確認資料使用條款** —— 主辦方的 1–6 月原始 CSV（約 1.1 GB、1,332 萬列）目前僅存本機且不進 Git。放進你們的 AWS 帳號是新的儲存位置，須先取得同意。`app/aws/README.md` 對知識 bucket 寫的「不含原始 CSV」是 Agent 用途的限制，build 用途需另外確認。
2. 部署基礎設施：`npm run aws:deploy -- --build-runner`，建立 `RawDataBucket`、`BuildRunnerRole`、`HistoryBuildProject`
   - CodeBuild 需 `BUILD_GENERAL1_LARGE`（15 GB），因為 `data:profile` 要 `--max-old-space-size=12288`
3. 上傳 CSV 至 `s3://<RawDataBucket>/dataset/`
4. 觸發 `npm run aws:rebuild`，buildspec 會依序執行：
   - 同步 CSV → `raw-snapshots-to-csv.mjs` 轉半小時快照 → `aws-prepare-history.mjs`
   - `data:build` → `data:profile` → `data:validate` → `npm test` → `npm run typecheck`
   - 上傳 `dashboard.json` / `operational-roi.json` 至 `artifacts/<STAMP>/`
   - 全部成功後才 `aws:publish`
5. **若先完成 1-A**：buildspec 的 `--bucket "$SITE_BUCKET"` 要改成歷史 bucket
6. 注意 `CTRL_CITY_ROLLING_HISTORY=true` 會讓期間標籤從「全期 1-6 月」變成「滾動全期 2026-01-01 至 <前一日>」（`history-period.mjs`）。**模型訓練的時間切分維持凍結**，只有描述性歷史延伸。
7. 建置後 `app/data/dashboard.json` 變成 CodeBuild 的輸出而非 git 的輸入，repo 內那份會落後線上 —— 需決定是否定期把 `artifacts/` 取回 commit，或在 README 註明本機開發用的是舊快照

---

## 第三階段：API 已上線，登入未部署

### 已完成

6 條 operator 路由 + `OperatorApiIntegration` + `OperatorApiPermission` 已部署。實測：

| 端點 | 結果 |
|---|---|
| `GET /api/v1/adjustments` | 200 `{"schemaVersion":"1.0","adjustments":[]}` |
| `GET /api/v1/events` | 200 `{"schemaVersion":"1.0","events":[]}` |
| `GET /api/v1/manual-routes` | 200 `{"schemaVersion":"1.0","routes":[]}` |
| `PUT`（三者皆同） | `503 OPERATOR_WRITE_DISABLED` |

### 3-A. 寫入路由目前無授權層，僅靠 handler 單層防護

登入未啟用時，template 的 `AuthorizationType: !If [LoginEnabled, JWT, NONE]` 解析為 **`NONE`** —— 三條 PUT 路由對外公開可呼叫。唯一防線是 `app/aws/operator-files.ts:23` 檢查 `OPERATOR_WRITE_ENABLED !== 'true'`（Lambda 環境變數實測為 `"false"`）。

實測確認目前擋得住，但這是單層防護：只要該環境變數被誤設為 `true` 而登入仍未啟用，三個營運資料檔就會變成任何人可寫。

**剩餘步驟**：啟用第三階段（下方）即可讓 JWT 授權生效；或在未啟用期間考慮不部署這些路由。

### 3-B. Cognito 未部署，雲端儲存實際不可用

`DispatcherUserPool` / `Client` / `Domain` / `DispatcherJwt` 皆因 `EnableDispatcherLogin=false` 而未建立。連帶：

- `frontendEnvironment()` 把 `MANUAL_ROUTES_ENDPOINT`、`ADJUSTMENTS_ENDPOINT`、`EVENTS_ENDPOINT`、Cognito 三項設定全部填成空字串
- 前端因此不會呼叫雲端 API
- 而 `storageMode=aws` 又讓 storage adapter 在取得 localStorage 前就返回

**結果：手動路線、排除窗、活動目前存不了，重新整理即消失。** 主題、側欄、預測模式偏好同樣只存在分頁記憶體。`status.md` 已標註此偏好策略「尚未取得使用者明確確認」。

**剩餘步驟**

1. `npm run aws:deploy -- --dispatcher-login` 並提供 `DispatcherSiteUrl`（Cognito callback 需要；template 刻意用參數避免資源循環依賴）
2. 建立 Cognito 使用者 —— `AdminCreateUserOnly: true`，沒有自助註冊，須用 `aws cognito-idp admin-create-user`
3. 重跑 `npm run aws:publish`，讓 `frontendEnvironment()` 填入實際的 endpoint 與 Cognito 設定
4. 驗證：PKCE 登入流程、`/admin/callback`、ETag 樂觀鎖與 412 衝突處理、多人同時編輯、跨裝置讀取
5. 確認偏好儲存策略（主題／側欄／預測模式是否需要雲端保存）

---

## 其他待處理

### `.scratch/status.md` 內容已過期

該檔寫於 08:15 UTC，其中這些敘述已不成立：

| 過期敘述 | 實際狀況 |
|---|---|
| 「**未部署**，尚未完成最終驗收」 | commit `3e25498` 於 08:18 UTC 觸發 CI 自動部署並成功 |
| 「AWS 僅執行過 STS 與 CloudFormation 唯讀查詢；沒有部署或雲端寫入」 | 第一階段已上線運作、第三階段 API 已上線 |
| 「`app/dist` 是使用測試 Cognito 設定的產物，不能直接發布」 | 已從真實 stack outputs 重建並發布 |

### `npm run aws:deploy` 在 us-west-2 會被 lint 擋住

`app/scripts/aws-deploy.mjs:33` 的 `sam validate --lint` 有 4 項失敗，比對未改動的 template 確認**全部為既有問題**：

- `E3006` — `AWS::BedrockAgentCore::Harness` 在 us-west-2 不存在（該資源為條件式，實際不會建立）
- `W3005` ×2 — `DependsOn` 已由 `Ref` 隱含
- `W1030` / `W1031` — `AgentCoreHarnessArn` 為空字串時不符 ARN 格式

CI 不受影響（走 `aws lambda update-function-code`），但**手動部署會卡在第一步**。

### 孤立的 bucket

`ctrlcity-hackathon-historydatabucket-yhwhkjqxsfwz` 已脫離 stack 但因 `Retain` 而保留，內含 9 個快照。處理方式取決於 1-A 的決定：若改用獨立 bucket 可沿用它，否則確認資料已複製後刪除。

---

## 可重現的查核指令

```bash
# 部署參數與資源
aws cloudformation describe-stacks --stack-name ctrlcity-hackathon \
  --query 'Stacks[0].Parameters[].[ParameterKey,ParameterValue]' --output text
aws cloudformation list-stack-resources --stack-name ctrlcity-hackathon \
  --query 'StackResourceSummaries[].LogicalResourceId' --output text

# 第一階段是否仍在收集
curl -s https://d1j270xi5vh8gd.cloudfront.net/state/persistence.json | \
  python3 -c "import sys,json;d=json.load(sys.stdin);s=list(d['stations'].values());\
print(d['updatedAt'], len(s),'站',\
'≥60分:',len([x for x in s if x['currentState']=='empty_now' and x['stateMinutes']>=60]),\
'≥180分未變:',len([x for x in s if x['unchangedMinutes']>=180]))"

# raw/ 是否確實擋在 CloudFront 之外
curl -s -o /dev/null -w '%{http_code}\n' \
  https://d1j270xi5vh8gd.cloudfront.net/raw/2026/09/12/1630.json.gz   # 應為 403

# 第二階段是否已部署
aws codebuild list-projects --output text                              # 應為空
aws s3 ls | grep -i rawdata                                            # 應為空

# 第三階段寫入防護
curl -s -X PUT -H 'content-type: application/json' -d '{"adjustments":[]}' \
  https://d1j270xi5vh8gd.cloudfront.net/api/v1/adjustments             # 應為 503
```
