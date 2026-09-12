export interface DemandEvent { id: string; name: string; stationIds: string[]; startAt: string; endAt: string; note: string }
export function parseDemandEventsFile(raw: unknown): DemandEvent[]
