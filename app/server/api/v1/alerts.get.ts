import { defineEventHandler } from 'h3'
import { getAlerts, toEnvelope } from '../../utils/ops-store'
import { dashboardQuery } from '../../utils/request'

export default defineEventHandler((event) => {
  const result = getAlerts(dashboardQuery(event))
  return toEnvelope({ alerts: result.alerts }, result.dashboard)
})
