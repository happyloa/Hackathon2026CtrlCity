/** Extend descriptive history only. The chronological model-training split stays frozen. */
export function historyPeriod(rolling, now = new Date()) {
  const dayMs = 86400000
  const origin = Date.UTC(2026, 0, 1)
  const frozenEnd = Date.UTC(2026, 6, 1)
  const taipei = new Date(now.getTime() + 8 * 3600000)
  const nextDay = Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth(), taipei.getUTCDate() + 1)
  const end = rolling ? Math.max(frozenEnd, nextDay) : frozenEnd
  const days = Math.round((end - origin) / dayMs)
  const through = new Date(end - dayMs).toISOString().slice(0, 10)
  return { origin, end, days, detailShardCount: Math.max(2, Math.ceil(days / 181) * 2), label: rolling ? `滾動全期 2026-01-01 至 ${through}` : '全期 1-6 月' }
}
