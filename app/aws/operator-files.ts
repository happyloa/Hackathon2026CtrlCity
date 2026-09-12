import { parseManualRoutesFile } from '../shared/manual-route-storage.ts'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { parseAdjustmentsFile, validateAdjustment } from '../shared/operational-adjustments.mjs'
import { parseDemandEventsFile } from '../shared/demand-events.mjs'
import { environmentValue } from './runtime-env.ts'
import type { HttpApiEvent, HttpApiResponse } from './handler.ts'

const files = {
  '/api/v1/manual-routes': { key: 'data/manual-routes.json', field: 'routes' },
  '/api/v1/adjustments': { key: 'data/operational-adjustments.json', field: 'adjustments' },
  '/api/v1/events': { key: 'data/demand-events.json', field: 'events' },
} as const
const json = (statusCode: number, value: unknown, headers = {}): HttpApiResponse => ({
  statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(value),
})
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message } })

export function createOperatorHandler(s3: Pick<S3Client, 'send'> = new S3Client({})) {
  return async (path: string, method: string, event: HttpApiEvent): Promise<HttpApiResponse | null> => {
    const file = files[path as keyof typeof files]
    if (!file || !['GET', 'PUT'].includes(method)) return null
    if (method === 'PUT') {
      if (environmentValue('OPERATOR_WRITE_ENABLED') !== 'true') return failure(503, 'OPERATOR_WRITE_DISABLED', 'Operator edits are not enabled.')
      // Trust only claims supplied by API Gateway's JWT authorizer, never client headers.
      const claims = event.requestContext?.authorizer?.jwt?.claims
      if (!claims?.sub || claims.token_use !== 'access') return failure(401, 'UNAUTHORIZED', 'Sign in with a dispatcher access token.')
    }
    const bucket = environmentValue('SITE_BUCKET')
    if (!bucket) return failure(503, 'OPERATOR_STORAGE_DISABLED', 'Operator storage is not configured.')
    try {
      if (method === 'GET') {
        try {
          const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.key }))
          const body = await object.Body?.transformToString()
          if (!body) throw new Error('Empty operator object')
          return json(200, JSON.parse(body), object.ETag ? { etag: object.ETag } : {})
        } catch (error) {
          if ((error as Error).name === 'NoSuchKey') return json(200, { schemaVersion: '1.0', [file.field]: [] })
          throw error
        }
      }
      const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? ''
      if (Buffer.byteLength(body) > 64 * 1024) return failure(413, 'OPERATOR_FILE_TOO_LARGE', 'Payload exceeds 64 KB.')
      let items: unknown[]
      try {
        const raw = JSON.parse(body)
        if (!raw || !Array.isArray(raw[file.field])) throw new Error('Missing list')
        if (file.field === 'routes') items = parseManualRoutesFile(raw)
        else if (file.field === 'events') items = parseDemandEventsFile(raw)
        else {
          const ids = new Set<string>()
          for (const item of raw.adjustments) {
            if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
              || typeof item.stationId !== 'string' || validateAdjustment(item).length
              || ['stationName', 'district', 'reason'].some(key => typeof item[key] !== 'string')) throw new Error('Invalid adjustment')
            ids.add(item.id)
          }
          items = parseAdjustmentsFile(raw)
          if (items.length !== raw.adjustments.length) throw new Error('Invalid adjustment')
        }
      } catch { return failure(400, 'INVALID_OPERATOR_FILE', 'Body must contain a valid complete operator file.') }
      const ifMatch = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'if-match')?.[1]
      if (ifMatch && !/^"[^"\r\n]+"$/.test(ifMatch)) return failure(400, 'INVALID_ETAG', 'Provide the ETag returned by GET.')
      const result = await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: file.key,
        Body: JSON.stringify({ schemaVersion: '1.0', exportedAt: new Date().toISOString(), [file.field]: items }),
        ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store',
        ...(ifMatch ? { IfMatch: ifMatch } : { IfNoneMatch: '*' }),
      }))
      return json(200, { saved: items.length, etag: result.ETag }, result.ETag ? { etag: result.ETag } : {})
    } catch (error) {
      if (['PreconditionFailed', 'ConditionalRequestConflict'].includes((error as Error).name)) return failure(412, 'OPERATOR_FILE_CHANGED', 'Someone else saved first. Reload before saving.')
      return failure(502, 'OPERATOR_STORAGE_FAILED', 'Unable to access operator storage. Please retry.')
    }
  }
}
