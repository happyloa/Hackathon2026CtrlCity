/** ETag and failure behavior shared by every operator document. */
export class OperatorDocumentClient<T> {
  etag = ''
  loaded = false
  conflicted = false
  readonly endpoint: string
  readonly parse: (raw: unknown) => T
  readonly fetchImpl: typeof fetch
  constructor(endpoint: string, parse: (raw: unknown) => T, fetchImpl: typeof fetch = fetch) {
    this.endpoint = endpoint
    this.parse = parse
    // Native browser fetch must not receive this document client as its receiver.
    this.fetchImpl = fetchImpl.bind(globalThis)
  }
  async load(): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('無法讀取雲端資料，請重新載入。')
    const value = this.parse(await response.json())
    this.etag = response.headers.get('etag') || ''
    this.loaded = true
    this.conflicted = false
    return value
  }
  async save(payload: unknown, token: string) {
    if (!token) throw new Error('登入後可編輯')
    if (!this.loaded) throw new Error('請先成功載入雲端資料。')
    if (this.conflicted) throw new Error('有人先存了，請重新載入後再修改。')
    const response = await this.fetchImpl(this.endpoint, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(this.etag ? { 'if-match': this.etag } : {}) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    })
    if (response.status === 412) { this.conflicted = true; throw new Error('有人先存了，請重新載入後再修改。') }
    if (response.status === 401 || response.status === 403) throw new Error('登入已過期或沒有寫入權限，請重新登入。')
    if (!response.ok) throw new Error('雲端儲存失敗，草稿仍保留；請重試。')
    const result = await response.json()
    this.etag = response.headers.get('etag') || result.etag || ''
    if (!this.etag) { this.loaded = false; throw new Error('儲存回應缺少版本，請重新載入確認。') }
  }
}
