import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { gzipSync } from 'node:zlib'
import { mapLiveStation } from '../shared/live-feed.ts'
import { environmentValue } from './runtime-env.ts'

const BUCKET_MINUTES = 5
const RESET_GAP_MINUTES = 15          // 漏抓超過這個間隔，所有「起始時間」歸零，不冒充連續
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024
const DEFAULT_LIVE_FEED_URL =
  'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

import type { PersistenceState } from '../shared/station-persistence.ts'
export type { PersistenceState, StationPersistence } from '../shared/station-persistence.ts'

export interface CaptureDependencies {
  fetchImpl?: typeof fetch
  s3?: Pick<S3Client, 'send'>
  now?: () => Date
}

export function alignToBucket(date: Date): Date {
  const size = BUCKET_MINUTES * 60_000
  return new Date(Math.floor(date.getTime() / size) * size)
}

function minutesSince(iso: string, epoch: number): number {
  const since = Date.parse(iso)
  return Number.isFinite(since) ? Math.max(0, Math.round((epoch - since) / 60_000)) : 0
}

/** raw/ 依台北時間分日期夾，人看得懂；時間戳本身維持 UTC ISO。 */
export function rawKeyFor(observedAt: Date): string {
  const taipei = new Date(observedAt.getTime() + 8 * 60 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `raw/${taipei.getUTCFullYear()}/${pad(taipei.getUTCMonth() + 1)}/${pad(taipei.getUTCDate())}/`
    + `${pad(taipei.getUTCHours())}${pad(taipei.getUTCMinutes())}.json.gz`
}

/**
 * 純函數：拿上一份狀態 + 這一輪的站況，算出新狀態。
 * 狀態相同 → 沿用 stateSince；數值相同 → 沿用 unchangedSince；否則都重設為這一輪。
 * 上一份太舊（Lambda 曾經停掉）→ 全部重設，寧可少算也不冒充連續。
 */
export function mergePersistence(
  previous: PersistenceState | null,
  stations: ReturnType<typeof mapLiveStation>[],
  observedAt: Date,
): PersistenceState {
  const epoch = observedAt.getTime()
  const iso = observedAt.toISOString()
  const previousEpoch = Date.parse(previous?.updatedAt ?? '')
  const gapTooLong = !Number.isFinite(previousEpoch) || epoch < previousEpoch || epoch - previousEpoch > RESET_GAP_MINUTES * 60_000
  const next: PersistenceState = { schemaVersion: '1.0', updatedAt: iso, bucketMinutes: BUCKET_MINUTES, stations: {} }

  for (const station of stations) {
    if (!station) continue
    const prior = gapTooLong ? undefined : previous?.stations[station.id]
    const sameState = prior?.currentState === station.currentState
    const unchanged = Boolean(prior)
      && prior!.last[0] === station.availableBikes
      && prior!.last[1] === station.availableDocks
    const stateSince = sameState ? prior!.stateSince : iso
    const unchangedSince = unchanged ? prior!.unchangedSince : iso
    next.stations[station.id] = {
      currentState: station.currentState,
      stateSince,
      stateMinutes: minutesSince(stateSince, epoch),
      unchangedSince,
      unchangedMinutes: minutesSince(unchangedSince, epoch),
      last: [station.availableBikes, station.availableDocks],
    }
  }
  return next
}

async function readJson<T>(s3: Pick<S3Client, 'send'>, bucket: string, key: string): Promise<T | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await response.Body?.transformToString()
    return body ? JSON.parse(body) as T : null
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null
    throw error
  }
}

async function fetchFeed(fetchImpl: typeof fetch): Promise<unknown[]> {
  const url = environmentValue('LIVE_FEED_URL')?.trim() || DEFAULT_LIVE_FEED_URL
  const upstream = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'CtrlCity-YouBike-Capture/1.0' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!upstream.ok) throw new Error(`Live feed returned HTTP ${upstream.status}`)
  const bytes = new Uint8Array(await upstream.arrayBuffer())
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new Error('Live feed exceeded the safe response limit')
  const parsed = JSON.parse(new TextDecoder().decode(bytes))
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Live feed is not a non-empty array')
  return parsed
}

export function createCaptureHandler(dependencies: CaptureDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const s3 = dependencies.s3 ?? new S3Client({})
  const now = dependencies.now ?? (() => new Date())

  return async () => {
    const bucket = environmentValue('SITE_BUCKET')?.trim()
    if (!bucket) throw new Error('SITE_BUCKET is not configured')
    const historyBucket = environmentValue('HISTORY_BUCKET')?.trim()
    if (!historyBucket || historyBucket === bucket) throw new Error('HISTORY_BUCKET must be a separate private bucket')

    const observedAt = alignToBucket(now())
    const raw = await fetchFeed(fetchImpl)
    const stations = raw.map(mapLiveStation)
    if (!stations.some(Boolean)) throw new Error('No valid stations in live feed')
    const previous = await readJson<PersistenceState>(s3, bucket, 'state/persistence.json')
    if (previous && Date.parse(previous.updatedAt) >= observedAt.getTime()) return { ok: true, skipped: true }
    const next = mergePersistence(previous, stations, observedAt)
    const rawBody = JSON.stringify(raw)
    const shortLived = 'public, max-age=60, must-revalidate'

    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: historyBucket, Key: rawKeyFor(observedAt), Body: gzipSync(rawBody),
        ContentType: 'application/json', ContentEncoding: 'gzip', CacheControl: 'private, max-age=0',
      })),
      s3.send(new PutObjectCommand({
        Bucket: bucket, Key: 'snapshots/latest.json', Body: rawBody,
        ContentType: 'application/json; charset=utf-8', CacheControl: shortLived,
      })),
    ])
    // Commit the checkpoint last so retries repair partial raw/latest writes.
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: 'state/persistence.json', Body: JSON.stringify(next),
      ContentType: 'application/json; charset=utf-8', CacheControl: shortLived,
    }))

    return { ok: true, observedAt: next.updatedAt, stations: Object.keys(next.stations).length }
  }
}

export const captureHandler = createCaptureHandler()
