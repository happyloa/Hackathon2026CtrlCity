import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const templatePath = resolve(appDir, 'infra', 'template.yaml')
export const distPath = resolve(appDir, 'dist')

const optionNames = new Set([
  'stack',
  'region',
  'profile',
  'environment',
  'harness-arn',
  'harness-qualifier',
  'model-id',
  'url',
])
const booleanNames = new Set([
  'create-harness',
  'knowledge-source',
  'yes',
  'include-agent',
  'confirm-agent-cost',
])

export function parseOptions(argv = process.argv.slice(2)) {
  const options = {
    stack: 'ctrlcity-hackathon',
    environment: 'hackathon',
    'harness-qualifier': 'DEFAULT',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) throw new Error(`Unknown positional argument: ${token}`)
    const name = token.slice(2)

    if (booleanNames.has(name)) {
      options[name] = true
      continue
    }

    if (!optionNames.has(name)) throw new Error(`Unknown option: --${name}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value.`)
    options[name] = value
    index += 1
  }

  assertStackName(options.stack)
  assertEnvironmentName(options.environment)
  return options
}

export function commandAvailable(command) {
  return spawnSync(command, ['--version'], {
    cwd: appDir,
    encoding: 'utf8',
    env: commandEnvironment(),
    shell: false,
  }).status === 0
}

export function run(command, args, { capture = false, allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    encoding: 'utf8',
    env: { ...commandEnvironment(), ...env },
    shell: false,
    stdio: capture ? 'pipe' : 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    throw new Error(`${command} exited with ${result.status}.${details ? `\n${details}` : ''}`)
  }
  return result
}

export function runNpmScript(script, env = {}) {
  const npmCli = process.env.npm_execpath
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error(`Run this command through npm so the ${script} script can be resolved.`)
  }
  return run(process.execPath, [npmCli, 'run', script], { env })
}

export function awsArgs(options, args, regionOverride) {
  const result = [...args]
  const region = regionOverride || options.region
  if (region) result.push('--region', region)
  if (options.profile) result.push('--profile', options.profile)
  return result
}

export function resolveRegion(options) {
  if (options.region) return options.region
  if (process.env.AWS_REGION) return process.env.AWS_REGION
  if (process.env.AWS_DEFAULT_REGION) return process.env.AWS_DEFAULT_REGION

  const result = run('aws', awsArgs(options, ['configure', 'get', 'region']), {
    capture: true,
    allowFailure: true,
  })
  const region = result.stdout?.trim()
  if (!region) throw new Error('AWS region is required. Pass --region <region>.')
  options.region = region
  return region
}

export function readStackOutputs(options) {
  const result = run(
    'aws',
    awsArgs(options, [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      options.stack,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json',
    ]),
    { capture: true },
  )
  const list = JSON.parse(result.stdout || '[]')
  return Object.fromEntries(list.map(item => [item.OutputKey, item.OutputValue]))
}

export function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`)
}

export function harnessId(arn) {
  const match = arn.match(/^arn:[^:]+:bedrock-agentcore:([a-z0-9-]+):\d{12}:harness\/([A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]{10})$/)
  if (!match) throw new Error('--harness-arn is not a valid AgentCore Harness ARN.')
  return { region: match[1], id: match[2] }
}

function commandEnvironment() {
  return { ...process.env, AWS_PAGER: '', SAM_CLI_TELEMETRY: '0' }
}

function assertStackName(value) {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(value)) {
    throw new Error('--stack must be a valid CloudFormation stack name.')
  }
}

function assertEnvironmentName(value) {
  if (!/^[a-z0-9-]{2,24}$/.test(value)) {
    throw new Error('--environment must contain 2-24 lowercase letters, numbers, or hyphens.')
  }
}
