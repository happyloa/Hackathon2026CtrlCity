export type DemandEventPattern = 'borrow_surge' | 'return_surge' | 'fills_then_empties' | 'empties_then_fills'
export const DEMAND_EVENT_PATTERNS: readonly DemandEventPattern[]
export interface DemandEvent { id: string; name: string; stationIds: string[]; startAt: string; endAt: string; pattern: DemandEventPattern; note: string }
export function parseDemandEventsFile(raw: unknown): DemandEvent[]
