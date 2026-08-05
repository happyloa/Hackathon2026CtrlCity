import { access, cp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportReplayStatic } from './export-replay-static.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedPublicDir = resolve(APP_DIR, '.output', 'public')
const pagesOutputDir = resolve(APP_DIR, 'dist')

await access(generatedPublicDir)
await rm(pagesOutputDir, { recursive: true, force: true })
await cp(generatedPublicDir, pagesOutputDir, { recursive: true })
const result = await exportReplayStatic(pagesOutputDir)

try {
  await access(resolve(pagesOutputDir, '_worker.js'))
  throw new Error('Static Pages output must not contain _worker.js.')
} catch (error) {
  if (error && error.code !== 'ENOENT') throw error
}

console.log('Staged static Pages output with ' + result.scenarios + ' replay scenarios.')
