import type { DashboardArtifact } from '../shared/ops'
import type { OperationsDependencies } from './contracts'
import { environmentValue } from './runtime-env'

/** Minimal API Gateway HTTP API v2 shape, kept local-safe without aws-lambda types. */
export interface HttpApiEvent {
  rawPath?: string
  rawQueryString?: string
  requestContext?: { http?: { method?: string; path?: string } }
}

export interface HttpApiResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

/**
 * Production assembly injects a S3+DynamoDB DashboardStore and an optional
 * BedrockNarrativeProvider here. The route code is cloud-agnostic and can be
 * exercised locally with file-system or in-memory implementations.
 */
export function createOperationsHandler(dependencies: OperationsDependencies) {
  return async (event: HttpApiEvent): Promise<HttpApiResponse> => {
    const method = event.requestContext?.http?.method ?? 'GET'
    const path = eventPath(event)
    const asOf = new URLSearchParams(event.rawQueryString ?? '').get('at') ?? undefined
    const artifact = await dependencies.dashboardStore.getDashboard(asOf)

    if (!artifact) {
      return json(404, {
        error: { code: 'DASHBOARD_NOT_FOUND', message: 'No dashboard artifact exists for this time.' },
      })
    }

    const meta = createMeta(artifact, dependencies.narrativeProviderName)

    if (method === 'GET' && path === '/v1/overview') {
      return json(200, { data: artifact.summary, meta })
    }

    if (method === 'GET' && path === '/v1/stations') {
      return json(200, { data: artifact.stations, meta })
    }

    if (method === 'GET' && path === '/v1/alerts') {
      return json(200, { data: artifact.alerts, meta })
    }

    if (method === 'GET' && path === '/v1/dispatch-plan') {
      return json(200, { data: artifact.dispatches, meta })
    }

    const historyMatch = path.match(/^\/v1\/stations\/([^/]+)\/history$/)
    if (method === 'GET' && historyMatch) {
      const stationId = decodeURIComponent(historyMatch[1] ?? '')
      return json(200, { data: artifact.stationHistories[stationId] ?? [], meta })
    }

    if (method === 'POST' && path === '/v1/briefings') {
      if (!dependencies.narrativeProvider) {
        return json(501, {
          error: {
            code: 'NARRATIVE_PROVIDER_DISABLED',
            message: 'Configure GENAI_BACKEND=bedrock and BEDROCK_MODEL_ID to enable this endpoint.',
          },
        })
      }

      const briefing = await dependencies.narrativeProvider.generate({
        asOf: artifact.meta.asOf,
        facts: artifact.briefingFacts,
      })
      return json(200, { data: briefing, meta })
    }

    return json(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Unknown API route.' } })
  }
}

/**
 * SAM entry point. It intentionally exposes only a health check until the
 * application composition wires the SDK-specific S3 and DynamoDB adapters.
 * This avoids a deployed endpoint pretending that a CSV replay is live data.
 */
export async function lambdaHandler(event: HttpApiEvent): Promise<HttpApiResponse> {
  const path = eventPath(event)
  const method = event.requestContext?.http?.method ?? 'GET'

  if (method === 'GET' && path === '/health') {
    return json(200, {
      status: 'ok',
      appMode: environmentValue('APP_MODE') ?? 'unknown',
      adapters: {
        objectStoreConfigured: Boolean(environmentValue('ARTIFACT_BUCKET')),
        dashboardTableConfigured: Boolean(environmentValue('DDB_DASHBOARD_TABLE')),
        narrativeProvider: environmentValue('GENAI_BACKEND') ?? 'template',
      },
    })
  }

  return json(503, {
    error: {
      code: 'AWS_ADAPTER_WIRING_REQUIRED',
      message: 'Wire S3DynamoDashboardStore into createOperationsHandler before enabling the public dashboard API.',
    },
  })
}

function eventPath(event: HttpApiEvent): string {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '/'
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function createMeta(artifact: DashboardArtifact, narrativeProvider: 'template' | 'bedrock') {
  return {
    asOf: artifact.meta.asOf,
    generatedAt: artifact.meta.generatedAt,
    dataMode: artifact.meta.dataMode,
    forecastModel: artifact.meta.modelVersion,
    narrativeProvider,
  }
}

function json(statusCode: number, value: unknown): HttpApiResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(value),
  }
}
