// Historical rebuilds do not train or replace separately uploaded XGBoost models.
export const protectedPublishPaths = ['_headers', '_routes.json', '_nuxt/*', 'raw/*', 'snapshots/*', 'state/*', 'data/xgboost/model-*.json', 'data/operational-adjustments.json', 'data/demand-events.json', 'data/manual-routes.json']

export function frontendEnvironment(outputs) {
  const capture = outputs.SnapshotCaptureEnabled === 'true'
  const login = outputs.DispatcherLoginEnabled === 'true'
  if (login && (!outputs.CognitoAuthority || !outputs.UserPoolClientId || !outputs.UserPoolDomain)) throw new Error('Cognito stack outputs are incomplete.')
  return {
    NUXT_PUBLIC_STORAGE_MODE: 'aws',
    NUXT_PUBLIC_MANUAL_ROUTES_ENDPOINT: '/api/v1/manual-routes',
    NUXT_PUBLIC_LIVE_STATIONS_ENDPOINT: '/api/v1/live-stations',
    NUXT_PUBLIC_LIVE_SNAPSHOT_PATH: capture ? '/snapshots/latest.json' : '',
    NUXT_PUBLIC_PERSISTENCE_PATH: capture ? '/state/persistence.json' : '',
    NUXT_PUBLIC_ADJUSTMENTS_ENDPOINT: '/api/v1/adjustments',
    NUXT_PUBLIC_EVENTS_ENDPOINT: '/api/v1/events',
    NUXT_PUBLIC_COGNITO_AUTHORITY: login ? outputs.CognitoAuthority : '',
    NUXT_PUBLIC_COGNITO_CLIENT_ID: login ? outputs.UserPoolClientId : '',
    NUXT_PUBLIC_COGNITO_DOMAIN: login ? outputs.UserPoolDomain : '',
    NUXT_PUBLIC_AGENT_ENABLED: String(outputs.AgentReviewEnabled === 'true'),
    NUXT_PUBLIC_AGENT_REVIEW_ENDPOINT: '/api/v1/agent-review',
  }
}
