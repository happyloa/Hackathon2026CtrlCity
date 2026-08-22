import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type InvokeHarnessStreamOutput,
} from '@aws-sdk/client-bedrock-agentcore'
import { environmentValue } from './runtime-env.ts'

const DEFAULT_LIVE_FEED_URL =
  'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024
const MAX_AGENT_OUTPUT_CHARS = 24_000
const MAX_FACTS = 12

export interface HttpApiEvent {
  rawPath?: string
  rawQueryString?: string
  body?: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string | undefined>
  requestContext?: {
    requestId?: string
    http?: { method?: string; path?: string }
  }
}

export interface HttpApiResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
  isBase64Encoded?: boolean
}

export interface AgentReviewFact {
  label: string
  value: string | number
  stationId?: string
  alertId?: string
  dispatchId?: string
}

export interface AgentReviewRequest {
  asOf: string
  district: string
  horizonMinutes: 60
  summary: {
    recommendedMoves: number
    persistentAlerts: number
    emptyNow: number
    fullNow: number
  }
  facts: AgentReviewFact[]
}

export interface AgentReviewPayload {
  headline: string
  narrative: string
  cautions: string[]
  citations: Array<{ label: string; source?: string }>
}

interface AgentInvocationResult {
  text: string
  requestId?: string
}

export interface HandlerDependencies {
  fetchImpl?: typeof fetch
  invokeAgent?: (request: AgentReviewRequest) => Promise<AgentInvocationResult>
  now?: () => Date
}

class RequestValidationError extends Error {}

export function createLambdaHandler(dependencies: HandlerDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const now = dependencies.now ?? (() => new Date())

  return async (event: HttpApiEvent): Promise<HttpApiResponse> => {
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase()
    const path = normalizePath(event)

    if (method === 'GET' && path === '/api/health') {
      return json(200, {
        status: 'ok',
        service: 'ctrlcity-operations-api',
        agentReviewEnabled: Boolean(environmentValue('AGENTCORE_HARNESS_ARN')),
        generatedAt: now().toISOString(),
      })
    }

    if (method === 'GET' && path === '/api/v1/live-stations') {
      return proxyLiveStations(fetchImpl)
    }

    if (method === 'POST' && path === '/api/v1/agent-review') {
      const harnessArn = environmentValue('AGENTCORE_HARNESS_ARN')?.trim()
      if (!harnessArn) {
        return json(503, {
          error: {
            code: 'AGENTCORE_DISABLED',
            message: 'AgentCore review is not enabled for this deployment.',
          },
        })
      }

      try {
        const request = parseAgentReviewRequest(event)
        const invocation = dependencies.invokeAgent
          ? await dependencies.invokeAgent(request)
          : await invokeHarness(request, harnessArn)
        const data = parseAgentReviewOutput(invocation.text)

        return json(200, {
          data,
          meta: {
            provider: 'agentcore' as const,
            generatedAt: now().toISOString(),
            ...(invocation.requestId ? { requestId: invocation.requestId } : {}),
          },
        })
      } catch (error) {
        if (error instanceof RequestValidationError) {
          return json(400, {
            error: { code: 'INVALID_AGENT_REVIEW_REQUEST', message: error.message },
          })
        }

        console.error('AgentCore review failed', safeError(error))
        return json(502, {
          error: {
            code: 'AGENTCORE_REVIEW_FAILED',
            message: 'AgentCore could not complete the review. Use the deterministic summary instead.',
          },
        })
      }
    }

    return json(404, {
      error: { code: 'ROUTE_NOT_FOUND', message: 'Unknown API route.' },
    })
  }
}

export const lambdaHandler = createLambdaHandler()

