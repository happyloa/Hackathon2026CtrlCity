import assert from 'node:assert/strict'
import test from 'node:test'
import { createLambdaHandler } from '../aws/handler.ts'
import { OperatorDocumentClient } from '../shared/operator-client.ts'
import { frontendEnvironment, protectedPublishPaths } from '../scripts/aws-publish-config.mjs'
import { createBrowserStorage } from '../shared/browser-storage.ts'
const event = (method, body, extra = {}) => ({ rawPath: '/api/v1/adjustments', body: JSON.stringify(body), requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'dispatcher', token_use: 'access' } } } }, ...extra })
const missing = () => Object.assign(new Error(), { name: 'NoSuchKey' })
test('operator reads are public, missing files return the correct envelope', async () => {
  process.env.SITE_BUCKET = 'site'
  const handler = createLambdaHandler({ s3: { send: async () => { throw missing() } } })
  for (const field of ['adjustments', 'events']) {
    const result = await handler(event('GET', null, { rawPath: `/api/v1/${field}` }))
    assert.equal(result.statusCode, 200)
    assert.deepEqual(JSON.parse(result.body)[field], [])
  }
})
test('operator writes enforce flag, authorizer claims, size, schema, and conditional creation', async () => {
  process.env.SITE_BUCKET = 'site'
  const puts = []
  const handler = createLambdaHandler({ s3: { send: async cmd => { puts.push(cmd.input); return { ETag: '"v2"' } } } })
  process.env.OPERATOR_WRITE_ENABLED = 'false'
  assert.equal((await handler(event('PUT', { adjustments: [] }))).statusCode, 503)
  process.env.OPERATOR_WRITE_ENABLED = 'true'
  assert.equal((await handler(event('PUT', {}, { requestContext: { http: { method: 'PUT' } } }))).statusCode, 401)
  assert.equal((await handler(event('PUT', 'x'.repeat(65536)))).statusCode, 413)
  for (const value of [{}, { adjustments: [{}] }, { adjustments: 'bad' }]) assert.equal((await handler(event('PUT', value))).statusCode, 400)
  assert.equal((await handler(event('PUT', { adjustments: [] }, { headers: { 'if-match': '*' } }))).statusCode, 400)
  assert.equal((await handler(event('PUT', { adjustments: [] }))).statusCode, 200)
  assert.equal(puts.at(-1).IfNoneMatch, '*')
  await handler(event('PUT', { adjustments: [] }, { headers: { 'If-Match': '"v1"' } }))
  assert.equal(puts.at(-1).IfMatch, '"v1"')
  const result = await handler(event('PUT', { events: [] }, { rawPath: '/api/v1/events' }))
  assert.equal(result.statusCode, 200)
  assert.deepEqual(JSON.parse(puts.at(-1).Body).events, [])
  assert.equal(JSON.parse(puts.at(-1).Body).adjustments, undefined)
})
test('conflicting writes return 412 and storage failures return 502', async () => {
  process.env.SITE_BUCKET = 'site'; process.env.OPERATOR_WRITE_ENABLED = 'true'
  for (const [name, status] of [['PreconditionFailed', 412], ['ConditionalRequestConflict', 412], ['AccessDenied', 502]]) {
    const handler = createLambdaHandler({ s3: { send: async () => { throw Object.assign(new Error(), { name }) } } })
    assert.equal((await handler(event('PUT', { adjustments: [] }))).statusCode, status)
  }
})
test('client requires load, carries etag and blocks retries after conflicts until reload', async () => {
  const calls = []
  const client = new OperatorDocumentClient('/api/v1/adjustments', x => x.adjustments, async (url, init) => {
    calls.push(init)
    if (init.method === 'PUT') return new Response('{}', { status: 412 })
    return new Response('{"adjustments":[]}', { headers: { etag: '"one"' } })
  })
  await assert.rejects(client.save({}, 'token'), /先成功載入/)
  await client.load()
  await assert.rejects(client.save({}, ''), /登入/)
  await assert.rejects(client.save({}, 'token'), /有人先存/)
  assert.equal(calls.at(-1).headers['if-match'], '"one"')
  const n = calls.length
  await assert.rejects(client.save({}, 'token'), /有人先存/)
  assert.equal(calls.length, n)
  await client.load(); assert.equal(client.conflicted, false)
})
test('publish isolates local defaults and preserves scheduler/operator objects', () => {
  const defaults = frontendEnvironment({})
  assert.equal(defaults.NUXT_PUBLIC_PERSISTENCE_PATH, '')
  assert.equal(defaults.NUXT_PUBLIC_ADJUSTMENTS_ENDPOINT, '')
  assert.equal(defaults.NUXT_PUBLIC_STORAGE_MODE, 'aws')
  assert.equal(frontendEnvironment({ SnapshotCaptureEnabled: 'true' }).NUXT_PUBLIC_PERSISTENCE_PATH, '/state/persistence.json')
  for (const path of ['_nuxt/*', 'raw/*', 'snapshots/*', 'state/*', 'data/operational-adjustments.json', 'data/demand-events.json', 'data/manual-routes.json']) assert.ok(protectedPublishPaths.includes(path))
})

test('AWS storage never obtains localStorage; local builds persist and tolerate browser restrictions', () => {
  let accesses = 0
  const blocked = () => { accesses++; throw new Error('localStorage is forbidden') }
  const cloud = createBrowserStorage('aws', blocked)
  assert.equal(cloud.getItem('theme'), null)
  cloud.setItem('theme', 'light')
  assert.equal(accesses, 0)
  const saved = new Map()
  const local = createBrowserStorage('local', () => ({ getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) }))
  local.setItem('theme', 'light')
  assert.equal(local.getItem('theme'), 'light')
  assert.equal(createBrowserStorage('local', blocked).getItem('theme'), null)
})

test('manual routes pass through Lambda and S3 with version protection and strict validation', async () => {
  process.env.SITE_BUCKET = 'site'; process.env.OPERATOR_WRITE_ENABLED = 'true'
  const route = { id: 'route-one', label: '調度一', vehicleCapacity: 20, scheduledAt: '16:00', stops: [{ id: 'stop-one', stationId: '500201001', pickupBikes: 2, dropoffBikes: 0 }], createdAt: '2026-09-12T07:00:00Z', updatedAt: '2026-09-12T07:00:00Z' }
  let object
  const handler = createLambdaHandler({ s3: { send: async command => {
    if (command.constructor.name === 'GetObjectCommand') {
      if (!object) throw missing()
      return { ETag: '"v1"', Body: { transformToString: async () => object.Body } }
    }
    object = command.input
    return { ETag: '"v1"' }
  } } })
  const path = { rawPath: '/api/v1/manual-routes' }
  assert.deepEqual(JSON.parse((await handler(event('GET', null, path))).body).routes, [])
  assert.equal((await handler(event('PUT', { routes: [route] }, path))).statusCode, 200)
  assert.equal(object.Key, 'data/manual-routes.json')
  assert.equal(object.IfNoneMatch, '*')
  const response = await handler(event('GET', null, path))
  assert.equal(response.headers.etag, '"v1"')
  assert.deepEqual(JSON.parse(response.body).routes, [route])
  for (const invalid of [{ ...route, scheduledAt: '25:99' }, { ...route, vehicleCapacity: -1 }, { ...route, stops: [{ ...route.stops[0], pickupBikes: -1 }] }]) {
    assert.equal((await handler(event('PUT', { routes: [invalid] }, path))).statusCode, 400)
  }
})
