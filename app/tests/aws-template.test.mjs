import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deploymentTemplate } from '../scripts/aws-template.mjs'

const source = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8')
test('normal deployment excludes unsupported optional Harness and retains intrinsic expressions', () => {
  const template = deploymentTemplate(source)
  assert.equal(template.Resources.AgentReviewHarness, undefined)
  assert.equal(template.Outputs.ManagedHarnessArn, undefined)
  assert.equal(template.Conditions.CreateManagedHarness, undefined)
  assert.ok(!JSON.stringify(template).includes('AgentReviewHarness'))
  assert.deepEqual(template.Resources.SnapshotCaptureFunction.Properties.Environment.Variables.HISTORY_BUCKET, { Ref: 'HistoryDataBucket' })
  assert.deepEqual(template.Resources.HistoryBuildProject.Properties.ServiceRole, { 'Fn::GetAtt': ['BuildRunnerRole', 'Arn'] })
  assert.equal(template.Resources.HistoryDataBucket.DeletionPolicy, 'Retain')
  const paths = template.Resources.OperationsApi.Properties.DefinitionBody.paths
  for (const name of ['adjustments', 'events', 'manual-routes']) {
    assert.equal(paths[`/api/v1/${name}`].get['x-amazon-apigateway-integration'].payloadFormatVersion, '2.0')
    const put = paths[`/api/v1/${name}`].put['Fn::If']
    assert.equal(put[0], 'LoginEnabled')
    assert.deepEqual(put[1].security, [{ DispatcherJwt: ['openid'] }])
    assert.deepEqual(put[2], { Ref: 'AWS::NoValue' })
  }
  assert.equal(deploymentTemplate(source, true).Resources.AgentReviewHarness.Type, 'AWS::BedrockAgentCore::Harness')
})
