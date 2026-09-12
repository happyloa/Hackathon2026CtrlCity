import { resolve } from 'node:path'
import {
  appDir,
  commandAvailable,
  parseOptions,
  readStackOutputs,
  requireFile,
  resolveRegion,
  run,
  templatePath,
} from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is not installed or not on PATH.')
  if (!commandAvailable('sam')) throw new Error('AWS SAM CLI is not installed or not on PATH.')
  if (options['create-harness'] && !options['model-id']) {
    throw new Error('--model-id is required with --create-harness.')
  }
  if (options['create-harness'] && options['harness-arn']) {
    throw new Error('Use either --create-harness or --harness-arn, not both.')
  }

  options.region = resolveRegion(options)
  const sharedSamArgs = [
    '--template-file',
    templatePath,
    '--region',
    options.region,
    ...(options.profile ? ['--profile', options.profile] : []),
  ]

  run('sam', ['validate', '--lint', ...sharedSamArgs])
  // SAM installs production dependencies for Lambda, not the Nuxt frontend.
  run('sam', ['build', ...sharedSamArgs], { env: { npm_config_ignore_scripts: 'true' } })
  const builtTemplate = resolve(appDir, '.aws-sam', 'build', 'template.yaml')
  requireFile(builtTemplate, 'SAM built template')

  const parameters = [
    `EnableSnapshotCapture=${options['enable-capture'] ? 'true' : 'false'}`,
    `CreateBuildRunner=${options['build-runner'] ? 'true' : 'false'}`,
    `EnableDispatcherLogin=${options['dispatcher-login'] ? 'true' : 'false'}`,
    `AlertEmail=${options['alert-email'] || ''}`, 
    `EnvironmentName=${options.environment}`,
    `CreateAgentCoreHarness=${options['create-harness'] ? 'true' : 'false'}`,
    `CreateKnowledgeSourceBucket=${options['knowledge-source'] ? 'true' : 'false'}`,
    `AgentCoreHarnessQualifier=${options['harness-qualifier']}`,
  ]
  if (options['dispatcher-login']) {
    const siteUrl = options['site-url'] || readStackOutputs(options).SiteUrl
    if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(siteUrl || '')) throw new Error('Deploy the base stack first, or pass --site-url for Cognito callbacks.')
    parameters.push(`DispatcherSiteUrl=${siteUrl}`)
  }
  if (options['harness-arn']) parameters.push(`AgentCoreHarnessArn=${options['harness-arn']}`)
  if (options['model-id']) parameters.push(`AgentCoreModelId=${options['model-id']}`)

  run('sam', [
    'deploy',
    '--template-file',
    builtTemplate,
    '--stack-name',
    options.stack,
    '--region',
    options.region,
    ...(options.profile ? ['--profile', options.profile] : []),
    '--resolve-s3',
    '--capabilities',
    'CAPABILITY_IAM',
    '--parameter-overrides',
    ...parameters,
    '--tags',
    'project=ctrlcity-youbike',
    `environment=${options.environment}`,
    '--no-fail-on-empty-changeset',
    ...(options.yes ? ['--no-confirm-changeset'] : ['--confirm-changeset']),
  ])

  const outputs = readStackOutputs(options)
  console.log(`Infrastructure ready: ${outputs.SiteUrl || '(SiteUrl output pending)'}`)
  console.log('Run npm run aws:publish with the same stack/region options; it builds with the stack feature flags before upload.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
