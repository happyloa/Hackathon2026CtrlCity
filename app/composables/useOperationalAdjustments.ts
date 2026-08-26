import {
  parseAdjustmentsFile,
  sortAdjustments,
  validateAdjustment,
  adjustmentsOverlap,
  type AdjustmentValidationIssue,
  type OperationalAdjustment,
  type OperationalAdjustmentDraft,
} from '~/shared/operational-adjustments.mjs'
import seed from '~/data/operational-adjustments.json'

const STORAGE_KEY = 'operational-adjustments:v1'
const STATE_KEY = 'operational-adjustments-state:v1'

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `adj_${crypto.randomUUID()}`
  return `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Operator-declared suspensions.
 *
 * The site is a static export with no backend, so edits live in this browser's
 * localStorage. The committed `app/data/operational-adjustments.json` is the
 * seed and, more importantly, the file the offline pipeline reads — which is
 * why the page pushes operators to export and commit after editing. Without
 * that export the exclusions shape what this browser shows but never reach the
 * model.
 */
export function useOperationalAdjustments() {
  const adjustments = useState<OperationalAdjustment[]>(STATE_KEY, () => parseAdjustmentsFile(seed))
  const loaded = useState<boolean>(`${STATE_KEY}:loaded`, () => false)

  function persist() {
    if (!import.meta.client) return
    try {
      // `dirty` marks that this browser has an explicit local edit worth
      // protecting. Without it, any pre-existing localStorage value (even a
      // stale empty array left over from before the seed had data) would
      // permanently win over a freshly regenerated seed on every future load.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ adjustments: adjustments.value, dirty: true }))
    } catch {
      // A full or blocked storage quota must not take the page down; the
      // exported file remains the durable copy.
    }
  }

  function load() {
    if (!import.meta.client || loaded.value) return
    loaded.value = true
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      // A payload without the dirty marker predates this check, or was never
      // written by a real edit — treat it as untouched and keep the seed.
      if (parsed?.dirty !== true) return
      adjustments.value = parseAdjustmentsFile(parsed)
    } catch {
      // Corrupt storage falls back to the committed seed.
    }
  }

  onMounted(load)

  const sorted = computed(() => sortAdjustments(adjustments.value))

  const openEnded = computed(() => sorted.value.filter(item => item.endAt === null))

  function conflictsFor(candidate: OperationalAdjustment): OperationalAdjustment[] {
    return adjustments.value.filter(existing => adjustmentsOverlap(candidate, existing))
  }

  function add(draft: OperationalAdjustmentDraft): { ok: true; item: OperationalAdjustment } | { ok: false; issues: AdjustmentValidationIssue[] } {
    const issues = validateAdjustment(draft)
    if (issues.length) return { ok: false, issues }

    const now = new Date().toISOString()
    const item: OperationalAdjustment = {
      id: createId(),
      stationId: draft.stationId.trim(),
      stationName: draft.stationName.trim(),
      district: draft.district.trim(),
      reason: draft.reason.trim(),
      startAt: draft.startAt.trim(),
      endAt: draft.endAt && draft.endAt.trim() ? draft.endAt.trim() : null,
      createdAt: now,
      updatedAt: now,
    }
    adjustments.value = [...adjustments.value, item]
    persist()
    return { ok: true, item }
  }

  function update(id: string, draft: OperationalAdjustmentDraft): { ok: true } | { ok: false; issues: AdjustmentValidationIssue[] } {
    const issues = validateAdjustment(draft)
    if (issues.length) return { ok: false, issues }

    adjustments.value = adjustments.value.map(item => item.id === id
      ? {
          ...item,
          stationId: draft.stationId.trim(),
          stationName: draft.stationName.trim(),
          district: draft.district.trim(),
          reason: draft.reason.trim(),
          startAt: draft.startAt.trim(),
          endAt: draft.endAt && draft.endAt.trim() ? draft.endAt.trim() : null,
          updatedAt: new Date().toISOString(),
        }
      : item)
    persist()
    return { ok: true }
  }

  function remove(id: string) {
    adjustments.value = adjustments.value.filter(item => item.id !== id)
    persist()
  }

  function closeNow(id: string, endAt: string) {
    adjustments.value = adjustments.value.map(item => item.id === id
      ? { ...item, endAt, updatedAt: new Date().toISOString() }
      : item)
    persist()
  }

  function replaceAll(next: OperationalAdjustment[]) {
    adjustments.value = next
    persist()
  }

  function exportPayload(): string {
    return `${JSON.stringify({
      schemaVersion: '1.0',
      note: '營運調整排除窗。覆蓋 app/data/operational-adjustments.json 後重跑統計，模型即會忽略這些站點時段。',
      exportedAt: new Date().toISOString(),
      adjustments: sortAdjustments(adjustments.value),
    }, null, 2)}\n`
  }

  /**
   * Reloads from the committed seed file, overwriting whatever is in
   * localStorage. Needed because localStorage always wins over an updated
   * seed once populated (so a real local edit is never silently clobbered) —
   * which also means a batch of exclusions written straight into
   * data/operational-adjustments.json (e.g. by a detection script) never
   * reaches a browser that already has ANY stored state, even an empty one.
   */
  function reloadFromSeed(): number {
    const next = parseAdjustmentsFile(seed)
    replaceAll(next)
    return next.length
  }

  function importPayload(raw: string): { ok: true; count: number } | { ok: false; message: string } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, message: 'JSON 格式不正確，無法解析' }
    }
    const next = parseAdjustmentsFile(parsed)
    if (!next.length) return { ok: false, message: '檔案中沒有有效的排除窗（需要 stationId 與合法的 startAt）' }
    replaceAll(next)
    return { ok: true, count: next.length }
  }

  return {
    adjustments: sorted,
    openEnded,
    add,
    update,
    remove,
    closeNow,
    replaceAll,
    conflictsFor,
    exportPayload,
    importPayload,
    reloadFromSeed,
  }
}
