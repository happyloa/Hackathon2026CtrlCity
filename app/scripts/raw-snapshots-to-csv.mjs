import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { gunzipSync } from 'node:zlib'
import { open, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { mapLiveStation } from '../shared/live-feed.ts'

export const csvHeaders = ['日期', '城市', '行政區', '場站名稱', '總車柱數', '可借車數', '可還位數', '經度', '緯度']
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
export function snapshotCsvRows(raw) {
  if (!Array.isArray(raw)) throw new Error('Raw snapshot must be an array')
  return raw.flatMap(value => {
    const station = mapLiveStation(value)
    const time = String(value?.mday || '')
    if (!station || !/^\d{8}T\d{6}$/.test(time)) return []
    const date = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}`
    // Organizer CSVs identify stations without the live-feed branding prefix.
    const name = station.name.replace(/^YouBike\s*2(?:\.0)?[_\s-]*/i, '').replace(/^YouBike[_\s-]*/i, '')
    return [[date, value.scity || '新北市', station.district, name, station.totalDocks, station.availableBikes, station.availableDocks, station.longitude, station.latitude]]
  })
}
export async function convertSnapshots({ bucket, out, s3 = new S3Client({}) }) {
  if (!bucket || !out) throw new Error('--bucket and --out are required')
  const temp = `${resolve(out)}.${process.pid}.tmp`
  const file = await open(temp, 'w')
  let count = 0
  try {
    await file.write(`${csvHeaders.map(quote).join(',')}\n`)
    let token
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'raw/', ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        if (!/^raw\/\d{4}\/\d{2}\/\d{2}\/\d{2}(00|30)\.json\.gz$/.test(object.Key)) continue
        const data = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }))
        const raw = JSON.parse(gunzipSync(await data.Body.transformToByteArray()).toString('utf8'))
        for (const row of snapshotCsvRows(raw)) { await file.write(`${row.map(quote).join(',')}\n`); count++ }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
      if (page.IsTruncated && !token) throw new Error('Missing S3 continuation token')
    } while (token)
    await file.close()
    if (!count) throw new Error('No half-hour snapshot rows available; wait for captures before rebuilding.')
    await rename(temp, resolve(out))
    return count
  } catch (error) { await file.close().catch(() => {}); await rm(temp, { force: true }); throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { bucket: { type: 'string' }, out: { type: 'string' } } })
  console.log(`Converted ${await convertSnapshots(values)} observations.`)
}
