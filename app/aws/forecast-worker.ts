/**
 * Lambda-compatible scheduled-worker seam. The SAM template leaves its
 * scheduler disabled by default: enabling it before an S3/DynamoDB adapter is
 * implemented would create empty or misleading operational data.
 */
export interface ForecastWorkerEvent {
  source?: string
  mode?: 'incremental' | 'backfill'
}

export interface ForecastWorkerResult {
  processedAt: string
  source: string
  mode: string
}

export function createForecastWorker(
  run: (event: ForecastWorkerEvent) => Promise<ForecastWorkerResult>,
) {
  return (event: ForecastWorkerEvent) => run(event)
}

export async function lambdaHandler(event: ForecastWorkerEvent): Promise<ForecastWorkerResult> {
  throw new Error(
    `Forecast worker scaffold is not wired. Received ${event.source ?? 'manual'} / ${event.mode ?? 'incremental'}. ` +
      'Implement the pipeline adapter and set EnableForecastSchedule=true only after an end-to-end test.',
  )
}
