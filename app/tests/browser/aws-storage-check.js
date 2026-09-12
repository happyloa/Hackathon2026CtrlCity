// Run against an AWS-configured local static build using Playwright CLI run-code --filename.
// All AWS/OIDC/feed requests are intercepted; this never writes to an AWS account.
async (page) => {
  const origin = 'http://127.0.0.1:4174'
  const authority = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_localtest'
  const authDomain = 'https://ctrlcity-validation.auth.us-west-2.amazoncognito.com'
  const clientId = 'ctrlcity-local-test'
  const parameters = text => new Map((text || '').split('&').filter(Boolean).map(pair => {
    const [key, ...value] = pair.split('=')
    return [decodeURIComponent(key), decodeURIComponent(value.join('=').replaceAll('+', ' '))]
  }))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.context().addInitScript(() => {
    window.__localStorageAttempts = 0
    Object.defineProperty(window, 'localStorage', { configurable: true, get() {
      window.__localStorageAttempts++
      throw new Error('AWS build attempted localStorage access')
    } })
  })
  const requests = { snapshots: 0, persistence: 0, proxy: 0, puts: 0, token: 0 }
  let stale = false
  let conflictNext = false
  let nonce
  const documents = {
    adjustments: { etag: 1, value: { adjustments: [{ id: 'test-window', stationId: 'st_875660363c36ba', stationName: '新五路二段299號', district: '五股區', reason: '雲端測試資料', startAt: '2026-09-12T08:00', endAt: null, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }] } },
    events: { etag: 1, value: { events: [] } },
    'manual-routes': { etag: 1, value: { routes: [] } },
  }
  function feed() {
    const date = new Date(Date.now() + 8 * 3600000)
    const mday = date.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')
    return [
      { sno: '500201001', sna: 'YouBike2.0_下庄市場', sarea: '八里區', tot_quantity: '20', sbi_quantity: '0', bemp: '20', act: '1', lat: '25.1', lng: '121.4', mday },
      { sno: '500201002', sna: 'YouBike2.0_測試來源', sarea: '八里區', tot_quantity: '30', sbi_quantity: '25', bemp: '5', act: '1', lat: '25.101', lng: '121.401', mday },
    ]
  }
  const json = (route, value, options = {}) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value), ...options })
  await page.context().unroute('**/*')
  await page.context().route('**/*', async route => {
    const request = route.request()
    const parts = request.url().match(/^(https?:\/\/[^/]+)(\/[^?]*)?(?:\?(.*))?$/)
    const url = { origin: parts[1], pathname: parts[2] || '/', searchParams: parameters(parts[3]) }
    if (url.origin === 'https://cognito-idp.us-west-2.amazonaws.com' && url.pathname.endsWith('/.well-known/openid-configuration')) {
      return json(route, { issuer: authority, authorization_endpoint: `${authDomain}/oauth2/authorize`, token_endpoint: `${authDomain}/oauth2/token`, userinfo_endpoint: `${authDomain}/oauth2/userInfo`, jwks_uri: `${authDomain}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] })
    }
    if (url.origin === authDomain) {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
      if (url.pathname === '/oauth2/authorize') {
        assert(url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.get('code_challenge'), 'PKCE challenge missing')
        nonce = url.searchParams.get('nonce')
        return route.fulfill({ status: 302, headers: { location: `${origin}/admin/callback?code=local-test-code&state=${url.searchParams.get('state')}` } })
      }
      if (url.pathname === '/oauth2/token') {
        requests.token++
        const data = parameters(request.postData())
        assert(data.get('code_verifier')?.length >= 43, 'PKCE verifier missing')
        const base64 = obj => {
          const input = JSON.stringify(obj)
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
          let result = '', buffer = 0, bits = 0
          for (let i = 0; i < input.length; i++) {
            buffer = (buffer << 8) | input.charCodeAt(i); bits += 8
            while (bits >= 6) { bits -= 6; result += alphabet[(buffer >> bits) & 63] }
          }
          if (bits) result += alphabet[(buffer << (6 - bits)) & 63]
          return result
        }
        const now = Math.floor(Date.now() / 1000)
        const claims = { iss: authority, sub: 'test-dispatcher', aud: clientId, iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) }
        const idToken = `${base64({ alg: 'RS256', typ: 'JWT' })}.${base64(claims)}.local-test-signature`
        return json(route, { id_token: idToken, access_token: 'local-test-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'openid email' }, { headers: { 'access-control-allow-origin': origin } })
      }
      if (url.pathname === '/oauth2/userInfo') return json(route, { sub: 'test-dispatcher', email: 'test@example.test' }, { headers: { 'access-control-allow-origin': origin } })
      throw new Error(`Unexpected mocked auth request: ${url.pathname}`)
    }
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/snapshots/latest.json') {
      requests.snapshots++
      return json(route, feed(), { headers: { 'last-modified': new Date(Date.now() - (stale ? 20 * 60000 : 0)).toUTCString() } })
    }
    if (url.pathname === '/state/persistence.json') {
      requests.persistence++
      const now = Date.now()
      return json(route, { schemaVersion: '1.0', updatedAt: new Date(now - (stale ? 20 * 60000 : 0)).toISOString(), bucketMinutes: 5, stations: { '500201001': { currentState: 'empty_now', stateSince: new Date(now - 65 * 60000).toISOString(), stateMinutes: 65, unchangedSince: new Date(now - 185 * 60000).toISOString(), unchangedMinutes: 185, last: [0, 20] } } })
    }
    if (url.pathname === '/api/v1/live-stations') { requests.proxy++; return json(route, feed()) }
    const resource = url.pathname.replace('/api/v1/', '')
    const document = documents[resource]
    if (document) {
      if (request.method() === 'GET') return json(route, document.value, { headers: { etag: `"${document.etag}"` } })
      assert(request.method() === 'PUT', 'Unexpected operator method')
      assert(request.headers().authorization === 'Bearer local-test-access-token', 'Missing bearer token')
      requests.puts++
      if (conflictNext) { conflictNext = false; document.etag++; return json(route, { error: { code: 'OPERATOR_FILE_CHANGED' } }, { status: 412 }) }
      assert(request.headers()['if-match'] === `"${document.etag}"`, 'ETag not forwarded')
      document.value = JSON.parse(request.postData())
      document.etag++
      return json(route, { saved: 1, etag: `"${document.etag}"` })
    }
    return route.continue()
  })
  const noStorage = async label => assert(await page.evaluate(() => window.__localStorageAttempts) === 0, `${label}: localStorage was accessed`)
  await page.goto(`${origin}/admin/adjustments`)
  await page.getByRole('status').filter({ hasText: '已載入雲端資料' }).waitFor()
  assert(await page.getByRole('button', { name: '新增', exact: true }).isDisabled(), 'Anonymous editing enabled')
  await noStorage('anonymous adjustments')
  await page.getByRole('button', { name: '切換為淺色主題' }).click()
  await page.getByRole('button', { name: '收合側欄' }).click()
  await noStorage('appearance preferences')
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await page.getByRole('button', { name: '登出', exact: true }).waitFor()
  assert(requests.token === 1, 'PKCE callback did not exchange code')
  await page.getByRole('button', { name: '編輯', exact: true }).first().click()
  await page.getByRole('textbox', { name: '原因（選填）' }).fill('由 Lambda 儲存的測試變更')
  await page.getByRole('button', { name: '儲存變更', exact: true }).click()
  await page.getByRole('button', { name: '儲存到雲端', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已儲存到雲端' }).waitFor()
  assert(documents.adjustments.value.adjustments[0].reason === '由 Lambda 儲存的測試變更', 'Adjustment not saved through API')
  await noStorage('signed-in edit and save')

  await page.getByRole('link', { name: '活動管理', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已載入雲端資料' }).waitFor()
  await page.getByRole('textbox', { name: '活動名稱', exact: true }).fill('雲端活動')
  await page.getByRole('textbox', { name: '影響站點 ID（以逗號分隔）' }).fill('500201001')
  await page.getByLabel('開始時間', { exact: true }).fill('2026-09-12T15:00')
  await page.getByLabel('結束時間', { exact: true }).fill('2026-09-12T18:00')
  await page.getByRole('button', { name: '新增活動', exact: true }).click()
  await page.getByRole('button', { name: '儲存到雲端', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已儲存到雲端' }).waitFor()
  assert(documents.events.value.events.length === 1, 'Event not saved')
  conflictNext = true
  await page.getByRole('button', { name: '刪除', exact: true }).click()
  await page.getByRole('button', { name: '儲存到雲端', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '有人先存了' }).waitFor()
  assert(await page.getByRole('button', { name: '儲存到雲端', exact: true }).isDisabled(), 'Conflict permits silent retry')
  await page.getByRole('button', { name: '重新載入雲端清單', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已載入雲端資料' }).waitFor()
  await noStorage('events and conflict')

  await page.getByRole('link', { name: '調度規劃', exact: true }).click()
  const editor = page.locator('#manual-route-editor')
  await editor.getByRole('status').filter({ hasText: '已載入雲端資料' }).waitFor()
  await editor.locator('.manual-trigger').click()
  await editor.getByRole('button', { name: '新增路線', exact: true }).click()
  await editor.getByRole('textbox', { name: '路線名稱' }).fill('雲端手動路線')
  await editor.getByRole('textbox', { name: '路線名稱' }).press('Tab')
  await editor.getByRole('button', { name: '儲存到雲端', exact: true }).click()
  await editor.getByRole('status').filter({ hasText: '已儲存到雲端' }).waitFor()
  assert(documents['manual-routes'].value.routes[0].label === '雲端手動路線', 'Manual route not saved')
  await noStorage('manual routes')
  await page.goto(`${origin}/admin/roi`)
  await page.getByRole('heading', { level: 1 }).waitFor()
  await noStorage('prediction mode page')
  const second = await page.context().newPage()
  await second.goto(`${origin}/admin/adjustments`)
  await second.getByRole('status').filter({ hasText: '已載入雲端資料' }).waitFor()
  assert(await second.getByText('由 Lambda 儲存的測試變更', { exact: true }).count() > 0, 'Second tab cannot read cloud change')
  assert(await second.getByRole('button', { name: '新增', exact: true }).isDisabled(), 'Token persisted across tabs')
  assert(await second.evaluate(() => window.__localStorageAttempts) === 0, 'Second tab touched localStorage')
  await second.close()
  assert(requests.snapshots > 0 && requests.persistence > 0 && requests.proxy === 0, 'Healthy snapshots unexpectedly used proxy')
  stale = true
  await page.goto(`${origin}/`)
  await page.waitForResponse(response => response.url().endsWith('/api/v1/live-stations'))
  assert(requests.proxy > 0, 'Stale snapshot did not fall back to proxy')
  await noStorage('stale fallback')
  assert(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`)
  await page.screenshot({ path: 'output/playwright/aws-storage-check.png', fullPage: false })
  console.log(JSON.stringify({ passed: true, localStorageAccesses: 0, requests, checks: ['anonymous readonly', 'PKCE callback', 'adjustment save', 'event save', '412 conflict', 'manual route save', 'second-tab read', 'token isolation', 'snapshot fallback'] }))
}
