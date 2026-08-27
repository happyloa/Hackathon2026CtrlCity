/**
 * Ad hoc analysis (not wired into the build): identify the stations most
 * prone to bike/dock shortage using the existing lowBikesRate/lowDocksRate
 * columns already produced by station-time-profile.mjs (no re-running the
 * baseline evaluation), then break down by time-of-day and workday/weekend,
 * and cluster the flagged stations by 300m proximity (matching the radius
 * already used for co-failure severity elsewhere in this project).
 *
 * Usage: node app/scripts/analyze-high-risk-stations.mjs [outDir]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'csv-parse/sync'

const APP_DIR = resolve(import.meta.dirname, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const PROFILE_CSV = resolve(REPO_DIR, 'ml', 'output', 'station-time-profile-all.csv')
const ROI_JSON = resolve(APP_DIR, 'data', 'operational-roi.json')
const OUT_DIR = resolve(process.argv[2] ?? resolve(REPO_DIR, 'docs', '_scratch'))

const MIN_OBSERVATIONS = 6 // matches SUFFICIENT_BASELINE_MIN_SAMPLES elsewhere
const TOP_N_STATIONS = 60
const CLUSTER_RADIUS_METERS = Number(process.argv[3] ?? 300)
const WORKDAYS = new Set([1, 2, 3, 4, 5])
const WEEKEND = new Set([0, 6])

function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const earthRadiusM = 6371000
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]))
  }
  find(id) {
    while (this.parent.get(id) !== id) {
      this.parent.set(id, this.parent.get(this.parent.get(id)))
      id = this.parent.get(id)
    }
    return id
  }
  union(a, b) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent.set(rootA, rootB)
  }
}

async function loadProfileRows() {
  const raw = await readFile(PROFILE_CSV, 'utf8')
  return parse(raw, { columns: true, skip_empty_lines: true, cast: (value, ctx) => {
    if (['totalDocks', 'weekday', 'slot', 'observations', 'distinctDays', 'unavailableCount'].includes(ctx.column)) {
      return value === '' ? null : Number(value)
    }
    if (['meanBikes', 'meanDocks', 'emptyRate', 'fullRate', 'lowBikesRate', 'lowDocksRate'].includes(ctx.column)) {
      return value === '' ? null : Number(value)
    }
    return value
  } })
}

async function loadCoordinates() {
  const roi = JSON.parse(await readFile(ROI_JSON, 'utf8'))
  const map = new Map()
  for (const [id, , , , latitude, longitude] of roi.stations) {
    map.set(id, { latitude, longitude })
  }
  return map
}

function timeBucket(slot) {
  const hour = Math.floor(slot / 2)
  if (hour < 6) return '凌晨 00:00-06:00'
  if (hour < 9) return '通勤上午 06:00-09:00'
  if (hour < 12) return '上午離峰 09:00-12:00'
  if (hour < 14) return '午間 12:00-14:00'
  if (hour < 17) return '下午 14:00-17:00'
  if (hour < 20) return '傍晚尖峰 17:00-20:00'
  return '夜間 20:00-24:00'
}

function main() {
  return (async () => {
    await mkdir(OUT_DIR, { recursive: true })
    const rows = await loadProfileRows()
    const coordinates = await loadCoordinates()

    // Aggregate per station: weighted-average risk across all sufficiently-
    // sampled weekday x slot cells, plus per-cell detail kept for the
    // workday/weekend and time-of-day breakdown.
    const byStation = new Map()
    for (const row of rows) {
      if (row.observations === null || row.observations < MIN_OBSERVATIONS) continue
      let station = byStation.get(row.stationId)
      if (!station) {
        station = {
          stationId: row.stationId, city: row.city, district: row.district, name: row.name,
          totalDocks: row.totalDocks, cells: [],
        }
        byStation.set(row.stationId, station)
      }
      station.cells.push(row)
    }

    const stations = []
    for (const station of byStation.values()) {
      let obsSum = 0, bikeWeighted = 0, dockWeighted = 0
      for (const cell of station.cells) {
        obsSum += cell.observations
        bikeWeighted += cell.lowBikesRate * cell.observations
        dockWeighted += cell.lowDocksRate * cell.observations
      }
      if (obsSum === 0) continue
      const bikeRisk = bikeWeighted / obsSum
      const dockRisk = dockWeighted / obsSum
      stations.push({ ...station, bikeRisk, dockRisk, combinedRisk: bikeRisk + dockRisk, cellCount: station.cells.length, totalObservations: obsSum })
    }

    stations.sort((a, b) => b.combinedRisk - a.combinedRisk)
    const flagged = stations.slice(0, TOP_N_STATIONS)

    function peakOf(cells, weekdaySet, key) {
      let best = null
      for (const cell of cells) {
        if (!weekdaySet.has(cell.weekday)) continue
        if (best === null || cell[key] > best[key]) best = cell
      }
      if (!best || best[key] <= 0) return null
      return { slot: best.slot, timeLabel: best.timeLabel, bucket: timeBucket(best.slot), rate: best[key] }
    }

    for (const station of flagged) {
      station.workdayBikePeak = peakOf(station.cells, WORKDAYS, 'lowBikesRate')
      station.workdayDockPeak = peakOf(station.cells, WORKDAYS, 'lowDocksRate')
      station.weekendBikePeak = peakOf(station.cells, WEEKEND, 'lowBikesRate')
      station.weekendDockPeak = peakOf(station.cells, WEEKEND, 'lowDocksRate')
      delete station.cells
      const coord = coordinates.get(station.stationId)
      station.latitude = coord?.latitude ?? null
      station.longitude = coord?.longitude ?? null
    }

    // 300m proximity clustering among the flagged stations only.
    const withCoords = flagged.filter((s) => s.latitude !== null && s.longitude !== null)
    const uf = new UnionFind(withCoords.map((s) => s.stationId))
    for (let i = 0; i < withCoords.length; i += 1) {
      for (let j = i + 1; j < withCoords.length; j += 1) {
        if (haversineMeters(withCoords[i], withCoords[j]) <= CLUSTER_RADIUS_METERS) {
          uf.union(withCoords[i].stationId, withCoords[j].stationId)
        }
      }
    }
    const clusters = new Map()
    for (const station of withCoords) {
      const root = uf.find(station.stationId)
      if (!clusters.has(root)) clusters.set(root, [])
      clusters.get(root).push(station)
    }
    const clusterList = [...clusters.values()]
      .map((members) => ({
        clusterId: members[0].stationId,
        size: members.length,
        districts: [...new Set(members.map((m) => m.district))],
        stations: members.map((m) => ({ stationId: m.stationId, name: m.name, district: m.district, combinedRisk: +m.combinedRisk.toFixed(3) })),
      }))
      .sort((a, b) => b.size - a.size)
    const clusterByStation = new Map()
    for (const cluster of clusterList) {
      for (const member of cluster.stations) clusterByStation.set(member.stationId, cluster)
    }
    for (const station of flagged) {
      const cluster = clusterByStation.get(station.stationId)
      station.clusterId = cluster?.clusterId ?? null
      station.clusterSize = cluster?.size ?? 1
    }

    // --- write outputs ---
    const jsonOut = {
      generatedAt: new Date().toISOString(),
      method: {
        source: 'ml/output/station-time-profile-all.csv (lowBikesRate/lowDocksRate, threshold = max(2, ceil(totalDocks*0.1)))',
        minObservationsPerCell: MIN_OBSERVATIONS,
        topN: TOP_N_STATIONS,
        clusterRadiusMeters: CLUSTER_RADIUS_METERS,
        combinedRiskDefinition: 'weighted-average(lowBikesRate) + weighted-average(lowDocksRate) across all sufficiently-sampled weekday x slot cells',
      },
      stations: flagged.map((s) => ({
        stationId: s.stationId, name: s.name, city: s.city, district: s.district, totalDocks: s.totalDocks,
        bikeRisk: +s.bikeRisk.toFixed(3), dockRisk: +s.dockRisk.toFixed(3), combinedRisk: +s.combinedRisk.toFixed(3),
        totalObservations: s.totalObservations,
        workdayBikePeak: s.workdayBikePeak, workdayDockPeak: s.workdayDockPeak,
        weekendBikePeak: s.weekendBikePeak, weekendDockPeak: s.weekendDockPeak,
        clusterId: s.clusterId, clusterSize: s.clusterSize,
        latitude: s.latitude, longitude: s.longitude,
      })),
      clusters: clusterList,
    }
    await writeFile(resolve(OUT_DIR, 'high-risk-stations.json'), JSON.stringify(jsonOut, null, 2), 'utf8')

    const csvHeader = ['stationId', 'name', 'city', 'district', 'totalDocks', 'bikeRisk', 'dockRisk', 'combinedRisk',
      'workdayBikePeakTime', 'workdayBikePeakRate', 'workdayDockPeakTime', 'workdayDockPeakRate',
      'weekendBikePeakTime', 'weekendBikePeakRate', 'weekendDockPeakTime', 'weekendDockPeakRate',
      'clusterId', 'clusterSize', 'latitude', 'longitude'].join(',')
    const csvRows = flagged.map((s) => [
      s.stationId, `"${s.name}"`, s.city, s.district, s.totalDocks,
      s.bikeRisk.toFixed(3), s.dockRisk.toFixed(3), s.combinedRisk.toFixed(3),
      s.workdayBikePeak?.timeLabel ?? '', s.workdayBikePeak?.rate?.toFixed(3) ?? '',
      s.workdayDockPeak?.timeLabel ?? '', s.workdayDockPeak?.rate?.toFixed(3) ?? '',
      s.weekendBikePeak?.timeLabel ?? '', s.weekendBikePeak?.rate?.toFixed(3) ?? '',
      s.weekendDockPeak?.timeLabel ?? '', s.weekendDockPeak?.rate?.toFixed(3) ?? '',
      s.clusterId, s.clusterSize, s.latitude, s.longitude,
    ].join(','))
    await writeFile(resolve(OUT_DIR, 'high-risk-stations.csv'), [csvHeader, ...csvRows].join('\n') + '\n', 'utf8')

    // --- text summary ---
    const bikeBucketCounts = new Map()
    const dockBucketCounts = new Map()
    for (const s of flagged) {
      if (s.workdayBikePeak) bikeBucketCounts.set(s.workdayBikePeak.bucket, (bikeBucketCounts.get(s.workdayBikePeak.bucket) ?? 0) + 1)
      if (s.workdayDockPeak) dockBucketCounts.set(s.workdayDockPeak.bucket, (dockBucketCounts.get(s.workdayDockPeak.bucket) ?? 0) + 1)
    }
    const topBikeBucket = [...bikeBucketCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    const topDockBucket = [...dockBucketCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    const multiStationClusters = clusterList.filter((c) => c.size > 1)

    const lines = []
    lines.push(`# 高風險站點分析（共 ${byStation.size} 站中，取前 ${TOP_N_STATIONS} 名）`)
    lines.push('')
    lines.push(`## 方法`)
    lines.push(`- 用既有的 lowBikesRate/lowDocksRate（門檻 = max(2, ceil(總車柱數 x 0.1))），不重跑 F1。`)
    lines.push(`- 每站的 combinedRisk = 所有樣本數 >= ${MIN_OBSERVATIONS} 的「星期 x 時段」格子，依樣本數加權平均 lowBikesRate + lowDocksRate。`)
    lines.push(`- ${CLUSTER_RADIUS_METERS}m 內的站點會被歸成同一群。`)
    lines.push('')
    lines.push(`## 整體時段規律（工作日，前 ${TOP_N_STATIONS} 名站點）`)
    lines.push(`- 缺車尖峰最常出現在：**${topBikeBucket?.[0] ?? '無'}**（${topBikeBucket?.[1] ?? 0} 站的工作日缺車尖峰落在這個時段）`)
    lines.push(`- 滿柱尖峰最常出現在：**${topDockBucket?.[0] ?? '無'}**（${topDockBucket?.[1] ?? 0} 站的工作日滿柱尖峰落在這個時段）`)
    lines.push('')
    lines.push(`## 地理分群`)
    lines.push(`- ${multiStationClusters.length} 群（2站以上）涵蓋 ${multiStationClusters.reduce((sum, c) => sum + c.size, 0)} 站；最大群 ${multiStationClusters[0]?.size ?? 0} 站（${multiStationClusters[0]?.districts.join('、') ?? ''}）`)
    for (const cluster of multiStationClusters.slice(0, 10)) {
      lines.push(`  - ${cluster.districts.join('、')}：${cluster.stations.map((s) => s.name).join('、')}（${cluster.size}站）`)
    }
    lines.push('')
    lines.push(`## 前 15 名高風險站點`)
    for (const s of flagged.slice(0, 15)) {
      lines.push(`- **${s.name}**（${s.district}，${s.totalDocks}柱）combinedRisk=${s.combinedRisk.toFixed(3)}；工作日缺車尖峰 ${s.workdayBikePeak ? `${s.workdayBikePeak.timeLabel}（${(s.workdayBikePeak.rate * 100).toFixed(0)}%）` : '無'}；工作日滿柱尖峰 ${s.workdayDockPeak ? `${s.workdayDockPeak.timeLabel}（${(s.workdayDockPeak.rate * 100).toFixed(0)}%）` : '無'}${s.clusterSize > 1 ? `；同群 ${s.clusterSize} 站` : ''}`)
    }
    await writeFile(resolve(OUT_DIR, 'high-risk-stations-summary.md'), lines.join('\n') + '\n', 'utf8')

    console.log(`Wrote ${OUT_DIR}/high-risk-stations.json (${flagged.length} stations)`)
    console.log(`Wrote ${OUT_DIR}/high-risk-stations.csv`)
    console.log(`Wrote ${OUT_DIR}/high-risk-stations-summary.md`)
  })()
}

main().catch((error) => {
  console.error(error.stack ?? error.message)
  process.exitCode = 1
})
