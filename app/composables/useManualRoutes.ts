import { DEFAULT_DISPATCH_ROUTE_POLICY } from '~/shared/parameters.mjs'
import { taipeiTimeLabel, type ManualRoute, type ManualRouteStopInput } from '~/shared/manual-route-planner'

const STORAGE_KEY = 'manual-dispatch-routes:v1'
const STATE_KEY = 'manual-dispatch-routes-state:v1'

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}_${crypto.randomUUID()}`
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function isStopInput(value: unknown): value is ManualRouteStopInput {
  const candidate = value as Partial<ManualRouteStopInput> | null
  return typeof candidate?.id === 'string'
    && typeof candidate?.stationId === 'string'
    && typeof candidate?.pickupBikes === 'number'
    && typeof candidate?.dropoffBikes === 'number'
}

function isRoute(value: unknown): value is ManualRoute {
  const candidate = value as Partial<ManualRoute> | null
  return typeof candidate?.id === 'string'
    && typeof candidate?.label === 'string'
    && typeof candidate?.vehicleCapacity === 'number'
    && typeof candidate?.scheduledAt === 'string'
    && Array.isArray(candidate?.stops)
    && candidate.stops.every(isStopInput)
    && typeof candidate?.createdAt === 'string'
    && typeof candidate?.updatedAt === 'string'
}

export interface CreateManualRouteOptions {
  label?: string
  vehicleCapacity?: number
  /** "HH:mm" in Asia/Taipei; defaults to right now. */
  scheduledAt?: string
  /** Seeds the route with these stops in one shot -- e.g. when forking an auto-generated route into an editable copy. */
  stops?: readonly Pick<ManualRouteStopInput, 'stationId' | 'pickupBikes' | 'dropoffBikes'>[]
}

/**
 * User-authored dispatch routes: independent of `buildDispatchRoutePlans`'s
 * auto-generated output (see `manual-route-planner.ts`), so a live data
 * refresh never rewrites or discards one -- an operator's own routing stays
 * exactly as they left it until they edit or delete it themselves.
 *
 * Always browser-local, on every deployment. These routes exist to be built in
 * a few seconds and handed to Google Maps for navigation, so gating them behind
 * a cloud sign-in and an explicit "save to cloud" step made the quick path
 * impossible on AWS while the identical feature stayed one click away locally.
 * They are one operator's working notes, not shared operational state -- the
 * documents that *are* shared (`useOperationalAdjustments`, `useDemandEvents`)
 * keep the authenticated S3 path.
 */
export function useManualRoutes() {
  const browserStorage = useBrowserStorage({ authored: true })
  const routes = useState<ManualRoute[]>(STATE_KEY, () => [])
  const loaded = useState<boolean>(`${STATE_KEY}:loaded`, () => false)
  // Shared across every useManualRoutes() caller, so the route comparison
  // view (DispatchWorkspace.vue) can jump the editor (ManualRouteEditor.vue)
  // straight to a specific route -- e.g. after forking an auto-generated one.
  const activeRouteId = useState<string>(`${STATE_KEY}:active`, () => '')
  const editorExpanded = useState<boolean>(`${STATE_KEY}:expanded`, () => false)

  function focusRoute(routeId: string) {
    activeRouteId.value = routeId
    editorExpanded.value = true
  }

  function persist() {
    if (!import.meta.client) return
    try {
      browserStorage.setItem(STORAGE_KEY, JSON.stringify(routes.value))
    } catch {
      // A full or blocked storage quota must not take the page down; edits
      // still work for the rest of this session, just won't survive a reload.
    }
  }

  function load() {
    if (!import.meta.client || loaded.value) return
    loaded.value = true
    try {
      const raw = browserStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isRoute)) routes.value = parsed
    } catch {
      // Corrupt storage starts fresh rather than taking the page down.
    }
  }

  onMounted(load)

  function touch(route: ManualRoute): ManualRoute {
    return { ...route, updatedAt: new Date().toISOString() }
  }

  function createRoute(options: CreateManualRouteOptions = {}): ManualRoute {
    const now = new Date().toISOString()
    const route: ManualRoute = {
      id: createId('manual-route'),
      label: options.label?.trim() || `手動路線 ${routes.value.length + 1}`,
      vehicleCapacity: Math.max(1, Math.round(options.vehicleCapacity ?? DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity) || 1),
      scheduledAt: options.scheduledAt || taipeiTimeLabel(Date.now()),
      stops: (options.stops ?? []).map(stop => ({ id: createId('stop'), ...stop })),
      createdAt: now,
      updatedAt: now,
    }
    routes.value = [...routes.value, route]
    persist()
    return route
  }

  function removeRoute(routeId: string) {
    routes.value = routes.value.filter(route => route.id !== routeId)
    persist()
  }

  function renameRoute(routeId: string, label: string) {
    const trimmed = label.trim()
    if (!trimmed) return
    routes.value = routes.value.map(route => (route.id === routeId ? touch({ ...route, label: trimmed }) : route))
    persist()
  }

  function setVehicleCapacity(routeId: string, vehicleCapacity: number) {
    const capacity = Math.max(1, Math.round(vehicleCapacity) || 1)
    routes.value = routes.value.map(route => (route.id === routeId ? touch({ ...route, vehicleCapacity: capacity }) : route))
    persist()
  }

  function setScheduledAt(routeId: string, scheduledAt: string) {
    if (!/^\d{2}:\d{2}$/.test(scheduledAt)) return
    routes.value = routes.value.map(route => (route.id === routeId ? touch({ ...route, scheduledAt }) : route))
    persist()
  }

  function addStop(routeId: string, stationId: string) {
    routes.value = routes.value.map((route) => {
      if (route.id !== routeId) return route
      const stop: ManualRouteStopInput = { id: createId('stop'), stationId, pickupBikes: 0, dropoffBikes: 0 }
      return touch({ ...route, stops: [...route.stops, stop] })
    })
    persist()
  }

  function removeStop(routeId: string, stopId: string) {
    routes.value = routes.value.map(route => (route.id === routeId
      ? touch({ ...route, stops: route.stops.filter(stop => stop.id !== stopId) })
      : route))
    persist()
  }

  function updateStop(routeId: string, stopId: string, patch: Partial<Pick<ManualRouteStopInput, 'pickupBikes' | 'dropoffBikes'>>) {
    routes.value = routes.value.map((route) => {
      if (route.id !== routeId) return route
      return touch({
        ...route,
        stops: route.stops.map(stop => (stop.id === stopId
          ? {
              ...stop,
              pickupBikes: Math.max(0, Math.round(patch.pickupBikes ?? stop.pickupBikes) || 0),
              dropoffBikes: Math.max(0, Math.round(patch.dropoffBikes ?? stop.dropoffBikes) || 0),
            }
          : stop)),
      })
    })
    persist()
  }

  function moveStop(routeId: string, stopId: string, direction: -1 | 1) {
    routes.value = routes.value.map((route) => {
      if (route.id !== routeId) return route
      const index = route.stops.findIndex(stop => stop.id === stopId)
      const targetIndex = index + direction
      if (index === -1 || targetIndex < 0 || targetIndex >= route.stops.length) return route
      const stops = [...route.stops]
      const [moved] = stops.splice(index, 1)
      stops.splice(targetIndex, 0, moved!)
      return touch({ ...route, stops })
    })
    persist()
  }

  return {
    routes,
    activeRouteId,
    editorExpanded,
    focusRoute,
    createRoute,
    removeRoute,
    renameRoute,
    setVehicleCapacity,
    setScheduledAt,
    addStop,
    removeStop,
    updateStop,
    moveStop,
  }
}
