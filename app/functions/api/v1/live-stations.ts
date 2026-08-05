const NTPC_LIVE_STATIONS_URL = 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

export const onRequestGet = async () => {
  try {
    const upstream = await fetch(NTPC_LIVE_STATIONS_URL, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
      cache: 'no-store',
    })

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: 'Unable to retrieve the New Taipei live station feed.' },
        { status: 502, headers: { 'cache-control': 'no-store, max-age=0' } },
      )
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
      },
    })
  } catch {
    return Response.json(
      { error: 'Unable to retrieve the New Taipei live station feed.' },
      { status: 502, headers: { 'cache-control': 'no-store, max-age=0' } },
    )
  }
}
