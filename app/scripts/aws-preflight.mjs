import {
  awsArgs,
  commandAvailable,
  harnessId,
  parseOptions,
  resolveRegion,
  run,
  templatePath,
} from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) throw new Error('Node.js 20 or newer is required.')
  if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is not installed or not on PATH.')
  if (!commandAvailable('sam')) throw new Error('AWS SAM CLI is not installed or not on PATH.')

  const region = resolveRegion(options)
  options.region = region
  const identityResult = run(
    'aws',
    awsArgs(options, ['sts', 'get-caller-identity', '--output', 'json']),
    { capture: true },
  )
  const identity = JSON.parse(identityResult.stdout)

  run('sam', [
    'validate',
    '--lint',
    '--template-file',
    templatePath,
    '--region',
    region,
    ...(options.profile ? ['--profile', options.profile] : []),
  ])

  if (options['harness-arn']) {
    const harness = harnessId(options['harness-arn'])
    const result = run(
      'aws',
      awsArgs(options, [
        'bedrock-agentcore-control',
        'get-harness',
        '--harness-id',
        harness.id,
        '--output',
        'json',
      ], harness.region),
      { capture: true },
    )
    const details = JSON.parse(result.stdout)
    const status = details.harness?.status
    if (status !== 'READY') {
      throw new Error(`Existing Harness is not READY (status: ${status || 'unknown'}).`)
    }

    if (options['harness-qualifier'] !== 'DEFAULT') {
      const endpointResult = run(
        'aws',
        awsArgs(options, [
          'bedrock-agentcore-control',
          'get-harness-endpoint',
          '--harness-id',
          harness.id,
          '--endpoint-name',
          options['harness-qualifier'],
          '--output',
          'json',
        ], harness.region),
        { capture: true },
      )
      const endpointStatus = JSON.parse(endpointResult.stdout).endpoint?.status
      if (endpointStatus !== 'READY') {
        throw new Error(`Harness endpoint is not READY (status: ${endpointStatus || 'unknown'}).`)
      }
    }
  }

  if (options['create-harness'] && !options['model-id']) {
    throw new Error('--model-id is required with --create-harness.')
  }

  console.log(`AWS preflight passed: account ${identity.Account}, region ${region}.`)
  console.log(options['harness-arn'] || options['create-harness']
    ? 'AgentCore configuration is opt-in and ready for deployment validation.'
    : 'AgentCore remains disabled; deployment will not create or invoke a model.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
