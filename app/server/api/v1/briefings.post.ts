import { defineEventHandler, readBody } from 'h3'
import type { HorizonKey } from '~/shared/ops'
import { createBriefing } from '../../utils/briefing'
import { getDashboard } from '../../utils/ops-store'

type BriefingBody = { asOf?: unknown; horizonMinutes?: unknown; district?: unknown }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function horizon(value: unknown): HorizonKey {
  const parsed = String(value ?? '60')
  return parsed === '30' || parsed === '120' ? parsed : '60'
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<BriefingBody>(event)) ?? {}
  const asOf = text(body.asOf)
  const district = text(body.district)
  const selectedHorizon = horizon(body.horizonMinutes)
  const dashboard = getDashboard({ at: asOf, district })
  const config = useRuntimeConfig(event)

  return createBriefing(dashboard, {
    asOf: dashboard.meta.asOf,
    horizon: selectedHorizon,
    district,
  }, {
    provider: String(config.narrativeProvider ?? 'template'),
    region: text(config.awsRegion),
    modelId: text(config.bedrockModelId),
  })
})
