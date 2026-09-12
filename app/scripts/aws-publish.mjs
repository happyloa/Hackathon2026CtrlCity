import { frontendEnvironment, protectedPublishPaths } from './aws-publish-config.mjs'
import { syncOperatorSeed } from './aws-sync-operator-seed.mjs'
import { S3Client } from '@aws-sdk/client-s3'
import { resolve } from 'node:path'
import {
  awsArgs,
  commandAvailable,
  distPath,
  parseOptions,
  readStackOutputs,
  requireFile,
  resolveRegion,
  run,
  runNpmScript,
} from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is not installed or not on PATH.')
  options.region = resolveRegion(options)

  const outputs = readStackOutputs(options)
  const agentEnabled = outputs.AgentReviewEnabled === 'true'
  runNpmScript('build', frontendEnvironment(outputs))
  requireFile(resolve(distPath, 'index.html'), 'Built Nuxt site')

  const bucket = outputs.SiteBucketName
  const distributionId = outputs.DistributionId
  if (!/^[a-z0-9.-]{3,63}$/.test(bucket || '')) throw new Error('Stack SiteBucketName output is missing or invalid.')
  if (!/^[A-Z0-9]{8,32}$/.test(distributionId || '')) throw new Error('Stack DistributionId output is missing or invalid.')

  if (options.profile) process.env.AWS_PROFILE = options.profile
  if (outputs.DispatcherLoginEnabled === 'true') {
    await syncOperatorSeed(bucket, { initialize: true, s3: new S3Client({ region: options.region }) })
  }

  // Upload hashed assets first and retain previous versions for open tabs.
  const nuxtAssets = resolve(distPath, '_nuxt')
  requireFile(nuxtAssets, 'Nuxt asset directory')
  run('aws', awsArgs(options, [
    's3', 'sync', nuxtAssets, `s3://${bucket}/_nuxt`,
    '--cache-control', 'public,max-age=31536000,immutable',
  ]))

  run('aws', awsArgs(options, [
    's3',
    'sync',
    distPath,
    `s3://${bucket}`,
    '--delete',
    ...protectedPublishPaths.flatMap(path => ['--exclude', path]),
    '--cache-control',
    'public,max-age=300,must-revalidate',
  ]))

  run('aws', awsArgs(options, [
    'cloudfront',
    'create-invalidation',
    '--distribution-id',
    distributionId,
    '--paths',
    '/*',
  ]))

  console.log(`Published to ${outputs.SiteUrl} with AgentCore UI ${agentEnabled ? 'enabled' : 'disabled'}.`)
  console.log('CloudFront propagation can take several minutes.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
