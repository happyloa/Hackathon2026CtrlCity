import { access, cp, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportReplayStatic } from './export-replay-static.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedPublicDir = resolve(APP_DIR, '.output', 'public')
const pagesOutputDir = resolve(APP_DIR, 'dist')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

// Nuxt's generic static preset writes to .output/public. Cloudflare Pages
// selects cloudflare-pages-static during its Git build and writes directly to
// dist, so only copy when the generic output is present.
const outputIsAlreadyPagesDist = process.env.NITRO_PRESET === 'cloudflare-pages-static'

if (!outputIsAlreadyPagesDist && await exists(generatedPublicDir)) {
  await rm(pagesOutputDir, { recursive: true, force: true })
  await cp(generatedPublicDir, pagesOutputDir, { recursive: true })
} else if (!(await exists(pagesOutputDir))) {
  throw new Error('Expected either .output/public or dist from the Nuxt static build.')
}

// Nuxt's default fallback is `/* /404.html 404`. Replace it with an SPA
// fallback after removing 404.html so direct station URLs preserve their URL
// and load the client-side route without invoking a Function.
await rm(resolve(pagesOutputDir, '404.html'), { force: true })
await writeFile(resolve(pagesOutputDir, '_redirects'), '/* /index.html 200\n', 'utf8')

const result = await exportReplayStatic(pagesOutputDir)

try {
  await access(resolve(pagesOutputDir, '_worker.js'))
  throw new Error('Static Pages output must not contain _worker.js.')
} catch (error) {
  if (error && error.code !== 'ENOENT') throw error
}

console.log('Staged static Pages output with ' + result.scenarios + ' replay scenarios and ' + result.liveProfiles.stations + ' live profile stations.')
