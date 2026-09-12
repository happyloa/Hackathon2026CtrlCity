// Read-only live AWS verification. Run with Playwright CLI run-code --filename.
async (page) => {
  const origin = 'https://d1j270xi5vh8gd.cloudfront.net'
  const errors = []
  const responses = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.url().startsWith(origin)) responses.push({ url: response.url(), status: response.status() })
  })
  await page.context().addInitScript(() => {
    window.__localStorageAttempts = 0
    Object.defineProperty(window, 'localStorage', { configurable: true, get() {
      window.__localStorageAttempts++
      throw new Error('AWS build accessed localStorage')
    } })
  })
  const pages = [
    ['/', '/state/persistence.json'],
    ['/admin/adjustments', '/api/v1/adjustments'],
    ['/admin/events', '/api/v1/events'],
    ['/dispatch', '/api/v1/manual-routes'],
  ]
  for (const [path, endpoint] of pages) {
    const responsePromise = page.waitForResponse(response => response.url().includes(endpoint), { timeout: 60000 })
    await page.goto(origin + path, { waitUntil: 'domcontentloaded' })
    const response = await responsePromise
    if (response.status() !== 200) throw new Error(`${endpoint}: ${response.status()}`)
    await response.json()
    if (endpoint.startsWith('/api/')) {
      await page.waitForFunction(() => document.body.textContent.includes('已載入雲端資料'))
    }
    if (await page.evaluate(() => window.__localStorageAttempts)) throw new Error(`${path} accessed localStorage`)
  }
  if (errors.length) throw new Error(JSON.stringify(errors))
  console.log(JSON.stringify({ pages: pages.map(([path]) => path), localStorageAttempts: 0, errors, cloudReads: responses.filter(item => /snapshots|persistence|api\/v1\/(adjustments|events|manual-routes)/.test(item.url)) }))
}
