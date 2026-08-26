import type { StationRisk } from './ops'

export interface StationPopularityHour {
  hour: number
  sampleDays: number
  meanAvailableBikes: number
  meanAvailableDocks: number
}

export function taipeiWeekday(value: Date | number = new Date()): number {
  const epoch = value instanceof Date ? value.getTime() : value
  return new Date(epoch + 8 * 60 * 60_000).getUTCDay()
}

export function stationPopularityMatchKey(station: Pick<StationRisk, 'district' | 'name'>): string {
  const name = station.name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^YouBike\s*2(?:\.0)?[_\s-]*/i, '')
    .replace(/^YouBike[_\s-]*/i, '')
  return `${station.district.normalize('NFKC').trim()}|${name}`
}
