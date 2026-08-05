import { createError, defineEventHandler, getRouterParam } from 'h3'
import { acceptDispatch, getDashboard, toEnvelope } from '../../../../utils/ops-store'

export default defineEventHandler((event) => {
  const dispatchId = getRouterParam(event, 'dispatchId')
  if (!dispatchId) throw createError({ statusCode: 400, statusMessage: 'dispatchId is required.' })

  const dispatch = acceptDispatch(dispatchId)
  if (!dispatch) throw createError({ statusCode: 404, statusMessage: 'Dispatch recommendation was not found.' })

  const dashboard = getDashboard()
  return toEnvelope({ dispatch, persistence: 'demo_memory' as const }, dashboard)
})
