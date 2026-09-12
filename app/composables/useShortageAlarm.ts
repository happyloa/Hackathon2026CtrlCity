import type { DashboardArtifact, StationRisk } from '~/shared/ops'
import { displayStationName } from '~/shared/ops'
import { LIVE_SNAPSHOT_POLICY } from '~/shared/parameters.mjs'

/** Only stations short for at least this long raise the alarm. */
export const SHORTAGE_ALARM_MINUTES = 60

/** Most stations listed in the dialog before it switches to a summary line. */
const LISTED_STATIONS = 8

const SESSION_KEY = 'shortage-alarm-shown:v1'

export interface ShortageAlarmStation {
  id: string
  name: string
  district: string
  availableBikes: number
}

export interface ShortageAlarmSnapshot {
  stations: ShortageAlarmStation[]
  /** Total qualifying stations, which can exceed `stations.length`. */
  total: number
}

/**
 * Stations whose available bikes have stayed below the 缺車 line
 * (`LIVE_SNAPSHOT_POLICY.lowBikesThreshold`) for at least
 * `SHORTAGE_ALARM_MINUTES` without a break.
 *
 * Read from the scheduler's published runs rather than measured in the
 * browser: the capture Lambda has watched every five-minute poll since long
 * before this tab opened, so the answer is complete on first paint. A
 * deployment without those runs reports nothing rather than reporting a
 * number the browser has not actually observed for an hour yet.
 */
export function shortageAlarmSnapshot(dashboard: DashboardArtifact | null | undefined): ShortageAlarmSnapshot {
  const ids = dashboard?.realtimeLowBikes?.atLeast60
  if (!dashboard || !ids?.length) return { stations: [], total: 0 }
  const byId = new Map(dashboard.stations.map((station: StationRisk) => [station.id, station]))
  const stations = ids
    .map(id => byId.get(id))
    .filter((station): station is StationRisk => Boolean(station))
    .sort((left, right) => left.availableBikes - right.availableBikes || left.id.localeCompare(right.id))
  return {
    total: stations.length,
    stations: stations.slice(0, LISTED_STATIONS).map(station => ({
      id: station.id,
      name: displayStationName(station.name),
      district: station.district || '行政區未標示',
      availableBikes: station.availableBikes,
    })),
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] as string
  ))
}

function bodyHtml(snapshot: ShortageAlarmSnapshot): string {
  const rows = snapshot.stations.map(station => `
    <li class="shortage-alarm-row">
      <span class="shortage-alarm-station">
        <strong>${escapeHtml(station.name)}</strong>
        <small>${escapeHtml(station.district)}</small>
      </span>
      <span class="shortage-alarm-bikes">可借 <b>${station.availableBikes}</b> 台</span>
    </li>`).join('')
  const remainder = snapshot.total - snapshot.stations.length
  const more = remainder > 0
    ? `<p class="shortage-alarm-more">另有 ${remainder} 站符合條件，請至站點總覽查看完整清單。</p>`
    : ''
  return `<ul class="shortage-alarm-list">${rows}</ul>${more}`
}

/**
 * The dashboard's opening alarm for prolonged shortages.
 *
 * `notifyOnce` fires at most once per browser tab session, so a five-minute
 * poll does not reopen the dialog over an operator already working. The admin
 * demo button calls `show` directly, which deliberately ignores that guard.
 */
export function useShortageAlarm() {
  const threshold = LIVE_SNAPSHOT_POLICY.lowBikesThreshold

  async function show(snapshot: ShortageAlarmSnapshot): Promise<boolean> {
    if (!import.meta.client) return false
    const { default: Swal } = await import('sweetalert2')
    if (!snapshot.total) {
      await Swal.fire({
        icon: 'success',
        title: '目前沒有長時間缺車站點',
        text: `沒有站點的可借車數低於 ${threshold} 台並持續 ${SHORTAGE_ALARM_MINUTES} 分鐘以上。`,
        confirmButtonText: '知道了',
        customClass: { popup: 'shortage-alarm' },
      })
      return false
    }
    const result = await Swal.fire({
      icon: 'warning',
      title: `${snapshot.total} 站已缺車超過 ${SHORTAGE_ALARM_MINUTES} 分鐘`,
      html: bodyHtml(snapshot),
      showCancelButton: true,
      confirmButtonText: '前往調度規劃',
      cancelButtonText: '稍後處理',
      customClass: { popup: 'shortage-alarm' },
      footer: `判定門檻：可借車數低於 ${threshold} 台（近端缺車），持續時間由排程每 5 分鐘記錄。`,
    })
    return result.isConfirmed
  }

  function alreadyNotified(): boolean {
    try { return sessionStorage.getItem(SESSION_KEY) === '1' } catch { return false }
  }

  function markNotified() {
    try { sessionStorage.setItem(SESSION_KEY, '1') } catch { /* once per page load is still better than every poll */ }
  }

  async function notifyOnce(dashboard: DashboardArtifact | null | undefined): Promise<boolean> {
    if (!import.meta.client || alreadyNotified()) return false
    const snapshot = shortageAlarmSnapshot(dashboard)
    if (!snapshot.total) return false
    markNotified()
    return show(snapshot)
  }

  return { show, notifyOnce, threshold }
}
