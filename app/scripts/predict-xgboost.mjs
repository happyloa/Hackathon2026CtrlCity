// Manual local demo (`npm run predict:xgboost`): fetches the official live
// feed once, runs the validated tree-walking algorithm (see
// ml/src/validate_tree_walker.py for how the categorical-split direction bug
// was found and fixed) against it, and writes a small static JSON of 30/60
// minute risk scores + integer dispatch quantities.
//
// Only computed for the hybrid deployment's XGBoost-routed stations (rule
// baseline 60min F1 <= 60%, app/data/station-risk-evaluation.json) --
// stations where the baseline already performs well keep using the baseline,
// per the hybrid strategy validated earlier in this PoC.
//
// This is a stopgap for a purely static Cloudflare Pages site: model_30.json
// / model_60.json (80MB/134MB once exported with full category lists) are
// far too large to ship to a browser or fit Cloudflare Pages' 25MiB
// per-asset cap, so inference runs here, once, on demand, on a real Node
// process -- not per page-load. See docs/PoC交接.md's "即時 XGBoost 缺車/滿車
// 警報" section for why, and how this would move to AWS (S3 + Lambda,
// real Python xgboost, per-request inference) if the app leaves Cloudflare
// Pages.
//
// Usage:
//   npm run predict:xgboost

import { access, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const XGBOOST_DIR = resolve(APP_DIR, 'public', 'data', 'xgboost')
const ROI_FILE = resolve(APP_DIR, 'data', 'operational-roi.json')
const RISK_FILE = resolve(APP_DIR, 'data', 'station-risk-evaluation.json')
const OUTPUT_FILE = resolve(XGBOOST_DIR, 'live-predictions.json')

const NTPC_LIVE_STATIONS_URL = 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'
const HORIZONS = [30, 60]
const NEIGHBOR_RADIUS_METERS = 300
const LOW_RATIO = 0.1
const LOW_FLOOR = 2
const BASELINE_F1_XGBOOST_THRESHOLD = 0.60 // matches the validated hybrid deployment cutoff
const EARTH_RADIUS_METERS = 6_371_000

async function requireExportedModels() {
  const missing = []
  for (const horizon of HORIZONS) {
    const path = resolve(XGBOOST_DIR, `model-${horizon}.json`)
    try {
      await access(path)
    } catch {
      missing.push(path)
    }
  }

  if (missing.length) {
    throw new Error([
      'Missing exported XGBoost model artifacts:',
      ...missing.map((path) => `  - ${path}`),
      '',
      'Restore ml/output/model_30.json and model_60.json from the machine or artifact store that trained them, then run:',
      '  python ml/src/export_model_for_web.py',
      '  cd app && npm run predict:xgboost',
      '',
      `The existing static snapshot is still available at ${OUTPUT_FILE}; this command is only needed to refresh it.`,
    ].join('\n'))
  }
}

function normalizeStationName(value) {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^YouBike\s*2(?:\.0)?[_\s-]*/i, '')
    .replace(/^YouBike[_\s-]*/i, '')
}

function matchKey(district, name) {
  return `${district.normalize('NFKC').trim()}|${normalizeStationName(name)}`
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a))
}

function taipeiSlotAndWeekday(nowUtcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(nowUtcMs))
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  const hour = Number(part('hour'))
  const minute = Number(part('minute'))
  const weekdayNames = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { slot: hour * 2 + Math.floor(minute / 30), weekday: weekdayNames[part('weekday')] ?? 0 }
}

/**
 * Validated against xgboost's own predict_proba in ml/src/validate_tree_walker.py:
 * numeric splits go left when value < condition; categorical splits go RIGHT
 * when the value's category code is in the node's category list (the
 * opposite of the first, wrong assumption); missing values follow default_left.
 */
