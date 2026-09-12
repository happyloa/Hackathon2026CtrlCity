import { readFile, writeFile } from 'node:fs/promises'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { parseDemandEventsFile } from '../shared/demand-events.mjs'
import { parseAdjustmentsFile } from '../shared/operational-adjustments.mjs'
import { resolve } from 'node:path'
import { appDir } from './aws-cli-utils.mjs'

// Only NoSuchKey permits falling back to the committed seed; auth/network failures stop the build.
export async function syncOperatorSeed(bucket, { initialize = false, s3 = new S3Client({}) } = {}) {
  for (const [key, field, parse] of [
    ['data/operational-adjustments.json', 'adjustments', parseAdjustmentsFile],
    ['data/demand-events.json', 'events', parseDemandEventsFile],
  ]) {
    let body
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      body = await result.Body.transformToString()
    } catch (error) {
      if (error.name !== 'NoSuchKey') throw error
      try { body = await readFile(resolve(appDir, key), 'utf8') }
      catch (localError) { if (localError.code !== 'ENOENT') throw localError; body = JSON.stringify({ schemaVersion: '1.0', [field]: [] }) }
      if (initialize) {
        try {
          await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json', CacheControl: 'no-store', IfNoneMatch: '*' }))
        } catch (writeError) {
          if (!['PreconditionFailed', 'ConditionalRequestConflict'].includes(writeError.name)) throw writeError
          body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body.transformToString()
        }
      }
    }
    const data = JSON.parse(body)
    if (!Array.isArray(data[field]) || parse(data).length !== data[field].length) throw new Error(`Invalid operator file: ${key}`)
    if (!initialize) await writeFile(resolve(appDir, key), body)
  }
}
