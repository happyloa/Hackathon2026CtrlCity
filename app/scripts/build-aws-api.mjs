import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { appDir } from './aws-cli-utils.mjs'

const outfile = resolve(appDir, '.aws-sam/api/handler.cjs')
await build({
  entryPoints: [resolve(appDir, 'aws/handler.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
})

// Import the actual deployment bundle: source-level tests cannot catch
// CommonJS dependencies failing during Lambda's module initialization.
const { lambdaHandler } = createRequire(import.meta.url)(outfile)
const response = await lambdaHandler({
  rawPath: '/api/health',
  requestContext: { http: { method: 'GET' } },
})
assert.equal(response.statusCode, 200)
assert.equal(JSON.parse(response.body).status, 'ok')
console.log('Lambda bundle built and health check passed.')
