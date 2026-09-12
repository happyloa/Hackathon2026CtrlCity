# AWS 三階段實作步驟：把「時間」搬上 AWS

> **與目前 Demo 的關係**：承接〈五項調整提案〉的架構建議。現行架構把歷史剖面凍結在本機產製（`dashboard.json`，2026-08-26），把即時歷史放在瀏覽器記憶體（40 分鐘、重新整理歸零）。本文把這兩件事搬到 AWS，前端維持靜態站、不加資料庫、不上 SageMaker。每一步都對著現有檔案寫：改哪一行、加哪一段、跑哪個指令、怎麼驗證。

**基準版本：** `main @ 8d708dd`
**對象：** 開發團隊
**部署主線：** 沿用 [AWS正式環境交接.md](AWS正式環境交接.md) 的 `aws:preflight → aws:deploy → aws:publish → aws:smoke`

---

## 0. 開始前：三個階段，各自可以獨立部署、獨立回滾

| 階段 | 做什麼 | 解掉什麼 | 規模 |
|---|---|---|---|
| 一 | EventBridge Scheduler → Lambda → S3，每 5 分鐘抓快照 | 「缺車 1 小時」告警、壞車偵測；即時資料改由 S3 供應 | 1–2 天 |
| 二 | CodeBuild 跑既有的 `data:build`，原始 CSV 與累積快照放私有 S3 | 歷史資料開始滾動，不再需要有 CSV 的本機 | 1 天 |
| 三 | Cognito 登入 + `PUT /api/v1/adjustments` 寫回 S3 | 排除窗與活動不用再匯出、commit、重部署 | 1–2 天 |

**不變的事：** 前端仍是靜態站；沒有資料庫、沒有 SageMaker；所有新資源都藏在預設為 `false` 的 stack 參數後面 — 不開旗標，stack 跟今天一模一樣。Cloudflare Pages 上的公開 Demo 完全不受影響：新的讀取路徑找不到檔案就退回現在的作法。

**前置條件：** AWS CLI v2、SAM CLI、Node 20+（`aws:preflight` 會檢查）。正式帳號要多這幾個權限：`scheduler:*`、`codebuild:*`、`cognito-idp:*`、`sns:*`、`cloudwatch:PutMetricAlarm`。

| 階段 | 新增 stack 參數 | 新增資源 | 前端改動 |
|---|---|---|---|
| 一 | `EnableSnapshotCapture`、`AlertEmail` | Lambda、Schedule、CachePolicy、2 個 CacheBehavior、Lifecycle rule、2 個 Alarm、SNS | 改讀 `/snapshots/latest.json`；新 composable 讀 `/state/persistence.json`；告警帶持續時間 |
| 二 | `CreateBuildRunner` | 私有 raw bucket、CodeBuild project、IAM role | 無 |
| 三 | `EnableDispatcherLogin` | Cognito UserPool / Client / Domain、JWT authorizer、4 條 API route | 登入流程；排除窗與活動改走 API |

---

## 1. 第一階段：每 5 分鐘抓快照到 S3

做完這一段，S3 上會多三個前綴：

- `raw/` — 永久累積的原始快照（gzip）
- `snapshots/latest.json` — 最新一筆，瀏覽器改讀這個
- `state/persistence.json` — 每站的狀態起始時間與數值未變起始時間，前端直接拿來顯示「已缺車 1 小時 25 分」

### 1.1 安裝 S3 SDK

Lambda 執行環境內建 SDK v3，但 SAM 的 esbuild 打包時要能解析 import，所以要裝進 `dependencies`。

```bash
cd app
npm install @aws-sdk/client-s3
```

### 1.2 把站況對應函數抽成純模組

`mapLiveStation`、`asCurrentState`、`serviceStatusFor`、`createLiveResponse`、`asOfFromSourceTime` 現在住在 `composables/useLiveDashboard.ts`，那個檔案 import 了 `useState`、`useRuntimeConfig`，Lambda 不能載。把這五個函數和它們用到的 `asRecord / asString / asNumber` **原封不動**搬到新檔案，composable 改成 import。

`app/shared/live-feed.ts`（新檔，內容從 `useLiveDashboard.ts` 第 30–120 行搬過來）：

```ts
export { asCurrentState, serviceStatusFor, mapLiveStation, createLiveResponse, asOfFromSourceTime }
export type { LiveResponse }
```

`app/composables/useLiveDashboard.ts` 頂端：

```ts
import { createLiveResponse, mapLiveStation, type LiveResponse } from '~/shared/live-feed'
```

跑 `npm test` 與 `npx nuxt typecheck` 確認搬完沒壞。這一步沒有行為改變。

### 1.3 capture Lambda

跟 `aws/handler.ts` 一樣用依賴注入，測試時塞假的 fetch 和 S3。`persistence.json` 每站只存最後一筆數值（不存 36 筆 — 瀏覽器端的 30 分鐘動量仍用它自己的記憶體，沒變），所以整檔約 240 KB、gzip 後約 35 KB。

`app/aws/capture.ts`（新檔）：

