import { resolve } from 'node:path'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { appDir, awsArgs, commandAvailable, parseOptions, readStackOutputs, resolveRegion, run } from './aws-cli-utils.mjs'

try {
  const options = parseOptions()
  if (!commandAvailable('aws')) throw new Error('AWS CLI v2 is not installed or not on PATH.')
  options.region = resolveRegion(options)
  const outputs = readStackOutputs(options)
  const bucket = outputs.RawDataBucketName
  const project = outputs.HistoryBuildProjectName
  if (!bucket || !project) throw new Error('Stack was deployed without --build-runner.')

  // 打包「目前 commit」的工作樹；未 commit 的變更不會進去，跟 CI 一樣誠實。
  const sourceDir = mkdtempSync(resolve(tmpdir(), 'ctrlcity-source-'))
  const zip = resolve(sourceDir, 'repo.zip')
  const sourceKey = `source/${Date.now()}-${process.pid}.zip`
  run('git', ['-C', resolve(appDir, '..'), 'archive', '--format=zip', '-o', zip, 'HEAD'])
  run('aws', awsArgs(options, ['s3', 'cp', zip, `s3://${bucket}/${sourceKey}`]))

  rmSync(zip)
  rmdirSync(sourceDir)
  const started = run('aws', awsArgs(options, ['codebuild', 'start-build', '--project-name', project, '--source-location-override', `${bucket}/${sourceKey}`,  '--query', 'build.id', '--output', 'text']), { capture: true })
  console.log(`Started ${started.stdout.trim()}. Follow with: aws codebuild batch-get-builds --ids ${started.stdout.trim()} --region ${options.region}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
