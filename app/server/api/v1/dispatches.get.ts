import { defineEventHandler } from 'h3'
import { getDispatches, toEnvelope } from '../../utils/ops-store'
import { dashboardQuery } from '../../utils/request'

export default defineEventHandler((event) => {
  const result = getDispatches(dashboardQuery(event))
  return toEnvelope({ dispatches: result.dispatches }, result.dashboard)
})