```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { gzipSync } from 'node:zlib'
import { mapLiveStation } from '../shared/live-feed.ts'
import { environmentValue } from './runtime-env.ts'

const BUCKET_MINUTES = 5
const RESET_GAP_MINUTES = 15          // 漏抓超過這個間隔，所有「起始時間」歸零，不冒充連續
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024
const DEFAULT_LIVE_FEED_URL =
  'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

export interface StationPersistence {
  currentState: string
  /** 目前狀態（empty_now / full_now / …）從何時開始，ISO。 */
  stateSince: string
  stateMinutes: number
  /** 可借車數與可還位數兩者都沒變，從何時開始。 */
  unchangedSince: string
  unchangedMinutes: number
  last: [bikes: number, docks: number]
}

export interface PersistenceState {
  schemaVersion: '1.0'
  updatedAt: string
  bucketMinutes: number
  stations: Record<string, StationPersistence>
}

export interface CaptureDependencies {
  fetchImpl?: typeof fetch
  s3?: Pick<S3Client, 'send'>
  now?: () => Date
}

export function alignToBucket(date: Date): Date {
  const size = BUCKET_MINUTES * 60_000
  return new Date(Math.floor(date.getTime() / size) * size)
}

function minutesSince(iso: string, epoch: number): number {
  const since = Date.parse(iso)
  return Number.isFinite(since) ? Math.max(0, Math.round((epoch - since) / 60_000)) : 0
}

/** raw/ 依台北時間分日期夾，人看得懂；時間戳本身維持 UTC ISO。 */
export function rawKeyFor(observedAt: Date): string {
  const taipei = new Date(observedAt.getTime() + 8 * 60 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `raw/${taipei.getUTCFullYear()}/${pad(taipei.getUTCMonth() + 1)}/${pad(taipei.getUTCDate())}/`
    + `${pad(taipei.getUTCHours())}${pad(taipei.getUTCMinutes())}.json.gz`
}

/**
 * 純函數：拿上一份狀態 + 這一輪的站況，算出新狀態。
 * 狀態相同 → 沿用 stateSince；數值相同 → 沿用 unchangedSince；否則都重設為這一輪。
 * 上一份太舊（Lambda 曾經停掉）→ 全部重設，寧可少算也不冒充連續。
 */
export function mergePersistence(
  previous: PersistenceState | null,
  stations: ReturnType<typeof mapLiveStation>[],
  observedAt: Date,
): PersistenceState {
  const epoch = observedAt.getTime()
  const iso = observedAt.toISOString()
  const previousEpoch = Date.parse(previous?.updatedAt ?? '')
  const gapTooLong = !Number.isFinite(previousEpoch) || epoch - previousEpoch > RESET_GAP_MINUTES * 60_000
  const next: PersistenceState = { schemaVersion: '1.0', updatedAt: iso, bucketMinutes: BUCKET_MINUTES, stations: {} }

  for (const station of stations) {
    if (!station) continue
    const prior = gapTooLong ? undefined : previous?.stations[station.id]
    const sameState = prior?.currentState === station.currentState
    const unchanged = Boolean(prior)
      && prior!.last[0] === station.availableBikes
      && prior!.last[1] === station.availableDocks
    const stateSince = sameState ? prior!.stateSince : iso
    const unchangedSince = unchanged ? prior!.unchangedSince : iso
    next.stations[station.id] = {
      currentState: station.currentState,
      stateSince,
      stateMinutes: minutesSince(stateSince, epoch),
      unchangedSince,
      unchangedMinutes: minutesSince(unchangedSince, epoch),
      last: [station.availableBikes, station.availableDocks],
    }
  }
  return next
}

async function readJson<T>(s3: Pick<S3Client, 'send'>, bucket: string, key: string): Promise<T | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await response.Body?.transformToString()
    return body ? JSON.parse(body) as T : null
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null
    throw error
  }
}

async function fetchFeed(fetchImpl: typeof fetch): Promise<unknown[]> {
  const url = environmentValue('LIVE_FEED_URL')?.trim() || DEFAULT_LIVE_FEED_URL
  const upstream = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'CtrlCity-YouBike-Capture/1.0' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!upstream.ok) throw new Error(`Live feed returned HTTP ${upstream.status}`)
  const bytes = new Uint8Array(await upstream.arrayBuffer())
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new Error('Live feed exceeded the safe response limit')
  const parsed = JSON.parse(new TextDecoder().decode(bytes))
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Live feed is not a non-empty array')
  return parsed
}

export function createCaptureHandler(dependencies: CaptureDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const s3 = dependencies.s3 ?? new S3Client({})
  const now = dependencies.now ?? (() => new Date())

  return async () => {
    const bucket = environmentValue('SITE_BUCKET')?.trim()
    if (!bucket) throw new Error('SITE_BUCKET is not configured')

    const observedAt = alignToBucket(now())
    const raw = await fetchFeed(fetchImpl)
    const stations = raw.map(mapLiveStation)
    const previous = await readJson<PersistenceState>(s3, bucket, 'state/persistence.json')
    const next = mergePersistence(previous, stations, observedAt)
    const rawBody = JSON.stringify(raw)
    const shortLived = 'public, max-age=60, must-revalidate'

    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: rawKeyFor(observedAt), Body: gzipSync(rawBody),
        ContentType: 'application/json', ContentEncoding: 'gzip', CacheControl: 'private, max-age=0',
      })),
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: 'snapshots/latest.json', Body: rawBody,
        ContentType: 'application/json; charset=utf-8', CacheControl: shortLived,
      })),
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: 'state/persistence.json', Body: JSON.stringify(next),
        ContentType: 'application/json; charset=utf-8', CacheControl: shortLived,
      })),
    ])

    return { ok: true, observedAt: next.updatedAt, stations: Object.keys(next.stations).length }
  }
}

export const captureHandler = createCaptureHandler()
```

> **為什麼不直接用 `deriveStatePersistence()`？** 它是用 epoch 精確減 bucket 往回走、遇到缺格就斷，設計給整齊的 30 分鐘回放資料。這裡改用「起始時間戳」：一次漏抓不會把 3 小時的缺車歸零，只有超過 15 分鐘的空窗才重設。`deriveStatePersistence` 留給回放管線，不動。

### 1.4 測試

照 `tests/aws-handler.test.mjs` 的寫法：Node 24 直接 import `.ts`。

`app/tests/aws-capture.test.mjs`（新檔）：

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
const { alignToBucket, createCaptureHandler, mergePersistence, rawKeyFor } = await import('../aws/capture.ts')

const at = (iso) => new Date(iso)
const station = (id, bikes, docks, state = 'normal') => ({ id, availableBikes: bikes, availableDocks: docks, currentState: state })

