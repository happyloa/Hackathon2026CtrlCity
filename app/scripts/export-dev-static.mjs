// `nuxt dev` serves app/public/ directly, but the replay dashboard
// (/data/replay/manifest.json) and the station popularity chart
// (/data/live-profile/manifest.json) are normally only written by
// stage-pages-static.mjs into app/dist/ during a full `npm run build`. That
// leaves both features broken under `npm run dev`: the fetch 404s and the UI
// falls back to its error/empty state.
//
// Run manually (`npm run data:live-static`) after data/dashboard.json changes
// — not wired into predev, matching how data:profile and data:frozen are also
// run on demand rather than automatically.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { exportReplayStatic } from './export-replay-static.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = resolve(APP_DIR, 'public')

const result = await exportReplayStatic(PUBLIC_DIR)
console.log(`Wrote ${result.scenarios} replay scenario(s) and live profiles for ${result.liveProfiles.stations} station(s) to ${PUBLIC_DIR}/data`)
