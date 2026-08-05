import { createError, defineEventHandler, getRouterParam } from 'h3'
import { getStationDetail, toEnvelope } from '../../../utils/ops-store'
import { dashboardQuery } from '../../../utils/request'

export default defineEventHandler((event) => {
  const stationId = getRouterParam(event, 'stationId')
  if (!stationId) throw createError({ statusCode: 400, statusMessage: 'stationId is required.' })

  const detail = getStationDetail(stationId, dashboardQuery(event).at)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'Station was not found in this replay scenario.' })

  return toEnvelope({ station: detail.station, history: detail.history }, detail.dashboard)
})
