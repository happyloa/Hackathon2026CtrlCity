import type { DashboardArtifact } from '../shared/ops'
import type {
  DashboardManifest,
  DashboardManifestIndex,
  DashboardStore,
  JsonObjectStore,
} from './contracts'

/**
 * This composition is deliberately SDK-neutral. In production, implement the
 * two narrow operation interfaces with AWS SDK v3; locally, use file-system
 * implementations. It keeps AWS packages and credentials out of the browser
 * bundle and lets unit tests inject in-memory stores.
 */
export class S3DynamoDashboardStore implements DashboardStore {
  constructor(
    private readonly objects: JsonObjectStore,
    private readonly manifests: DashboardManifestIndex,
    private readonly prefix: string,
  ) {}

  async getDashboard(asOf?: string): Promise<DashboardArtifact | undefined> {
    const manifest = await this.manifests.getManifest(asOf)
    if (!manifest) return undefined

    return this.objects.readJson<DashboardArtifact>(manifest.artifactKey)
  }

  async putDashboard(artifact: DashboardArtifact): Promise<DashboardManifest> {
    const key = `${this.prefix}/dashboard/${artifact.meta.asOf}.json`
    const manifest: DashboardManifest = {
      artifactKey: key,
      asOf: artifact.meta.asOf,
      generatedAt: artifact.meta.generatedAt,
      modelVersion: artifact.meta.modelVersion,
    }

    await this.objects.writeJson(key, artifact)
    await this.manifests.putManifest(manifest)
    return manifest
  }
}

/**
 * Suggested DynamoDB records, produced by an AWS SDK v3 adapter:
 *
 *   latest manifest:  pk=MANIFEST, sk=LATEST
 *   named snapshot:   pk=MANIFEST, sk=SNAPSHOT#<asOf>
 *   station map item: pk=SNAPSHOT#<asOf>, sk=STATION#<stationId>
 *   station history:  gsi1pk=STATION#<stationId>, gsi1sk=<observedAt>
 *   dispatch item:    pk=DISPATCH#<asOf>, sk=RANK#<padded-rank>
 *
 * Only a manifest belongs in this store. Long station histories and complete
 * DashboardArtifact JSON stay in S3 (or local files) to avoid DynamoDB item
 * size and scan costs.
 */
export const dynamoRecordGuide = Object.freeze({
  latestManifest: { pk: 'MANIFEST', sk: 'LATEST' },
  snapshotManifest: (asOf: string) => ({ pk: 'MANIFEST', sk: `SNAPSHOT#${asOf}` }),
  stationSnapshot: (asOf: string, stationId: string) => ({
    pk: `SNAPSHOT#${asOf}`,
    sk: `STATION#${stationId}`,
  }),
  stationHistory: (stationId: string, observedAt: string) => ({
    gsi1pk: `STATION#${stationId}`,
    gsi1sk: observedAt,
  }),
  dispatch: (asOf: string, rank: number) => ({
    pk: `DISPATCH#${asOf}`,
    sk: `RANK#${String(rank).padStart(4, '0')}`,
  }),
})
