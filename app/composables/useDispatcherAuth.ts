import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts'

let manager: UserManager | undefined
const currentUser = shallowRef<User | null>(null)
const authError = ref('')

export function useDispatcherAuth() {
  const config = useRuntimeConfig().public
  const enabled = Boolean(config.cognitoAuthority && config.cognitoClientId && config.cognitoDomain)
  function client() {
    if (!import.meta.client || !enabled) throw new Error('此環境未啟用調度人員登入')
    if (!manager) {
      manager = new UserManager({
        authority: String(config.cognitoAuthority), client_id: String(config.cognitoClientId),
        redirect_uri: `${location.origin}/admin/callback`, post_logout_redirect_uri: `${location.origin}/`,
        response_type: 'code', scope: 'openid email', automaticSilentRenew: false,
        userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
        // Only the short-lived PKCE transaction survives the navigation; tokens stay in memory.
        stateStore: new WebStorageStateStore({ store: sessionStorage }),
      })
      manager.events.addAccessTokenExpired(() => { currentUser.value = null })
    }
    return manager
  }
  const accessToken = computed(() => currentUser.value && !currentUser.value.expired ? currentUser.value.access_token : '')
  async function signIn() {
    authError.value = ''
    const returnTo = ['/admin/events', '/dispatch'].includes(location.pathname) ? location.pathname : '/admin/adjustments'
    try { await client().signinRedirect({ state: { returnTo } }) }
    catch { authError.value = '無法開啟登入，請稍後重試。' }
  }
  async function completeSignIn() {
    const user = await client().signinRedirectCallback()
    currentUser.value = user
    history.replaceState(null, '', '/admin/callback')
    const returnTo = (user.state as { returnTo?: string } | undefined)?.returnTo
    return returnTo && ['/admin/events', '/dispatch'].includes(returnTo) ? returnTo : '/admin/adjustments'
  }
  async function signOut() {
    currentUser.value = null
    await client().removeUser()
    const url = new URL('/logout', String(config.cognitoDomain))
    url.searchParams.set('client_id', String(config.cognitoClientId))
    url.searchParams.set('logout_uri', `${location.origin}/`)
    location.assign(url.toString())
  }
  return { enabled, accessToken, authError, signIn, completeSignIn, signOut }
}