test('carries stateSince while the state persists and resets when it changes', () => {
  const first = mergePersistence(null, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:00:00Z'))
  const second = mergePersistence(first, [station('a', 0, 20, 'empty_now')], at('2026-09-12T02:05:00Z'))
  assert.equal(second.stations.a.stateSince, '2026-09-12T01:00:00.000Z')
  assert.equal(second.stations.a.stateMinutes, 65)
  assert.equal(second.stations.a.unchangedMinutes, 65)
  const third = mergePersistence(second, [station('a', 3, 17, 'normal')], at('2026-09-12T02:10:00Z'))
  assert.equal(third.stations.a.stateMinutes, 0)
  assert.equal(third.stations.a.unchangedMinutes, 0)
})

test('resets everything after a gap longer than 15 minutes', () => {
  const first = mergePersistence(null, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:00:00Z'))
  const late = mergePersistence(first, [station('a', 0, 20, 'empty_now')], at('2026-09-12T01:20:00Z'))
  assert.equal(late.stations.a.stateMinutes, 0)
})

test('aligns to 5-minute buckets and partitions raw keys by Taipei date', () => {
  assert.equal(alignToBucket(at('2026-09-12T01:04:59Z')).toISOString(), '2026-09-12T01:00:00.000Z')
  assert.equal(rawKeyFor(at('2026-09-12T17:05:00Z')), 'raw/2026/09/13/0105.json.gz')
})

test('handler writes raw, latest and state objects', async () => {
  process.env.SITE_BUCKET = 'site'
  const feed = [{ sno: '500201001', sna: 'YouBike2.0_下庄市場', sarea: '八里區', tot_quantity: '20', sbi_quantity: '0', bemp: '20', act: '1', lat: '25.1', lng: '121.4', mday: '20260912T090000' }]
  const puts = []
  const s3 = { send: async (command) => {
    if (command.constructor.name === 'GetObjectCommand') throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
    puts.push(command.input); return {}
  } }
  const handler = createCaptureHandler({ s3, fetchImpl: async () => new Response(JSON.stringify(feed)), now: () => at('2026-09-12T01:02:00Z') })
  const result = await handler()
  assert.equal(result.stations, 1)
  assert.deepEqual(puts.map(p => p.Key).sort(), ['raw/2026/09/12/0900.json.gz', 'snapshots/latest.json', 'state/persistence.json'])
  const raw = puts.find(p => p.Key.startsWith('raw/'))
  assert.deepEqual(JSON.parse(gunzipSync(raw.Body).toString()), feed)
  const state = JSON.parse(puts.find(p => p.Key === 'state/persistence.json').Body)
  assert.equal(state.stations['500201001'].currentState, 'empty_now')
})
```

```bash
npm test
```

### 1.5 SAM template 新增段落

全部掛在 `CaptureEnabled` 條件後面。貼進 `app/infra/template.yaml` 對應區塊。

**Parameters 區塊**，接在 `CreateKnowledgeSourceBucket` 後面：

```yaml
  EnableSnapshotCapture:
    Type: String
    Default: 'false'
    AllowedValues: ['true', 'false']
    Description: Opt-in. Captures the official live feed every 5 minutes into the site bucket.

  AlertEmail:
    Type: String
    Default: ''
    Description: Optional e-mail for snapshot capture alarms. Empty creates no SNS topic.
    AllowedPattern: '^$|^[^@\s]+@[^@\s]+\.[^@\s]+$'
```

**Conditions 區塊**：

```yaml
  CaptureEnabled: !Equals [!Ref EnableSnapshotCapture, 'true']
  CaptureAlertsEnabled: !And
    - !Condition CaptureEnabled
    - !Not [!Equals [!Ref AlertEmail, '']]
```

**SiteBucket → Properties**，新增 lifecycle（raw/ 30 天轉 Glacier IR、180 天到期）：

```yaml
      LifecycleConfiguration:
        Rules:
          - Id: archive-raw-snapshots
            Status: Enabled
            Filter:
              Prefix: raw/
            Transitions:
              - StorageClass: GLACIER_IR
                TransitionInDays: 30
            ExpirationInDays: 180
```

**Resources**，接在 `OperationsApiLogGroup` 後面：

```yaml
  SnapshotCaptureFunction:
    Type: AWS::Serverless::Function
    Condition: CaptureEnabled
    Properties:
      CodeUri: ../
      Handler: aws/capture.captureHandler
      Runtime: nodejs24.x
      Architectures: [arm64]
      MemorySize: 256
      Timeout: 60
      ReservedConcurrentExecutions: 1        # 單一寫入者：兩次執行絕不重疊
      Description: Captures the official live feed every 5 minutes into raw/, snapshots/ and state/.
      Environment:
        Variables:
          SITE_BUCKET: !Ref SiteBucket
          LIVE_FEED_URL: !Ref LiveFeedUrl
      Policies:
        - Statement:
            - Sid: ReadWriteCapturePrefixesOnly
              Effect: Allow
              Action: [s3:GetObject, s3:PutObject]
              Resource:
                - !Sub '${SiteBucket.Arn}/raw/*'
                - !Sub '${SiteBucket.Arn}/snapshots/*'
                - !Sub '${SiteBucket.Arn}/state/*'
      Events:
        EveryFiveMinutes:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(5 minutes)
            FlexibleTimeWindow:
              Mode: 'OFF'
            RetryPolicy:
              MaximumRetryAttempts: 1
              MaximumEventAgeInSeconds: 240
    Metadata:
      BuildMethod: esbuild
      BuildProperties:
        EntryPoints: [aws/capture.ts]
        Format: esm
        Minify: true
        Sourcemap: false
        Target: es2022

  SnapshotCaptureLogGroup:
    Type: AWS::Logs::LogGroup
    Condition: CaptureEnabled
    DependsOn: SnapshotCaptureFunction
    DeletionPolicy: Delete
    UpdateReplacePolicy: Delete
    Properties:
      LogGroupName: !Sub '/aws/lambda/${SnapshotCaptureFunction}'
      RetentionInDays: !Ref LogRetentionDays

  ShortLivedDataCachePolicy:
    Type: AWS::CloudFront::CachePolicy
    Condition: CaptureEnabled
    Properties:
      CachePolicyConfig:
        Name: !Sub '${AWS::StackName}-short-lived-data'
        Comment: 60-second edge cache for scheduler-written JSON.
        MinTTL: 0
        DefaultTTL: 60
        MaxTTL: 120
        ParametersInCacheKeyAndForwardedToOrigin:
          EnableAcceptEncodingGzip: true
          EnableAcceptEncodingBrotli: true
          CookiesConfig: { CookieBehavior: none }
          HeadersConfig: { HeaderBehavior: none }
          QueryStringsConfig: { QueryStringBehavior: none }

  CaptureAlertTopic:
    Type: AWS::SNS::Topic
    Condition: CaptureAlertsEnabled
    Properties:
      Subscription:
        - Protocol: email
          Endpoint: !Ref AlertEmail

  SnapshotCaptureErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: CaptureEnabled
    Properties:
      AlarmDescription: Snapshot capture failed twice in a row; latest.json is going stale.
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions: [{ Name: FunctionName, Value: !Ref SnapshotCaptureFunction }]
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 2
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: !If [CaptureAlertsEnabled, [!Ref CaptureAlertTopic], []]

  SnapshotCaptureSilentAlarm:
    Type: AWS::CloudWatch::Alarm
    Condition: CaptureEnabled
    Properties:
      AlarmDescription: Snapshot capture has not run for 15 minutes; the scheduler may be disabled.
      Namespace: AWS/Lambda
      MetricName: Invocations
      Dimensions: [{ Name: FunctionName, Value: !Ref SnapshotCaptureFunction }]
      Statistic: Sum
      Period: 900
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: LessThanThreshold
      TreatMissingData: breaching
      AlarmActions: !If [CaptureAlertsEnabled, [!Ref CaptureAlertTopic], []]
```

**SiteDistribution → CacheBehaviors**，加在 `/api/*` 那一條前面：

```yaml
          - !If
            - CaptureEnabled
            - PathPattern: /snapshots/*
              TargetOriginId: site-s3
              ViewerProtocolPolicy: redirect-to-https
              Compress: true
              AllowedMethods: [GET, HEAD]
              CachedMethods: [GET, HEAD]
              CachePolicyId: !Ref ShortLivedDataCachePolicy
            - !Ref AWS::NoValue
          - !If
            - CaptureEnabled
            - PathPattern: /state/*
              TargetOriginId: site-s3
              ViewerProtocolPolicy: redirect-to-https
              Compress: true
              AllowedMethods: [GET, HEAD]
              CachedMethods: [GET, HEAD]
              CachePolicyId: !Ref ShortLivedDataCachePolicy
            - !Ref AWS::NoValue
```

**Outputs**：

```yaml
  SnapshotCaptureEnabled:
    Description: Whether the 5-minute snapshot capture is deployed. Read by aws:publish.
    Value: !Ref EnableSnapshotCapture
```

> ⚠️ **預設的 CachingOptimized policy 快取 24 小時。** 不加上面那兩條 CacheBehavior 的話，`latest.json` 會在 CloudFront 邊緣卡一整天，畫面永遠是舊的。這是這一階段最容易漏的一步。

### 1.6 部署與發布腳本

`app/scripts/aws-cli-utils.mjs`，兩個 Set 各加一個名字：

```js
const optionNames = new Set([ /* …既有… */ 'url', 'alert-email' ])
const booleanNames = new Set([ /* …既有… */ 'confirm-agent-cost', 'enable-capture' ])
```

`app/scripts/aws-deploy.mjs`，parameters 陣列：

```js
  const parameters = [
    /* …既有四筆… */
    `EnableSnapshotCapture=${options['enable-capture'] ? 'true' : 'false'}`,
  ]
  if (options['alert-email']) parameters.push(`AlertEmail=${options['alert-email']}`)
