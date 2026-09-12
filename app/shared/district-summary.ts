import type { Alert, StationRisk } from './ops.ts'
import { stationOverviewStatus, type StationOverviewStatus } from './station-overview.ts'

export interface DistrictSummary {
  district: string
  total: number
  counts: Record<StationOverviewStatus, number>
  emptyNow: number
  fullNow: number
  forecastStations: number
  highRiskStations: number
  /** Mean 60-minute model risk, 0–100. Unmatched/service stations are excluded. */
  averageRisk: number | null
  attentionCount: number
  attentionRate: number
  availableBikes: number
  availableDocks: number
}

/** Aggregate the complete city snapshot before applying any UI filters. */
export function summarizeStationDistricts(stations: readonly StationRisk[], alerts: readonly Alert[]): DistrictSummary[] {
  const alertLookup = new Map(alerts.map(alert => [alert.stationId, alert]))
  const groups = new Map<string, { summary: DistrictSummary; riskSum: number }>()
  for (const station of stations) {
    let entry = groups.get(station.district)
    if (!entry) {
      entry = { riskSum: 0, summary: {
        district: station.district, total: 0,
        counts: { empty: 0, full: 0, stable: 0, unknown: 0, service: 0 },
        emptyNow: 0, fullNow: 0, forecastStations: 0, highRiskStations: 0,
        averageRisk: null, attentionCount: 0, attentionRate: 0, availableBikes: 0, availableDocks: 0,
      } }
      groups.set(station.district, entry)
    }
    const summary = entry.summary
    const status = stationOverviewStatus(station, alertLookup.get(station.id))
    summary.total++
    summary.counts[status]++
    // A disabled station with zero inventory must not become an empty/full station.
    if (status === 'service') continue
    if (station.currentState === 'empty_now') summary.emptyNow++
    if (station.currentState === 'full_now') summary.fullNow++
    summary.availableBikes += station.availableBikes
    summary.availableDocks += station.availableDocks
    const forecast = station.forecast.horizons['60']
    if (forecast.baselineStatus !== 'matched' || !Number.isFinite(forecast.riskScore)) continue
    summary.forecastStations++
    entry.riskSum += Math.min(1, Math.max(0, forecast.riskScore)) * 100
    if (forecast.level === 'high' || forecast.level === 'critical') summary.highRiskStations++
  }
  return [...groups.values()].map(({ summary, riskSum }) => {
    summary.averageRisk = summary.forecastStations ? riskSum / summary.forecastStations : null
    summary.attentionCount = summary.counts.empty + summary.counts.full
    summary.attentionRate = summary.total ? summary.attentionCount / summary.total : 0
    return summary
  }).sort((a, b) => b.attentionCount - a.attentionCount
    || b.attentionRate - a.attentionRate
    || a.district.localeCompare(b.district, 'zh-Hant'))
}

export type DistrictTone = 'none' | 'quiet' | 'low' | 'medium' | 'high'

/** Legend thresholds describe the share of attention stations, not model risk. */
export function districtAttentionTone(summary?: DistrictSummary): DistrictTone {
  if (!summary || !summary.total || summary.counts.unknown + summary.counts.service === summary.total) return 'none'
  if (summary.attentionCount === 0) return 'quiet'
  if (summary.attentionRate <= 0.1) return 'low'
  if (summary.attentionRate <= 0.25) return 'medium'
  return 'high'
}
