import type { ManualRoute } from './manual-route-planner.ts'

export function parseManualRoutesFile(raw: unknown): ManualRoute[] {
  const list = (raw as { routes?: unknown } | null)?.routes
  if (!Array.isArray(list)) throw new Error('需要 routes 陣列')
  const ids = new Set<string>()
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000
  return list.map(route => {
    if (!route || !text(route.id) || ids.has(route.id) || !text(route.label)
      || !count(route.vehicleCapacity) || route.vehicleCapacity < 1
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(route.scheduledAt)
      || !Number.isFinite(Date.parse(route.createdAt)) || !Number.isFinite(Date.parse(route.updatedAt))
      || !Array.isArray(route.stops) || route.stops.length > 100) throw new Error('路線格式不正確')
    ids.add(route.id)
    const stopIds = new Set<string>()
    const stops = route.stops.map((stop: Record<string, unknown>) => {
      if (!stop || !text(stop.id) || stopIds.has(String(stop.id)) || !text(stop.stationId) || !count(stop.pickupBikes) || !count(stop.dropoffBikes)) throw new Error('停靠站格式不正確')
      stopIds.add(String(stop.id))
      return { id: String(stop.id), stationId: String(stop.stationId), pickupBikes: Number(stop.pickupBikes), dropoffBikes: Number(stop.dropoffBikes) }
    })
    return { id: route.id, label: route.label, vehicleCapacity: route.vehicleCapacity, scheduledAt: route.scheduledAt, createdAt: route.createdAt, updatedAt: route.updatedAt, stops }
  })
}