```

`app/scripts/aws-publish.mjs`，build 環境變數 + s3 sync 排除：

```js
  const captureEnabled = outputs.SnapshotCaptureEnabled === 'true'
  runNpmScript('build', {
    NUXT_PUBLIC_LIVE_STATIONS_ENDPOINT: '/api/v1/live-stations',
    NUXT_PUBLIC_LIVE_SNAPSHOT_PATH: captureEnabled ? '/snapshots/latest.json' : '',
    NUXT_PUBLIC_PERSISTENCE_PATH: captureEnabled ? '/state/persistence.json' : '',
    NUXT_PUBLIC_AGENT_ENABLED: String(agentEnabled),
    NUXT_PUBLIC_AGENT_REVIEW_ENDPOINT: '/api/v1/agent-review',
  })

  // s3 sync … --delete 的 --exclude 清單，補三個 Lambda 寫入的前綴：
    '--exclude', '_headers',
    '--exclude', '_routes.json',
    '--exclude', 'raw/*',
    '--exclude', 'snapshots/*',
    '--exclude', 'state/*',
```

> 🛑 **沒有那三個 `--exclude`，每次 `aws:publish` 的 `--delete` 會把 Lambda 抓的所有快照刪光。** 先改腳本，再開旗標。

### 1.7 前端改讀 S3 快照，失敗才退回 Lambda 代理

`app/nuxt.config.ts`，`runtimeConfig.public`：

```ts
      liveStationsEndpoint: process.env.NUXT_PUBLIC_LIVE_STATIONS_ENDPOINT || '/api/v1/live-stations',
      liveSnapshotPath: process.env.NUXT_PUBLIC_LIVE_SNAPSHOT_PATH || '',     // 空字串 = 不用快照（Cloudflare）
      persistencePath: process.env.NUXT_PUBLIC_PERSISTENCE_PATH || '',
```

`app/composables/useLiveDashboard.ts`，`useLiveDashboard()` 內，取代第 308 行的單一 `$fetch`：

```ts
  const snapshotPath = String(useRuntimeConfig().public.liveSnapshotPath || '')
  const STALE_AFTER_MS = 15 * 60_000

  /** 先讀 S3 快照；沒有、壞掉、或超過 15 分鐘沒更新，就退回 Lambda 代理。 */
  async function loadRawStations(): Promise<unknown> {
    if (snapshotPath) {
      try {
        const raw = await $fetch<unknown>(snapshotPath, { cache: 'no-store' })
        if (Array.isArray(raw) && raw.length) {
          const asOf = Date.parse(createLiveResponse(raw).meta.asOf)
          if (Number.isFinite(asOf) && Date.now() - asOf < STALE_AFTER_MS) return raw
        }
      } catch { /* 退回代理 */ }
    }
    return $fetch<unknown>(liveStationsEndpoint, { cache: 'no-store' })
  }

  // refresh() 內：
  const [rawStations] = await Promise.all([loadRawStations(), persistence.refresh()])
  const response = createLiveResponse(rawStations)
```

`latest.json` 就是官方 API 的原始陣列，`createLiveResponse()` 一行不用改。

### 1.8 持續時間進告警、壞車進品質旗標

`app/composables/useStationPersistence.ts`（新檔）：

```ts
import type { PersistenceState, StationPersistence } from '~/aws/capture'

export type PersistenceLookup = (stationId: string) => StationPersistence | null

export function useStationPersistence() {
  const path = String(useRuntimeConfig().public.persistencePath || '')
  const state = useState<PersistenceState | null>('station-persistence', () => null)

  async function refresh() {
    if (!path) return
    try { state.value = await $fetch<PersistenceState>(path, { cache: 'no-store' }) }
    catch { state.value = null }          // 沒有檔案就跟今天一樣：持續時間 0
  }

  const lookup = computed<PersistenceLookup>(() => (id) => state.value?.stations[id] ?? null)
  return { state, refresh, lookup }
}
```

`app/shared/live-operations.ts`，`buildLiveOperations` 多收一個 lookup，傳給 `actionableAlert`：

```ts
export interface LiveOperationOptions extends Partial<LiveOperationPolicy> {
  persistence?: (stationId: string) => { stateSince: string; stateMinutes: number } | null
}

