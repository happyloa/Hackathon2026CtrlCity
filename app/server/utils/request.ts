import type { H3Event } from 'h3'
import { getQuery } from 'h3'
import type { DashboardQuery } from './ops-store'

function firstString(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

export function dashboardQuery(event: H3Event): DashboardQuery {
  const query = getQuery(event)
  return {
    at: firstString(query.at),
    district: firstString(query.district),
  }
}

export function queryValue(event: H3Event, name: string): string | undefined {
  return firstString(getQuery(event)[name])
}
