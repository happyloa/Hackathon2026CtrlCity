import { parseDemandEventsFile, type DemandEvent } from '~/shared/demand-events.mjs'

const STORAGE_KEY = 'demand-events:v1'

/**
 * Operator-declared demand events (a concert, a match, a festival) that the
 * dispatch pipeline turns into anticipated surges -- see
 * `shared/demand-surge-impact.ts`.
 *
 * Browser-local on every deployment. The cloud path this used to take required
 * a Cognito access token, and the deployed stack runs with dispatcher login
 * switched off, so `replace` threw on its first line and no event could ever be
 * created there -- the whole surge pipeline had an outlet and no inlet. A
 * prototype needs the feature demonstrable rather than shared across operators.
 */
export function useDemandEvents() {
  const browserStorage = useBrowserStorage({ authored: true })
  const events = useState<DemandEvent[]>('demand-events', () => [])
  onMounted(() => {
    try { events.value = parseDemandEventsFile(JSON.parse(browserStorage.getItem(STORAGE_KEY) || '{"events":[]}')) } catch { /* start empty */ }
  })
  function replace(raw: unknown) {
    events.value = parseDemandEventsFile(raw)
    try { browserStorage.setItem(STORAGE_KEY, JSON.stringify({ events: events.value })) } catch { /* session edits remain */ }
  }
  return { events, replace }
}
