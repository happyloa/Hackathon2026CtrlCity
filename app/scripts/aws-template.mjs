import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { appDir, templatePath } from './aws-cli-utils.mjs'

const tags = ['Ref', 'Sub', 'GetAtt', 'If', 'Equals', 'Not', 'And', 'Or', 'Join', 'Select', 'GetAZs', 'Condition']
const customTags = tags.flatMap(name => ['scalar', 'seq'].map(collection => ({
  tag: `!${name}`, ...(collection === 'seq' ? { collection: 'seq' } : {}),
  resolve(value) {
    let data = collection === 'seq' ? value.toJSON() : value
    if (name === 'GetAtt' && typeof data === 'string') data = data.split('.')
    return { [name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`]: data }
  },
})))

export function deploymentTemplate(source, createHarness = false) {
  const template = parse(source, { customTags })
  // CloudFormation validates resource types even behind false conditions.
  // Exclude the optional Harness from deployments that do not request it.
  if (!createHarness) {
    delete template.Conditions.CreateManagedHarness
    for (const section of ['Resources', 'Outputs']) {
      for (const [key, value] of Object.entries(template[section] || {})) {
        if (value.Condition === 'CreateManagedHarness') delete template[section][key]
      }
    }
    function prune(value) {
      if (Array.isArray(value)) return value.map(prune)
      if (!value || typeof value !== 'object') return value
      if (value['Fn::If']?.[0] === 'CreateManagedHarness') return prune(value['Fn::If'][2])
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prune(item)]))
    }
    return prune(template)
  }
  return template
}

export function prepareDeploymentTemplate(createHarness = false) {
  const template = deploymentTemplate(readFileSync(templatePath, 'utf8'), createHarness)
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type === 'AWS::Serverless::Function') resource.Properties.CodeUri = '../../'
  }
  const dir = resolve(appDir, '.aws-sam', 'source')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, 'template.json')
  writeFileSync(path, JSON.stringify(template, null, 2))
  return path
}
