import { defineEventHandler, setResponseHeader, setResponseStatus } from 'h3'

const NTPC_LIVE_STATIONS_URL = 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

/**
 * Keep Nuxt development behaviour aligned with the Pages Function.  The client
 * owns filtering and normalisation, so this route only forwards the official
 * raw feed and never loads the replay artifact.
 */
export default defineEventHandler(async (event) => {
  try {
    const upstream = await fetch(NTPC_LIVE_STATIONS_URL, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
      cache: 'no-store',
    })

    if (!upstream.ok || !upstream.body) {
      setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
      setResponseStatus(event, 502)
      return { error: 'Unable to retrieve the New Taipei live station feed.' }
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
      },
    })
  } catch {
    setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
    setResponseStatus(event, 502)
    return { error: 'Unable to retrieve the New Taipei live station feed.' }
  }
})
