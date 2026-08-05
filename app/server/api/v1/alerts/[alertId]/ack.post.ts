import { createError, defineEventHandler, getRouterParam } from 'h3'
import { acknowledgeAlert, getDashboard, toEnvelope } from '../../../../utils/ops-store'

export default defineEventHandler((event) => {
  const alertId = getRouterParam(event, 'alertId')
  if (!alertId) throw createError({ statusCode: 400, statusMessage: 'alertId is required.' })

  const alert = acknowledgeAlert(alertId)
  if (!alert) throw createError({ statusCode: 404, statusMessage: 'Alert was not found.' })

  const dashboard = getDashboard()
  return toEnvelope({ alert, persistence: 'demo_memory' as const }, dashboard)
})
