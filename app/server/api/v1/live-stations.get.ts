import { defineEventHandler, setResponseHeader } from 'h3'
import { fetchLiveStations } from '../../utils/live-feed'
import { queryValue } from '../../utils/request'

function asOfFromSourceTime(value: string | undefined): string {
  if (value && /^\d{8}T\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}+08:00`
  }
  return new Date().toISOString()
}

export default defineEventHandler(async (event) => {
  // The client owns the five-minute polling cadence; never let an intermediary serve an old API response.
  setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
  const district = queryValue(event, 'district')
  const forceRefresh = queryValue(event, 'refresh') === '1'
  const stations = await fetchLiveStations(district, { forceRefresh })
  const sourceUpdatedAt = stations.map(station => station.sourceUpdatedAt).filter(Boolean).sort().at(-1)
  return {
    data: {
      dataMode: 'live' as const,
      source: 'ntpc-open-data',
      district: district ?? null,
      stations,
    },
    meta: {
      asOf: asOfFromSourceTime(sourceUpdatedAt),
      generatedAt: new Date().toISOString(),
      dataMode: 'live' as const,
      forecastModel: 'live-inventory-only',
      narrativeProvider: 'template' as const,
      persistence: 'none' as const,
    },
  }
})
