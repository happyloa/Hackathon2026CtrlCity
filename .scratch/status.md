# AWS 三階段遷移進度

更新：2026-09-12 16:15（Asia/Taipei）。使用者最新指示「先不做檢查了」；已停止檢查，保留目前修改。**未部署，尚未完成最終驗收。**

## 使用者要求與架構
- 依 `.scratch/dispatch-homepage-redesign/AWS三階段實作步驟.md` 分離本地與 AWS。
- 本地保留 localStorage；AWS 版本不得讀取或寫入 localStorage。
- 第一階段：EventBridge Scheduler → Lambda → S3，每 5 分鐘收集快照與狀態持續時間；前端經 CloudFront 同源路徑讀取公開快照與 state JSON。
- 第二階段：CodeBuild 處理歷史 CSV 與累積快照，重建歷史資料。
- 第三階段：Cognito → API Gateway → Lambda → S3，處理排除窗、活動、手動路線。瀏覽器不使用 S3 SDK 直接寫入。
- 只準備與驗證部署能力，不執行部署、發布或雲端寫入。
- region：us-west-2；既有 stack：ctrlcity-hackathon。臨時 AWS 憑證不得寫入檔案或 git。
- token 剩餘 10% 前更新本檔。

## 已實作
- 抽出共用 live-feed mapper；新增 capture Lambda、5 分鐘 gzip 原始快照、最新快照與持續時間計算，中斷超過 15 分鐘重設；checkpoint 在資料寫入成功後更新。
- SAM 新增預設關閉的 capture/scheduler/cache/alarms、CodeBuild/private raw bucket、Cognito/JWT routes；使用 DispatcherSiteUrl 避免資源循環依賴。
- 前端讀取 AWS 快照與持續時間，超過 15 分鐘回退 live API；告警顯示持續時間與資料未變提示。
- Lambda operator handler 支援排除窗、活動、手動路線：公開 GET、受登入與功能旗標保護的 PUT、64KB 限制、schema 驗證、ETag 條件寫入與 412 衝突處理。
- PKCE 登入 callback、記憶體 token、雲端載入／明確儲存／衝突重新載入介面；PKCE 暫存與草稿使用 sessionStorage。
- AWS storage adapter 在取得 localStorage 前即返回；主題、側欄與預測模式目前只保留分頁記憶體，重新整理回預設，並未實作雲端偏好儲存。此偏好策略尚未取得使用者明確確認。
- AWS publish 固定 storageMode=aws；保護 raw/snapshots/state 與三份 operator 文件，避免發布刪除或覆寫。首次 operator seed 使用條件寫入。
- CodeBuild buildspec、aws:rebuild、半小時快照 CSV 轉換；歷史剖面在 AWS 模式改成滾動至當日，本地維持原期間。
- CI 加入 capture Lambda bundle 更新；GitHub OIDC policy 檔已補對應權限，未套用至 AWS。
- README、Lambda/API/歷史資料測試、AWS 模擬瀏覽器測試腳本已新增或更新。

## 已完成驗證（停止前的結果）
- `npm test`：122 passed、0 failed；包含手動路線、storage adapter 不取得 localStorage、capture、ETag/401/412/503、CSV 與滾動期間等。
- 最新 `npm run typecheck` 通過。
- AWS 測試設定的 Nuxt build 通過；先前本地設定 build 通過。
- SAM template lint/validate 通過；先前 SAM build 通過，但最後手動路線修改後尚未重新完成 SAM build。
- API/capture CJS bundle import 檢查通過。
- 先前 Playwright 本地 `/admin/adjustments` 頁面正常，console 無 error。
- AWS 僅執行過 STS 與 CloudFormation 唯讀查詢；當時 stack 為 CREATE_COMPLETE，沒有部署或雲端寫入。

## 未完成／待使用者恢復檢查後處理
- AWS 瀏覽器整合測試未通過驗收：CLI 執行回報 `ReferenceError: URL is not defined`；已嘗試改用字串解析，但尚未取得成功結果。已中止相關檢查指令。
- 因此尚不能宣稱整套 AWS 頁面、PKCE 登入、雲端儲存、多人衝突、跨分頁讀取與快照回退都已完成瀏覽器驗證。相關 AWS 回應原定全部在本地模擬。
- 待確認測試 mock 的 Cognito discovery CORS，以及快照回退等待事件的時序。
- 待改善 persistence lookup 重複驗證全站資料的成本，及站名查詢對應的 YouBike 前綴差異。
- 最終 SAM build、本地模式回歸與 CodeBuild 完整資料流程驗證尚未完成。
- `app/dist` 目前是使用測試 Cognito 設定的 AWS 本地驗證產物，不能直接發布；正式發布必須從真實 stack outputs 重建。
- `app/data/operational-impact.json` 在建置時產生衍生變更，尚待整理，避免混入不相關資料更新。
- 雲端部署後的 IAM、Cognito 與服務端整合尚未驗證；遵守不部署要求。

## 續作注意
- 目前停止的是檢查；不得自動恢復測試或部署，須依使用者後續指示。
- 不建立 Cognito 使用者、SNS 訂閱或上傳原始 CSV。
- 原始 raw prefix 禁止 CloudFront 存取；公開快照讀取與營運文件 API 是不同路徑，不應記成所有讀取都經 Lambda。
- 文件的 65 分鐘測試已改成每 5 分鐘連續輸入，避免觸發 gap reset。
- 工作目錄保留所有實作與測試檔案，未提交 git。
