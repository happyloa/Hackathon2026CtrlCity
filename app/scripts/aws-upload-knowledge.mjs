import { resolve } from 'node:path'
import {
  appDir,
  awsArgs,
  commandAvailable,
  parseOptions,
  readStackOutputs,
  requireFile,
  resolveRegion,
  run,
} from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is not installed or not on PATH.')
  options.region = resolveRegion(options)

  const source = resolve(appDir, 'aws', 'knowledge')
  requireFile(source, 'Curated knowledge directory')
  const outputs = readStackOutputs(options)
  const bucket = outputs.KnowledgeSourceBucketName
  if (!/^[a-z0-9.-]{3,63}$/.test(bucket || '')) {
    throw new Error('KnowledgeSourceBucketName is unavailable. Deploy with --knowledge-source first.')
  }

  run('aws', awsArgs(options, [
    's3',
    'sync',
    source,
    `s3://${bucket}/knowledge`,
    '--delete',
    '--exclude',
    '*',
    '--include',
    '*.md',
    '--cache-control',
    'no-cache',
  ]))

  console.log(`Curated Markdown uploaded to s3://${bucket}/knowledge/.`)
  console.log('No vector store, Knowledge Base, Gateway, or ingestion job was created or started.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