async function proxyLiveStations(fetchImpl: typeof fetch): Promise<HttpApiResponse> {
  const liveFeedUrl = environmentValue('LIVE_FEED_URL')?.trim() || DEFAULT_LIVE_FEED_URL

  try {
    const upstream = await fetchImpl(liveFeedUrl, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'CtrlCity-YouBike-Demo/1.0',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    })

    if (!upstream.ok) {
      return json(502, {
        error: {
          code: 'LIVE_FEED_UNAVAILABLE',
          message: `The official live feed returned HTTP ${upstream.status}.`,
        },
      })
    }

    const declaredLength = Number(upstream.headers.get('content-length') || 0)
    if (declaredLength > MAX_UPSTREAM_BYTES) {
      return json(502, {
        error: { code: 'LIVE_FEED_TOO_LARGE', message: 'The official live feed exceeded the safe response limit.' },
      })
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer())
    if (bytes.byteLength > MAX_UPSTREAM_BYTES) {
      return json(502, {
        error: { code: 'LIVE_FEED_TOO_LARGE', message: 'The official live feed exceeded the safe response limit.' },
      })
    }

    return {
      statusCode: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        'x-content-type-options': 'nosniff',
      },
      body: new TextDecoder().decode(bytes),
    }
  } catch (error) {
    console.error('Live feed proxy failed', safeError(error))
    return json(502, {
      error: { code: 'LIVE_FEED_UNAVAILABLE', message: 'Unable to retrieve the official live station feed.' },
    })
  }
}

export function parseAgentReviewRequest(event: HttpApiEvent): AgentReviewRequest {
  const encodedBody = event.body ?? ''
  if (event.isBase64Encoded && encodedBody.length > Math.ceil(MAX_REQUEST_BYTES * 4 / 3) + 4) {
    throw new RequestValidationError('Request body is empty or exceeds 16 KB.')
  }
  const rawBody = event.isBase64Encoded
    ? Buffer.from(encodedBody, 'base64').toString('utf8')
    : encodedBody

  if (!rawBody || Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
    throw new RequestValidationError('Request body is empty or exceeds 16 KB.')
  }

  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    throw new RequestValidationError('Request body must be valid JSON.')
  }

  const root = strictObject(value, ['asOf', 'district', 'horizonMinutes', 'summary', 'facts'], 'request')
  const asOf = boundedString(root.asOf, 'asOf', 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)
    || Number.isNaN(Date.parse(asOf))) {
    throw new RequestValidationError('asOf must be a valid ISO date-time string.')
  }

  const district = boundedString(root.district, 'district', 24)
  if (root.horizonMinutes !== 60) {
    throw new RequestValidationError('horizonMinutes must be 60.')
  }

  const summaryValue = strictObject(
    root.summary,
    ['recommendedMoves', 'persistentAlerts', 'emptyNow', 'fullNow'],
    'summary',
  )
  const summary = {
    recommendedMoves: boundedInteger(summaryValue.recommendedMoves, 'summary.recommendedMoves'),
    persistentAlerts: boundedInteger(summaryValue.persistentAlerts, 'summary.persistentAlerts'),
    emptyNow: boundedInteger(summaryValue.emptyNow, 'summary.emptyNow'),
    fullNow: boundedInteger(summaryValue.fullNow, 'summary.fullNow'),
  }

  if (!Array.isArray(root.facts) || root.facts.length > MAX_FACTS) {
    throw new RequestValidationError(`facts must be an array with at most ${MAX_FACTS} items.`)
  }

  const facts = root.facts.map((fact, index) => {
    const item = strictObject(
      fact,
      ['label', 'value', 'stationId', 'alertId', 'dispatchId'],
      `facts[${index}]`,
    )
    const parsed: AgentReviewFact = {
      label: boundedString(item.label, `facts[${index}].label`, 48),
      value: boundedFactValue(item.value, `facts[${index}].value`),
    }

    for (const key of ['stationId', 'alertId', 'dispatchId'] as const) {
      if (item[key] !== undefined) {
        parsed[key] = boundedIdentifier(item[key], `facts[${index}].${key}`)
      }
    }

    return parsed
  })

  return { asOf, district, horizonMinutes: 60, summary, facts }
}

async function invokeHarness(
  request: AgentReviewRequest,
  harnessArn: string,
): Promise<AgentInvocationResult> {
  const region = harnessRegion(harnessArn)
  const qualifier = environmentValue('AGENTCORE_HARNESS_QUALIFIER')?.trim()
  const client = new BedrockAgentCoreClient({ region })
  const response = await client.send(new InvokeHarnessCommand({
    harnessArn,
    ...(qualifier && qualifier !== 'DEFAULT' ? { qualifier } : {}),
    runtimeSessionId: crypto.randomUUID(),
    messages: [{ role: 'user', content: [{ text: createAgentPrompt(request) }] }],
    maxIterations: 2,
    maxTokens: 300,
    timeoutSeconds: 20,
  }))

  if (!response.stream) {
    throw new Error('AgentCore returned no response stream.')
  }

  let text = ''
  for await (const event of response.stream) {
    const streamError = streamEventError(event)
    if (streamError) throw new Error(streamError)

    const delta = event.contentBlockDelta?.delta?.text
    if (delta) {
      text += delta
      if (text.length > MAX_AGENT_OUTPUT_CHARS) {
        throw new Error('AgentCore response exceeded the safe output limit.')
      }
    }
  }

  if (!text.trim()) {
    throw new Error('AgentCore returned an empty response.')
  }

  return { text, requestId: response.$metadata.requestId }
}