export function buildLiveOperations(stations, observedAt, options: LiveOperationOptions = {}) {
  const policy = normalizedPolicy(options)               // 只挑數值欄位，persistence 不會進 policy
  const persistence = options.persistence
  // …
    .map(station => actionableAlert(station, observedAt, policy, persistence))

// actionableAlert 內，兩處寫 startedAt / durationMinutes 的地方都改成：
  const carried = currentFailure ? persistence?.(station.id) ?? null : null   // 只有「已發生」才有持續時間
  // …
      startedAt: carried?.stateSince ?? observedAt,
      durationMinutes: carried?.stateMinutes ?? 0,
  // scoreAlertPriority 多傳一個欄位：
  const score = scoreAlertPriority({ riskScore, currentFailure, gap, quality: alertDataQuality(station, forecast),
    durationMinutes: carried?.stateMinutes ?? 0 })
```

`app/shared/operational-policy.mjs`，`scoreAlertPriority`：

```js
  const scoreParts = {
    forecast: rounded(clamp(finite(input.riskScore), 0, 1) * 25),
    current: input.currentFailure ? 50 : 0,
    gap: rounded(clamp(finite(input.gap) / 8, 0, 1) * 20),
    quality: rounded(clamp(finite(input.quality), 0, 1) * 5),
    // 每缺車一小時 +10，上限 +15。ALERT_THRESHOLDS 是模型門檻，不動；這裡是營運排序。
    duration: rounded(Math.min(15, Math.max(0, finite(input.durationMinutes)) / 60 * 10)),
  }
  return {
    priorityScore: Math.min(100, rounded(Object.values(scoreParts).reduce((sum, value) => sum + value, 0))),
    scoreParts,
  }
```

`app/composables/useLiveDashboard.ts`，`qualityFlagsFor` 多收 `persisted`；`createLiveDashboard` / `scopedDashboard` / `pages/index.vue` 的 XGBoost 分支都把 lookup 傳進 `buildLiveOperations`：

```ts
const FROZEN_AFTER_MINUTES = 180

function taipeiHour(iso: string) { return new Date(Date.parse(iso) + 8 * 60 * 60_000).getUTCHours() }

function qualityFlagsFor(station, forecasts, persisted: StationPersistence | null, observedAt: string) {
  const flags: string[] = []
  // …既有三條…
  const daytime = taipeiHour(observedAt) >= 6                      // 深夜沒動是正常的，不判
  if (persisted && daytime && persisted.unchangedMinutes >= FROZEN_AFTER_MINUTES) {
    const hours = Math.floor(persisted.unchangedMinutes / 60)
    flags.push(`疑似壞車／感測異常：庫存已 ${hours} 小時未變化${station.capacityGap > 0 ? `，帳面差額 ${station.capacityGap} 格` : ''}。`)
  }
  return flags
}
```

顯示：`AlertList.vue` 告警列在站名旁加 `已缺車 {{ h }} 小時 {{ m }} 分`；`StationDetailPanel.vue` 的品質旗標區已經會列出 `qualityFlags`，壞車那一條自動出現。旗標旁加「登記排除窗」連到 `/admin/adjustments?station=…&startAt=…`。

> ✅ **Cloudflare Pages 完全不受影響。** `liveSnapshotPath` 與 `persistencePath` 在那裡是空字串：走原本的 Functions 代理，持續時間維持 0，行為跟今天一模一樣。同一份程式碼、兩個主機。

### 1.9 部署與驗證

```bash
cd app
npm test && npx nuxt typecheck

# 1) 先只部署基礎設施（旗標打開，但前端還沒重新發布）
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION> --enable-capture --alert-email you@example.com
#    → 收到 SNS 訂閱確認信，點連結

# 2) 等 5–10 分鐘，確認 Lambda 真的在寫
aws s3 ls s3://<SiteBucketName>/snapshots/ --region <REGION>
aws s3 ls s3://<SiteBucketName>/raw/ --recursive --region <REGION> | tail -3
aws logs tail /aws/lambda/<SnapshotCaptureFunction> --since 15m --region <REGION>

# 3) 從 CloudFront 讀到的要是 JSON，且 updatedAt 在 10 分鐘內
curl -s https://<SiteUrl>/state/persistence.json | head -c 300
curl -sI https://<SiteUrl>/snapshots/latest.json | grep -i 'cache-control\|x-cache'

# 4) 發布前端（會自動帶入 NUXT_PUBLIC_LIVE_SNAPSHOT_PATH）
npm run aws:publish -- --stack ctrlcity-hackathon --region <REGION>
npm run aws:smoke   -- --stack ctrlcity-hackathon --region <REGION>
```

打開網站，DevTools → Network：每 5 分鐘應該只看到 `latest.json` 與 `persistence.json`，不再有 `/api/v1/live-stations`。把某站故意等它缺車超過一小時，告警列會出現持續時間。

### 1.10 Smoke test 擴充

`app/scripts/aws-smoke.mjs`，在 live station proxy 檢查後面：

```js
  if (outputs.SnapshotCaptureEnabled === 'true') {
    const latest = await expectJson(`${baseUrl}/snapshots/latest.json`, { expectedStatus: 200 })
    if (!Array.isArray(latest) || !latest.length) throw new Error('latest.json is not a station array.')
    const state = await expectJson(`${baseUrl}/state/persistence.json`, { expectedStatus: 200 })
    const ageMinutes = (Date.now() - Date.parse(state.updatedAt)) / 60_000
    if (!(ageMinutes < 15)) throw new Error(`persistence.json is ${Math.round(ageMinutes)} minutes old; the scheduler may be stopped.`)
  }
```

---

## 2. 第二階段：在雲端重建歷史剖面

目標：`npm run data:build` 不再需要一台有 CSV 的本機。原始 CSV 放私有 S3，CodeBuild 拉下來跑**既有腳本、零改動**，產出直接發布。`data:profile` 需要 12 GB heap，Lambda 做不到（上限 10 GB、15 分鐘），CodeBuild `BUILD_GENERAL1_LARGE` 有 15 GB、按分鐘計費、沒有閒置成本。

Source 用 S3 zip 而不是 GitHub 連結：建置的就是你本機這一版，不需要在 CodeBuild 設 GitHub 授權。

### 2.1 先確認資料條款

> ⚠️ **主辦方提供的 CSV 目前「僅留本機且不進 Git」。** 把它放進你們的 AWS 帳號（即使是私有 bucket）是新的儲存位置，先跟主辦方確認允許。README 對知識 bucket 寫的「不含原始 CSV」是 Agent 用途的限制，build 用途要另外確認。確認前，這一階段可以先只用第一階段累積的 `raw/` 快照（見 2.5）。

### 2.2 SAM template 新增段落

**Parameters / Conditions**：

```yaml
  CreateBuildRunner:
    Type: String
    Default: 'false'
    AllowedValues: ['true', 'false']
    Description: Opt-in. Creates a private raw-data bucket and a CodeBuild project that rebuilds the historical profile.

# Conditions
  BuildRunnerEnabled: !Equals [!Ref CreateBuildRunner, 'true']
```

**Resources**：

```yaml
  RawDataBucket:
    Type: AWS::S3::Bucket
    Condition: BuildRunnerEnabled
    DeletionPolicy: Retain                   # 原始資料不跟著 stack 刪
    UpdateReplacePolicy: Retain
    Properties:
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault: { SSEAlgorithm: AES256 }
      OwnershipControls:
        Rules: [{ ObjectOwnership: BucketOwnerEnforced }]
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
      VersioningConfiguration: { Status: Enabled }
      Tags:
        - { Key: project, Value: ctrlcity-youbike }
        - { Key: environment, Value: !Ref EnvironmentName }
        - { Key: purpose, Value: raw-dataset-and-build-artifacts }

  BuildRunnerRole:
    Type: AWS::IAM::Role
    Condition: BuildRunnerEnabled
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal: { Service: codebuild.amazonaws.com }
            Action: sts:AssumeRole
      Policies:
        - PolicyName: history-build
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: [logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents]
                Resource: !Sub 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}-*'
              - Effect: Allow
                Action: [s3:GetObject, s3:ListBucket, s3:PutObject]
                Resource: [!GetAtt RawDataBucket.Arn, !Sub '${RawDataBucket.Arn}/*']
              - Effect: Allow
                Action: [s3:GetObject, s3:ListBucket, s3:PutObject, s3:DeleteObject]
                Resource: [!GetAtt SiteBucket.Arn, !Sub '${SiteBucket.Arn}/*']
              - Effect: Allow
                Action: cloudfront:CreateInvalidation
                Resource: !Sub 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${SiteDistribution}'

  HistoryBuildProject:
    Type: AWS::CodeBuild::Project
    Condition: BuildRunnerEnabled
    Properties:
      Name: !Sub '${AWS::StackName}-history-build'
      Description: Rebuilds dashboard.json and the live-profile shards from the raw dataset, then publishes the site.
      ServiceRole: !GetAtt BuildRunnerRole.Arn
      Artifacts: { Type: NO_ARTIFACTS }
      TimeoutInMinutes: 90
      Environment:
        Type: LINUX_CONTAINER
        ComputeType: BUILD_GENERAL1_LARGE      # 8 vCPU / 15 GB：data:profile 要 12 GB heap
        Image: aws/codebuild/standard:7.0
        EnvironmentVariables:
          - { Name: RAW_DATA_BUCKET, Value: !Ref RawDataBucket }
          - { Name: SITE_BUCKET, Value: !Ref SiteBucket }
          - { Name: DISTRIBUTION_ID, Value: !Ref SiteDistribution }
          - { Name: SNAPSHOT_CAPTURE_ENABLED, Value: !Ref EnableSnapshotCapture }
      Source:
        Type: S3
        Location: !Sub '${RawDataBucket}/source/repo.zip'
        BuildSpec: app/infra/buildspec-history.yml
      LogsConfig:
        CloudWatchLogs: { Status: ENABLED }
      Tags:
        - { Key: project, Value: ctrlcity-youbike }
        - { Key: environment, Value: !Ref EnvironmentName }
