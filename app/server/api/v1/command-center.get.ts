import { defineEventHandler } from 'h3'
import { getDashboard, toEnvelope } from '../../utils/ops-store'
import { dashboardQuery } from '../../utils/request'

export default defineEventHandler((event) => {
  const dashboard = getDashboard(dashboardQuery(event))
  return toEnvelope(dashboard, dashboard)
})
