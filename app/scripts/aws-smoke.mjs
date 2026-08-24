import {
  commandAvailable,
  parseOptions,
  readStackOutputs,
  resolveRegion,
} from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  let baseUrl = options.url?.replace(/\/+$/, '')

  if (!baseUrl) {
    if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is required unless --url is provided.')
    options.region = resolveRegion(options)
    baseUrl = readStackOutputs(options).SiteUrl
  }
  if (!/^https:\/\//.test(baseUrl || '')) throw new Error('A valid HTTPS SiteUrl is required.')

  await expectResponse(`${baseUrl}/`, 200, 'static site')
  const health = await expectJson(`${baseUrl}/api/health`, { expectedStatus: 200 })
  if (health.status !== 'ok') throw new Error('Health endpoint did not return status=ok.')

  const live = await expectResponse(`${baseUrl}/api/v1/live-stations`, 200, 'live station proxy')
  if (!String(live.headers.get('content-type')).includes('json')) {
    throw new Error('Live station proxy did not return JSON content.')
  }

  if (health.agentReviewEnabled) {
    if (!options['include-agent']) {
      console.log('AgentCore is enabled; paid invocation skipped. Add --include-agent --confirm-agent-cost to test it.')
    } else {
      if (!options['confirm-agent-cost']) {
        throw new Error('--include-agent also requires --confirm-agent-cost because it invokes paid AWS services.')
      }
      const result = await expectJson(`${baseUrl}/api/v1/agent-review`, {
        expectedStatus: 200,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          asOf: new Date().toISOString(),
          district: '新北市',
          horizonMinutes: 60,
          summary: { recommendedMoves: 0, inventoryAlerts: 0, emptyNow: 0, fullNow: 0 },
          facts: [],
        }),
      })
      validateAgentContract(result)
    }
  } else {
    const disabled = await expectJson(`${baseUrl}/api/v1/agent-review`, {
      expectedStatus: 503,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (disabled.error?.code !== 'AGENTCORE_DISABLED') {
      throw new Error('Disabled AgentCore endpoint returned an unexpected response.')
    }
  }

  console.log(`AWS smoke checks passed: ${baseUrl}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

async function expectResponse(url, expectedStatus, label, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expectedStatus}.`)
  }
  return response
}

async function expectJson(url, { expectedStatus, ...init }) {
  const response = await expectResponse(url, expectedStatus, url, init)
  return response.json()
}

function validateAgentContract(value) {
  if (value?.meta?.provider !== 'agentcore') throw new Error('Agent response provider is invalid.')
  if (typeof value?.data?.headline !== 'string' || typeof value?.data?.narrative !== 'string') {
    throw new Error('Agent response text contract is invalid.')
  }
  if (!Array.isArray(value.data.cautions) || !Array.isArray(value.data.citations)) {
    throw new Error('Agent response list contract is invalid.')
  }
}
