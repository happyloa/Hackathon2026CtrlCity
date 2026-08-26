export interface OperationalAdjustment {
  id: string
  stationId: string
  stationName: string
  district: string
  reason: string
  /** Inclusive start, "YYYY-MM-DDTHH:mm". */
  startAt: string
  /** Exclusive end, or null for an open-ended suspension. */
  endAt: string | null
  createdAt: string
  updatedAt: string
}

export interface OperationalAdjustmentDraft {
  stationId: string
  stationName: string
  district: string
  reason: string
  startAt: string
  endAt: string | null
}

export interface AdjustmentValidationIssue {
  field: 'stationId' | 'startAt' | 'endAt'
  message: string
}

export interface ExclusionIndex {
  readonly isEmpty: boolean
  readonly stationCount: number
  excludes: (stationId: string, epoch: number) => boolean
}

export function parseLocalDateTime(value: string | null | undefined): number | null
export function formatLocalDateTime(epoch: number): string
export function validateAdjustment(draft: OperationalAdjustmentDraft): AdjustmentValidationIssue[]
export function adjustmentCovers(adjustment: OperationalAdjustment, epoch: number): boolean
export function adjustmentsOverlap(left: OperationalAdjustment, right: OperationalAdjustment): boolean
export function buildExclusionIndex(adjustments: readonly OperationalAdjustment[]): ExclusionIndex
export function sortAdjustments(adjustments: readonly OperationalAdjustment[]): OperationalAdjustment[]
export function parseAdjustmentsFile(raw: unknown): OperationalAdjustment[]
