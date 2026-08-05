import type { BriefingFact, DashboardArtifact } from '../shared/ops'

/**
 * The S3 key and small DynamoDB index item that identify one complete
 * dashboard artifact. Keep full time series in S3; DynamoDB has a 400 KB item
 * limit and should only hold materialized views or pointers.
 */
export interface DashboardManifest {
  artifactKey: string
  asOf: string
  generatedAt: string
  modelVersion: string
  expiresAt?: number
}

/** File-system, S3, or test-double boundary for generated JSON artifacts. */
export interface JsonObjectStore {
  readJson<T>(key: string): Promise<T | undefined>
  writeJson<T>(key: string, value: T): Promise<void>
}

/**
 * Local DuckDB/filesystem and AWS S3+DynamoDB implementations share this
 * interface. A request handler never needs to know where the artifact lives.
 */
export interface DashboardStore {
  getDashboard(asOf?: string): Promise<DashboardArtifact | undefined>
  putDashboard?(artifact: DashboardArtifact): Promise<DashboardManifest>
}

/** Small DynamoDB-only boundary; its implementation owns key and GSI design. */
export interface DashboardManifestIndex {
  getManifest(asOf?: string): Promise<DashboardManifest | undefined>
  putManifest(manifest: DashboardManifest): Promise<void>
}

export interface BriefingRequest {
  asOf: string
  facts: BriefingFact[]
}

export interface GeneratedBriefing {
  text: string
  modelId: string
  generatedAt: string
  requestId?: string
}

/** Template and Bedrock implementations share the same fact-grounded input. */
export interface NarrativeProvider {
  generate(request: BriefingRequest): Promise<GeneratedBriefing>
}

export interface OperationsDependencies {
  dashboardStore: DashboardStore
  narrativeProvider?: NarrativeProvider
  narrativeProviderName: 'template' | 'bedrock'
}