```

**Outputs**：

```yaml
  RawDataBucketName:
    Condition: BuildRunnerEnabled
    Value: !Ref RawDataBucket
  HistoryBuildProjectName:
    Condition: BuildRunnerEnabled
    Value: !Ref HistoryBuildProject
```

### 2.3 buildspec

`app/infra/buildspec-history.yml`（新檔）：

```yaml
version: 0.2

env:
  variables:
    NODE_OPTIONS: --max-old-space-size=12288
    CTRL_CITY_DATASET_DIR: /codebuild/dataset      # build-artifacts.mjs 與 station-time-profile.mjs 都讀這個環境變數

phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - cd app && npm ci

  pre_build:
    commands:
      - mkdir -p "$CTRL_CITY_DATASET_DIR"
      - aws s3 sync "s3://$RAW_DATA_BUCKET/dataset/" "$CTRL_CITY_DATASET_DIR/"
      # 第一階段累積的快照也併進來（2.5 的轉換腳本）
      - if [ "$SNAPSHOT_CAPTURE_ENABLED" = "true" ]; then node scripts/raw-snapshots-to-csv.mjs --bucket "$SITE_BUCKET" --out "$CTRL_CITY_DATASET_DIR/captured-live.csv"; fi
      # 第三階段之後：S3 上的排除窗才是真相，覆蓋 repo 裡的種子檔
      - aws s3 cp "s3://$SITE_BUCKET/data/operational-adjustments.json" data/operational-adjustments.json || echo "using committed seed"

  build:
    commands:
      - npm run data:build
      - npm run data:profile
      - npm run data:validate
      - npm test
      - NUXT_PUBLIC_LIVE_STATIONS_ENDPOINT=/api/v1/live-stations
        NUXT_PUBLIC_LIVE_SNAPSHOT_PATH=$([ "$SNAPSHOT_CAPTURE_ENABLED" = "true" ] && echo /snapshots/latest.json)
        NUXT_PUBLIC_PERSISTENCE_PATH=$([ "$SNAPSHOT_CAPTURE_ENABLED" = "true" ] && echo /state/persistence.json)
        npm run build

  post_build:
    commands:
      # 留一份可追溯的產物
      - STAMP=$(date -u +%Y%m%dT%H%MZ)
      - aws s3 cp data/dashboard.json "s3://$RAW_DATA_BUCKET/artifacts/$STAMP/dashboard.json"
      - aws s3 cp data/operational-roi.json "s3://$RAW_DATA_BUCKET/artifacts/$STAMP/operational-roi.json"
      # 跟 aws-publish.mjs 完全一樣的上傳規則
      - aws s3 sync dist/ "s3://$SITE_BUCKET" --delete --exclude _headers --exclude _routes.json --exclude 'raw/*' --exclude 'snapshots/*' --exclude 'state/*' --cache-control "public,max-age=300,must-revalidate"
      - aws s3 cp dist/_nuxt "s3://$SITE_BUCKET/_nuxt" --recursive --cache-control "public,max-age=31536000,immutable"
      - aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
