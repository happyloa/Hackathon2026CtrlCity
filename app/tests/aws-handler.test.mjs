import assert from 'node:assert/strict'
import test from 'node:test'
const {
  createLambdaHandler,
  parseAgentReviewOutput,
  parseAgentReviewRequest,
} = await import('../aws/handler.ts')

const validRequest = {
  asOf: '2026-08-23T12:00:00.000Z',
  district: '板橋區',
  horizonMinutes: 60,
  summary: {
    recommendedMoves: 2,
    inventoryAlerts: 3,
    emptyNow: 1,
    fullNow: 1,
  },
  facts: [
    { label: '站點可借車', value: 0, stationId: '500101001' },
  ],
}

function event(method, path, body) {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, path }, requestId: 'request-1' },
  }
}

test('accepts the bounded 60-minute review request contract', () => {
  assert.deepEqual(
    parseAgentReviewRequest(event('POST', '/api/v1/agent-review', validRequest)),
    validRequest,
  )
})

test('rejects unknown fields and non-60-minute horizons', () => {
  assert.throws(
    () => parseAgentReviewRequest(event('POST', '/api/v1/agent-review', {
      ...validRequest,
      unexpected: true,
    })),
    /unexpected is not allowed/,
  )
  assert.throws(
    () => parseAgentReviewRequest(event('POST', '/api/v1/agent-review', {
      ...validRequest,
      horizonMinutes: 120,
    })),
    /horizonMinutes must be 60/,
  )
})

test('normalizes a structured AgentCore response to the public contract', () => {
  assert.deepEqual(parseAgentReviewOutput(JSON.stringify({
    headline: '風險分析說明',
    narrative: '根據畫面事實，先說明即時庫存風險。',
    cautions: ['未表示已完成派車'],
    citations: [{ label: '站點可借車', source: '500101001' }],
  })), {
    headline: '風險分析說明',
    narrative: '根據畫面事實，先說明即時庫存風險。',
    cautions: ['未表示已完成派車'],
    citations: [{ label: '站點可借車', source: '500101001' }],
  })
})

test('keeps AgentCore disabled when no Harness ARN is configured', async () => {
  const previous = process.env.AGENTCORE_HARNESS_ARN
  delete process.env.AGENTCORE_HARNESS_ARN
  try {
    const response = await createLambdaHandler()(event('POST', '/api/v1/agent-review', {}))
    assert.equal(response.statusCode, 503)
    assert.equal(JSON.parse(response.body).error.code, 'AGENTCORE_DISABLED')
  } finally {
    if (previous === undefined) delete process.env.AGENTCORE_HARNESS_ARN
    else process.env.AGENTCORE_HARNESS_ARN = previous
  }
})

test('returns the exact success envelope through an injected AgentCore boundary', async () => {
  const previous = process.env.AGENTCORE_HARNESS_ARN
  process.env.AGENTCORE_HARNESS_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/CtrlCityReview-1234567890'
  try {
    const handler = createLambdaHandler({
      now: () => new Date('2026-08-23T12:01:00.000Z'),
      invokeAgent: async () => ({
        requestId: 'agent-request-1',
        text: JSON.stringify({
          headline: '風險分析說明',
          narrative: '先說明高優先風險。',
          cautions: ['不會自動派車'],
          citations: [],
        }),
      }),
    })
    const response = await handler(event('POST', '/api/v1/agent-review', validRequest))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body), {
      data: {
        headline: '風險分析說明',
        narrative: '先說明高優先風險。',
        cautions: ['不會自動派車'],
        citations: [],
      },
      meta: {
        provider: 'agentcore',
        generatedAt: '2026-08-23T12:01:00.000Z',
        requestId: 'agent-request-1',
      },
    })
  } finally {
    if (previous === undefined) delete process.env.AGENTCORE_HARNESS_ARN
    else process.env.AGENTCORE_HARNESS_ARN = previous
  }
})