function predictProbability(trees, featureRow) {
  let margin = 0
  for (const tree of trees) {
    let node = 0
    for (;;) {
      const left = tree.left_children[node]
      const right = tree.right_children[node]
      if (left === -1) { margin += tree.base_weights[node]; break }

      const featureIndex = tree.split_indices[node]
      const value = featureRow[featureIndex]
      const splitType = tree.split_type[node]

      if (value === null || Number.isNaN(value)) {
        node = tree.default_left[node] ? left : right
        continue
      }
      if (splitType === 0) {
        node = value < tree.split_conditions[node] ? left : right
      } else {
        const catIndex = tree.categories_nodes.indexOf(node)
        if (catIndex === -1) { node = right; continue }
        const start = tree.categories_segments[catIndex]
        const size = tree.categories_sizes[catIndex]
        const inList = tree.categories.slice(start, start + size).includes(Math.trunc(value))
        node = inList ? right : left
      }
    }
  }
  return 1 / (1 + Math.exp(-margin))
}

function buildFeatureRow(featureNames, values) {
  return featureNames.map((name) => {
    const value = values[name]
    return value === undefined || value === null ? NaN : value
  })
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function fetchLiveStations() {
  const response = await fetch(NTPC_LIVE_STATIONS_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`live feed request failed: ${response.status}`)
  return response.json()
}

function lowBikesThreshold(totalDocks) {
  return Math.max(LOW_FLOOR, Math.ceil(totalDocks * LOW_RATIO))
}

async function main() {
  console.log('Loading routing (baseline F1<=60%), station registry, and exported models...')
  await requireExportedModels()
  const roi = await loadJson(ROI_FILE)
  const risk = await loadJson(RISK_FILE)
  const stationCategories = await loadJson(resolve(XGBOOST_DIR, 'station-categories.json'))
  const stationCodeById = new Map(stationCategories.map((id, index) => [id, index]))

  const models = {}
  for (const horizon of HORIZONS) {
    models[horizon] = await loadJson(resolve(XGBOOST_DIR, `model-${horizon}.json`))
  }

  // roi.stations: [id, district, name, totalDocks, latitude, longitude]
  const stations = roi.stations.map(([id, district, name, totalDocks, latitude, longitude]) => ({
    id, district, name, totalDocks, latitude, longitude,
  }))
  const stationById = new Map(stations.map((station) => [station.id, station]))
  const matchKeyToStationId = new Map(stations.map((station) => [matchKey(station.district, station.name), station.id]))

  const routedStationIds = new Set(
    stations
      .filter((station) => {
        const baseline60 = risk.stations[station.id]?.baseline?.['60']
        if (!baseline60) return false
        const events = baseline60.tp + baseline60.fn
        return events > 0 && baseline60.f1 <= BASELINE_F1_XGBOOST_THRESHOLD
      })
      .map((station) => station.id),
  )
  console.log(`${routedStationIds.size} / ${stations.length} stations routed to XGBoost (baseline 60min F1 <= ${BASELINE_F1_XGBOOST_THRESHOLD * 100}%)`)

  console.log('Fetching live station feed...')
  const liveRaw = await fetchLiveStations()
  const live = liveRaw.map((row) => ({
    id: matchKeyToStationId.get(matchKey(row.sarea, row.sna)) ?? null,
    totalDocks: Math.max(0, Math.round(Number(row.tot_quantity) || 0)),
    availableBikes: Math.max(0, Math.round(Number(row.sbi_quantity) || 0)),
    availableDocks: Math.max(0, Math.round(Number(row.bemp) || 0)),
    active: row.act === '1' || Number(row.act) === 1,
  })).filter((station) => station.id && station.active)
  const liveById = new Map(live.map((station) => [station.id, station]))
  console.log(`${live.length} live stations matched to a known station_id`)

  // Neighbor low-bikes rate (300m, contemporaneous) -- only stations with
  // coordinates and live data participate.
  const withCoords = stations.filter((station) => liveById.has(station.id) && Number.isFinite(station.latitude) && Number.isFinite(station.longitude))
  const neighborLowRateByStation = new Map()
  for (const station of withCoords) {
    let lowCount = 0
    let total = 0
    for (const other of withCoords) {
      if (other.id === station.id) continue
      if (haversineMeters(station.latitude, station.longitude, other.latitude, other.longitude) > NEIGHBOR_RADIUS_METERS) continue
      const otherLive = liveById.get(other.id)
      total += 1
      if (otherLive.availableBikes <= lowBikesThreshold(otherLive.totalDocks)) lowCount += 1
    }
    neighborLowRateByStation.set(station.id, { rate: total ? lowCount / total : NaN, count: total })
  }

  const { slot, weekday } = taipeiSlotAndWeekday(Date.now())
  console.log(`Taipei slot=${slot} weekday=${weekday}`)

  const results = {}
  let scored = 0
  for (const stationId of routedStationIds) {
    const station = stationById.get(stationId)
    const liveStation = liveById.get(stationId)
    if (!station || !liveStation) continue

    const stationCode = stationCodeById.get(stationId)
    if (stationCode === undefined) continue

    const bikeRatio = liveStation.availableBikes / Math.max(1, liveStation.totalDocks)
    const dockRatio = liveStation.availableDocks / Math.max(1, liveStation.totalDocks)
    const neighbor = neighborLowRateByStation.get(stationId) ?? { rate: NaN, count: NaN }

    const horizons = {}
    for (const horizon of HORIZONS) {
      const model = models[horizon]
      const values = {
        total_docks: liveStation.totalDocks,
        available_bikes: liveStation.availableBikes,
        available_docks: liveStation.availableDocks,
        bike_ratio: bikeRatio,
        dock_ratio: dockRatio,
        // No cross-run snapshot history in this one-shot demo -- lag/momentum
        // are always missing. XGBoost's default_left routing handles this
        // natively; it just means lower-confidence scores than a warm cache.
        lag_30m_bikes: NaN, lag_30m_docks: NaN,
        lag_60m_bikes: NaN, lag_60m_docks: NaN,
        lag_120m_bikes: NaN, lag_120m_docks: NaN,
        lag_1d_bikes: NaN, lag_1d_docks: NaN,
        momentum_bikes_30m: NaN, momentum_docks_30m: NaN,
        neighbor_low_bikes_rate: neighbor.rate,
        neighbor_count: neighbor.count,
        station_id: stationCode,
        slot,
        weekday,
      }
      const featureRow = buildFeatureRow(model.featureNames, values)
      const riskScore = predictProbability(model.trees, featureRow)

      // The trained model predicts a single combined "empty or full" event
      // (no separate empty/full head); which direction is straining right
      // now is read off the live ratios, matching the rule baseline's own
      // empty_now/full_now classification.
      const isEmptyLeaning = bikeRatio <= dockRatio
      const safetyStockBikes = lowBikesThreshold(liveStation.totalDocks)
      const safetyStockDocks = lowBikesThreshold(liveStation.totalDocks)
      const gapBikes = isEmptyLeaning ? Math.max(0, Math.ceil(safetyStockBikes - liveStation.availableBikes)) : 0
      const gapDocks = !isEmptyLeaning ? Math.max(0, Math.ceil(safetyStockDocks - liveStation.availableDocks)) : 0

      horizons[horizon] = {
        riskScore: Number(riskScore.toFixed(4)),
        condition: isEmptyLeaning ? 'empty' : 'full',
        predictedBikes: liveStation.availableBikes,
        predictedDocks: liveStation.availableDocks,
        gapBikes,
        gapDocks,
      }
    }
    results[stationId] = { name: station.name, district: station.district, horizons }
    scored += 1
  }

  await mkdir(XGBOOST_DIR, { recursive: true })
  const tmpPath = `${OUTPUT_FILE}.tmp`
  await writeFile(tmpPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: {
      model: 'model_30.json / model_60.json, hand-rolled tree walker (validated in ml/src/validate_tree_walker.py)',
      routing: `baseline 60min F1 <= ${BASELINE_F1_XGBOOST_THRESHOLD * 100}% (app/data/station-risk-evaluation.json)`,
      caveat: 'One-shot demo run: no cross-run snapshot history, so lag/momentum features are always missing '
        + '(XGBoost routes via default_left, so this degrades confidence rather than breaking prediction).',
    },
    stations: results,
  }, null, 2))
  await rename(tmpPath, OUTPUT_FILE)
  console.log(`Wrote ${OUTPUT_FILE} (${scored} stations scored)`)
}

main().catch((error) => {
  console.error(`predict-xgboost failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