```

`build-artifacts.mjs:36` 已經支援 `CTRL_CITY_DATASET_DIR`；確認 `station-time-profile.mjs` 讀同一個變數，沒有的話補上（它現在應該也是 `resolve(REPO_DIR, 'docs', '資料集')`）。

### 2.4 觸發腳本

`app/scripts/aws-rebuild.mjs`（新檔；`package.json` 加 `"aws:rebuild": "node scripts/aws-rebuild.mjs"`）：

```js
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { appDir, awsArgs, commandAvailable, parseOptions, readStackOutputs, resolveRegion, run } from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is not installed or not on PATH.')
  options.region = resolveRegion(options)
  const outputs = readStackOutputs(options)
  const bucket = outputs.RawDataBucketName
  const project = outputs.HistoryBuildProjectName
  if (!bucket || !project) throw new Error('Stack was deployed without --build-runner.')

  // 打包「目前 commit」的工作樹；未 commit 的變更不會進去，跟 CI 一樣誠實。
  const zip = resolve(tmpdir(), `ctrlcity-source-${Date.now()}.zip`)
  run('git', ['-C', resolve(appDir, '..'), 'archive', '--format=zip', '-o', zip, 'HEAD'])
  run('aws', awsArgs(options, ['s3', 'cp', zip, `s3://${bucket}/source/repo.zip`]))

  const started = run('aws', awsArgs(options, ['codebuild', 'start-build', '--project-name', project, '--query', 'build.id', '--output', 'text']), { capture: true })
  console.log(`Started ${started.trim()}. Follow with: aws codebuild batch-get-builds --ids ${started.trim()} --region ${options.region}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
```

`aws-cli-utils.mjs` 的 `booleanNames` 加 `'build-runner'`；`aws-deploy.mjs` 的 parameters 加 `CreateBuildRunner=…`。

### 2.5 把累積快照轉成管線吃的 CSV

這是「歷史資料開始滾動」的關鍵。`build-artifacts.mjs` 吃主辦方 CSV 的格式（`日期、城市、行政區、場站名稱、總車柱數、可借車數、可還位數、經度、緯度`，30 分鐘一筆）。寫一支 `scripts/raw-snapshots-to-csv.mjs`：

- 列出 `raw/YYYY/MM/DD/*.json.gz`，每天只取 `:00` 與 `:30` 那兩筆（5 分鐘快照有 6 倍密度，管線的統計格是 30 分鐘）。
- 欄位對應：`mday` → 日期時間、`scity` → 城市、`sarea` → 行政區、`sna` → 場站名稱、`tot_quantity / sbi_quantity / bemp` → 三個數字、`lat / lng` → 座標。輸出 UTF-8，管線本來就自動偵測編碼。
- 寫一個測試：產出的 CSV 餵進 `build-artifacts.mjs` 的列解析函數，欄位要和主辦方 CSV 解出來的形狀一致。**欄位名稱以那支解析函數為準**，不要靠這份文件的列表。

做完之後，第一個月的效果是「7、8、9 月自動補進剖面」；半年後主辦方那份 CSV 就只是歷史的一部分了。

### 2.6 執行與驗證

```bash
# 部署（旗標與第一階段可以一起開）
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION> --enable-capture --build-runner

# 上傳原始 CSV（2.1 確認過條款之後）
aws s3 sync "../docs/資料集/" "s3://<RawDataBucketName>/dataset/" --exclude "*" --include "*.csv" --region <REGION>

# 觸發、追蹤
npm run aws:rebuild -- --stack ctrlcity-hackathon --region <REGION>
aws codebuild batch-get-builds --ids <build-id> --query 'builds[0].[buildStatus,currentPhase]' --output text --region <REGION>
aws logs tail /aws/codebuild/ctrlcity-hackathon-history-build --follow --region <REGION>

# 完成後：線上的 manifest.json 應該有新的 generatedAt 與更大的 populatedStationSlots
curl -s https://<SiteUrl>/data/live-profile/manifest.json | head -c 400
```

> **從此 `app/data/dashboard.json` 不再是 git 的輸入，而是 CodeBuild 的輸出。** repo 裡那份會落後線上。要嘛定期把 `artifacts/<stamp>/dashboard.json` 下載回來 commit（讓本機 dev 有資料），要嘛在 README 註明本機開發用的是舊快照。建議前者，一個月一次。

---

## 3. 第三階段：排除窗與活動寫回 S3

今天的流程：調度人員在 `/admin/adjustments` 編輯 → 資料只在他的瀏覽器 → 按匯出 → 把 JSON 覆蓋進 repo → 重跑統計。改成：編輯 → `PUT /api/v1/adjustments` → S3 上的 `data/operational-adjustments.json` → 第二階段的 CodeBuild 建置前會先拉這一份。**讀取不需要登入**（排除窗不是機密，每個裝置都該看到同一份），只有寫入要 Cognito JWT。

### 3.1 Cognito 與 JWT authorizer

**Parameters / Conditions**：

```yaml
  EnableDispatcherLogin:
    Type: String
    Default: 'false'
    AllowedValues: ['true', 'false']
    Description: Opt-in. Creates a Cognito user pool that protects the operator write endpoints.

# Conditions
  LoginEnabled: !Equals [!Ref EnableDispatcherLogin, 'true']
```

**Resources**：

```yaml
  DispatcherUserPool:
    Type: AWS::Cognito::UserPool
    Condition: LoginEnabled
    Properties:
      UserPoolName: !Sub '${AWS::StackName}-dispatchers'
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }     # 不開放自助註冊
      UsernameAttributes: [email]
      AutoVerifiedAttributes: [email]
      MfaConfiguration: 'OFF'
      Policies:
        PasswordPolicy: { MinimumLength: 12, RequireUppercase: true, RequireLowercase: true, RequireNumbers: true, RequireSymbols: false }
      DeletionProtection: INACTIVE

  DispatcherUserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Condition: LoginEnabled
    Properties:
      UserPoolId: !Ref DispatcherUserPool
      ClientName: ctrlcity-web
      GenerateSecret: false                                           # SPA 用 PKCE，不能有 secret
      AllowedOAuthFlowsUserPoolClient: true
      AllowedOAuthFlows: [code]
      AllowedOAuthScopes: [openid, email]
      SupportedIdentityProviders: [COGNITO]
      CallbackURLs: [!Sub 'https://${SiteDistribution.DomainName}/admin/callback']
      LogoutURLs: [!Sub 'https://${SiteDistribution.DomainName}/']
      AccessTokenValidity: 1
      IdTokenValidity: 1
      RefreshTokenValidity: 12
      TokenValidityUnits: { AccessToken: hours, IdToken: hours, RefreshToken: hours }

  DispatcherUserPoolDomain:
    Type: AWS::Cognito::UserPoolDomain
    Condition: LoginEnabled
    Properties:
      UserPoolId: !Ref DispatcherUserPool
      Domain: !Sub '${AWS::StackName}-${AWS::AccountId}'
```

**OperationsApi → Properties**，加 Auth：

```yaml
      Auth: !If
        - LoginEnabled
        - Authorizers:
            DispatcherJwt:
              JwtConfiguration:
                issuer: !Sub 'https://cognito-idp.${AWS::Region}.amazonaws.com/${DispatcherUserPool}'
                audience: [!Ref DispatcherUserPoolClient]
              IdentitySource: '$request.header.Authorization'
        - !Ref AWS::NoValue
```

**OperationsApiFunction → Events**（讀公開、寫要 JWT）與 Policies：

```yaml
        AdjustmentsRead:
          Type: HttpApi
          Properties: { ApiId: !Ref OperationsApi, Path: /api/v1/adjustments, Method: GET }
        AdjustmentsWrite:
          Type: HttpApi
          Properties:
            ApiId: !Ref OperationsApi
            Path: /api/v1/adjustments
            Method: PUT
            Auth: !If [LoginEnabled, { Authorizer: DispatcherJwt }, !Ref AWS::NoValue]
        EventsRead:
          Type: HttpApi
          Properties: { ApiId: !Ref OperationsApi, Path: /api/v1/events, Method: GET }
        EventsWrite:
          Type: HttpApi
          Properties:
            ApiId: !Ref OperationsApi
            Path: /api/v1/events
            Method: PUT
            Auth: !If [LoginEnabled, { Authorizer: DispatcherJwt }, !Ref AWS::NoValue]

# Policies 加一條：
            - Sid: ReadWriteOperatorFiles
              Effect: Allow
              Action: [s3:GetObject, s3:PutObject]
              Resource:
                - !Sub '${SiteBucket.Arn}/data/operational-adjustments.json'
                - !Sub '${SiteBucket.Arn}/data/demand-events.json'
# Environment 加：
          SITE_BUCKET: !Ref SiteBucket
          OPERATOR_WRITE_ENABLED: !If [LoginEnabled, 'true', 'false']
```

> ⚠️ **登入沒開時，PUT 路由必須拒絕。** 上面的 `OPERATOR_WRITE_ENABLED` 就是給 handler 用的：旗標關著就回 `503 OPERATOR_WRITE_DISABLED`，不能因為沒有 authorizer 就變成匿名可寫。

### 3.2 Handler 新增兩對路由

用 S3 的條件式寫入（`IfMatch`）做樂觀鎖：兩個人同時編輯，後存的人會拿到 412，前端提示重新載入再改。

`app/aws/handler.ts`，`createLambdaHandler` 的路由判斷內：

```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { parseAdjustmentsFile } from '../shared/operational-adjustments.mjs'

const OPERATOR_FILES = {
  '/api/v1/adjustments': { key: 'data/operational-adjustments.json', parse: parseAdjustmentsFile },
  '/api/v1/events':      { key: 'data/demand-events.json',          parse: parseDemandEventsFile },  // 提案第 4 項的模組
} as const
const MAX_OPERATOR_FILE_BYTES = 64 * 1024

// …在 404 之前：
    const operatorFile = OPERATOR_FILES[path as keyof typeof OPERATOR_FILES]
    if (operatorFile && method === 'GET') return readOperatorFile(operatorFile.key)
    if (operatorFile && method === 'PUT') {
      if (environmentValue('OPERATOR_WRITE_ENABLED') !== 'true') {
        return json(503, { error: { code: 'OPERATOR_WRITE_DISABLED', message: 'Operator edits are not enabled for this deployment.' } })
      }
      return writeOperatorFile(operatorFile, event)
    }

async function readOperatorFile(key: string): Promise<HttpApiResponse> {
  const bucket = environmentValue('SITE_BUCKET')!
  try {
    const object = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', etag: object.ETag ?? '' },
      body: (await object.Body?.transformToString()) ?? '{"adjustments":[]}',
    }
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return json(200, { adjustments: [] })
    throw error
  }
}

async function writeOperatorFile(file: { key: string; parse: (raw: unknown) => unknown[] }, event: HttpApiEvent): Promise<HttpApiResponse> {
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '')
  if (Buffer.byteLength(body, 'utf8') > MAX_OPERATOR_FILE_BYTES) {
    return json(413, { error: { code: 'OPERATOR_FILE_TOO_LARGE', message: 'Payload exceeds 64 KB.' } })
  }
  let parsed: unknown[]
  try { parsed = file.parse(JSON.parse(body)) } catch {
    return json(400, { error: { code: 'INVALID_OPERATOR_FILE', message: 'Body must be valid JSON in the export format.' } })
  }
  const ifMatch = event.headers?.['if-match']
  try {
    const result = await new S3Client({}).send(new PutObjectCommand({
      Bucket: environmentValue('SITE_BUCKET')!, Key: file.key,
      Body: JSON.stringify({ schemaVersion: '1.0', exportedAt: new Date().toISOString(), adjustments: parsed }, null, 2),
      ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store',
      ...(ifMatch ? { IfMatch: ifMatch } : { IfNoneMatch: '*' }),   // 沒帶 ETag 只允許「建立」，不允許盲目覆蓋
    }))
    return json(200, { saved: parsed.length, etag: result.ETag })
  } catch (error) {
    if ((error as { name?: string }).name === 'PreconditionFailed') {
      return json(412, { error: { code: 'OPERATOR_FILE_CHANGED', message: 'Someone else saved first. Reload and try again.' } })
    }
    throw error
  }
}
```

`tests/aws-handler.test.mjs` 加：GET 沒檔案回空陣列、PUT 超過 64 KB 回 413、PUT 缺 ETag 且檔案已存在回 412、旗標關閉回 503。

### 3.3 前端：登入與遠端模式

- 裝 `oidc-client-ts`（Cognito Hosted UI 的 code + PKCE 流程）。新 composable `useDispatcherAuth()`：`signIn()` 導向 Hosted UI、`/admin/callback` 頁面換 token、`accessToken` 放在記憶體（不進 localStorage）。
- `nuxt.config.ts` 加 `adjustmentsEndpoint`、`eventsEndpoint`、`cognitoAuthority`、`cognitoClientId`；`aws-publish.mjs` 從 stack outputs 帶入。
- `useOperationalAdjustments()` 加「遠端模式」：endpoint 非空時，`onMounted` 改 GET 遠端（記住回應的 ETag），`persist()` 改成 PUT 帶 `If-Match`；412 時顯示「有人先存了，請重新載入」。localStorage 降為離線草稿。`exportPayload` 按鈕文案改成「儲存到雲端」。
- 沒登入時 `/admin/adjustments` 仍可讀，編輯區顯示「登入後可編輯」與登入按鈕。
- 提案第 4 項的 `useDemandEvents()` 從一開始就用同一套遠端模式。

CloudFront 的 `/api/*` 已經用 `AllViewerExceptHostHeader` 轉送所有 header，`Authorization` 會到 API Gateway，不用再改 distribution。

### 3.4 部署與建立使用者

```bash
npm run aws:deploy -- --stack ctrlcity-hackathon --region <REGION> --enable-capture --build-runner --dispatcher-login

# 建立第一個調度人員（AdminCreateUserOnly，沒有自助註冊）
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username dispatcher@example.com \
  --user-attributes Name=email,Value=dispatcher@example.com Name=email_verified,Value=true \
  --temporary-password 'Temp-Password-123' --region <REGION>

npm run aws:publish -- --stack ctrlcity-hackathon --region <REGION>

# 驗證：沒 token 的 PUT 要被擋
curl -s -X PUT https://<SiteUrl>/api/v1/adjustments -d '{"adjustments":[]}' -i | head -1     # → 401
curl -s https://<SiteUrl>/api/v1/adjustments | head -c 200                                    # → 200，公開可讀
```

`aws-cli-utils.mjs` 的 `booleanNames` 加 `'dispatcher-login'`，deploy 腳本加 `EnableDispatcherLogin=…`，Outputs 加 `UserPoolId`、`UserPoolClientId`、`UserPoolDomain`。

---

## 4. 成本與回滾

| 項目 | 用量 | 每月估算 |
|---|---|---:|
| EventBridge Scheduler | 8,640 次觸發 | $0.01 |
| capture Lambda | 8,640 次 × 約 1.5 秒 × 256 MB | 免費額度內 |
| S3 raw/ 儲存與 PUT | 約 430 MB 新增（gzip）、26k 次 PUT | $0.15 |
| CloudFront | `latest.json` 邊緣快取 60 秒；Lambda 呼叫減少 | 比現在低 |
| CodeBuild LARGE | 每次重建約 30 分鐘 × $0.02/分 | $0.60／次 |
| Cognito | < 10 個使用者 | 免費額度內 |
| SNS e-mail | 只有告警時發 | ≈ $0 |

**回滾：** 每個階段都是一個旗標。重跑 `aws:deploy` 不帶那個旗標，資源就從 stack 移除；`RawDataBucket` 設了 `Retain`，原始資料不會跟著消失。前端不重新發布也沒關係 — 找不到 `latest.json` 會自動退回 Lambda 代理。

**時區：** 所有時間戳都是 UTC ISO，只有 `raw/` 的資料夾名稱用台北日期。前端本來就用 `Asia/Taipei` 顯示，不用改。

---

## 5. 驗收：三階段完成的判準

- [ ] `npm test` 含 `aws-capture.test.mjs` 全過；`npx nuxt typecheck` 乾淨
- [ ] CloudFront 上 `/state/persistence.json` 的 `updatedAt` 持續在 10 分鐘內；`x-cache` 在第二次請求變成 Hit
- [ ] DevTools Network 每 5 分鐘只有 `latest.json` 與 `persistence.json`，沒有 `/api/v1/live-stations`
- [ ] 手動把 Scheduler 停掉 15 分鐘 → 收到 `SnapshotCaptureSilentAlarm` 信；前端自動退回代理、畫面仍更新
- [ ] 一站缺車超過 60 分鐘 → 告警列出現「已缺車 1 小時 N 分」，且在兩台不同電腦上數字一致
- [ ] `aws:publish` 跑完後 `aws s3 ls s3://…/raw/` 仍有資料（`--exclude` 生效）
- [ ] Cloudflare Pages 的 Demo 行為與改動前完全相同
- [ ] CodeBuild 一次成功；線上 `manifest.json` 的 `generatedAt` 更新、`populatedStationSlots` 增加
- [ ] `artifacts/<stamp>/dashboard.json` 存在於 raw bucket
- [ ] 沒 token 的 `PUT /api/v1/adjustments` → 401；旗標關閉時 → 503；兩人同時存 → 後者 412
- [ ] 調度人員在 A 電腦登記排除窗，B 電腦重新整理後看得到

---

行號與檔名以 `8d708dd` 為準。YAML 與程式碼都是可以直接貼的版本，但 CloudFormation 的條件式列表項目（`!If … !Ref AWS::NoValue`）在 `sam validate --lint` 過了再 deploy。