export function createAgentPrompt(request: AgentReviewRequest): string {
  return [
    '請只依據下列 JSON 事實，輸出一個 JSON 物件，不要使用 Markdown 或程式碼區塊。',
    '欄位必須是 headline、narrative、cautions、citations。',
    'headline 與 narrative 使用繁體中文；cautions 是最多 4 個短句；citations 是最多 8 筆 {label, source?}。',
    '不得新增站點、數值、時間、成因或宣稱已派車；所有調度都要標示需人工覆核。',
    JSON.stringify(request),
  ].join('\n')
}

export function parseAgentReviewOutput(raw: string): AgentReviewPayload {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown

  try {
    value = JSON.parse(normalized)
  } catch {
    return {
      headline: 'AI 調度覆核',
      narrative: boundedOutputText(normalized, 1_200) || 'AgentCore 未回傳可顯示內容。',
      cautions: ['回應格式未完整解析，請由調度人員人工覆核。'],
      citations: [],
    }
  }

  if (!isRecord(value)) {
    throw new Error('AgentCore response must be a JSON object.')
  }

  const headline = boundedOutputText(value.headline, 100)
  const narrative = boundedOutputText(value.narrative, 1_200)
  if (!headline || !narrative) {
    throw new Error('AgentCore response is missing headline or narrative.')
  }

  const cautions = Array.isArray(value.cautions)
    ? value.cautions.slice(0, 4).map(item => boundedOutputText(item, 160)).filter(Boolean)
    : []
  const citations = Array.isArray(value.citations)
    ? value.citations.slice(0, 8).flatMap((item) => {
        if (!isRecord(item)) return []
        const label = boundedOutputText(item.label, 100)
        if (!label) return []
        const source = boundedOutputText(item.source, 240)
        return [{ label, ...(source ? { source } : {}) }]
      })
    : []

  return {
    headline,
    narrative,
    cautions: cautions.length ? cautions : ['調度建議需由人員依現場狀況覆核。'],
    citations,
  }
}

function streamEventError(event: InvokeHarnessStreamOutput): string | undefined {
  if (event.internalServerException) return event.internalServerException.message
  if (event.validationException) return event.validationException.message
  if (event.runtimeClientError) return event.runtimeClientError.message
  return undefined
}

function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestValidationError(`${field} must be an object.`)
  const unknownKey = Object.keys(value).find(key => !allowedKeys.includes(key))
  if (unknownKey) throw new RequestValidationError(`${field}.${unknownKey} is not allowed.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new RequestValidationError(`${field} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new RequestValidationError(`${field} must contain 1 to ${maxLength} characters.`)
  }
  return normalized
}

function boundedInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10_000) {
    throw new RequestValidationError(`${field} must be an integer from 0 to 10000.`)
  }
  return Number(value)
}

function boundedFactValue(value: unknown, field: string): string | number {
  if (typeof value === 'string') return boundedString(value, field, 120)
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) {
    return value
  }
  throw new RequestValidationError(`${field} must be a short string or finite number.`)
}

function boundedIdentifier(value: unknown, field: string): string {
  const identifier = boundedString(value, field, 80)
  if (!/^[A-Za-z0-9._:-]+$/.test(identifier)) {
    throw new RequestValidationError(`${field} contains unsupported characters.`)
  }
  return identifier
}

function boundedOutputText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function harnessRegion(arn: string): string {
  const match = arn.match(/^arn:[^:]+:bedrock-agentcore:([a-z0-9-]+):\d{12}:harness\/[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]{10}$/)
  if (!match?.[1]) throw new Error('AGENTCORE_HARNESS_ARN is not a valid Harness ARN.')
  return match[1]
}

function normalizePath(event: HttpApiEvent): string {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '/'
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function safeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 500) }
    : { name: 'UnknownError', message: 'Unknown failure' }
}

function json(statusCode: number, value: unknown): HttpApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(value),
  }
}
