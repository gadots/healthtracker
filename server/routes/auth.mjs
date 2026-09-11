import { randomToken } from '../config.mjs'
import { buildCookie, seal, unseal, OAUTH_COOKIE, SESSION_COOKIE } from '../session.mjs'
import { isSecureRequest, redirect, sendJson } from '../http.mjs'

const OAUTH_FLOW_TTL_SECONDS = 600
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

function expired(name, secure) {
  return buildCookie(name, '', { maxAge: 0, secure })
}

/**
 * The shape the renderer already expects (`FitbitAuthStatus`). `clientId` is
 * deliberately blank and no token is ever included — the browser never sees
 * either.
 */
export function publicStatus(config, session) {
  return {
    isElectron: false,
    configured: Boolean(config.oauth.clientId && config.oauth.clientSecret),
    connected: Boolean(session?.refresh_token),
    clientId: '',
    redirectUri: config.oauth.redirectUri,
    hasClientSecret: Boolean(config.oauth.clientSecret),
    // The session is sealed with AES-256-GCM; the desktop UI uses this flag to
    // confirm credentials are protected at rest.
    storageEncrypted: true,
    lastSyncAt: null,
    provider: 'google-health',
  }
}

export function registerAuthRoutes({ config, provider, cookies, session }) {
  return {
    'GET /api/status': (request, response) => {
      sendJson(response, 200, publicStatus(config, session(request)))
    },

    'GET /api/auth/start': (request, response) => {
      const secure = isSecureRequest(request, config.trustProxy)
      if (!config.oauth.clientId || !config.oauth.clientSecret) {
        redirect(response, '/?auth=error&message=' + encodeURIComponent('The server has no Google OAuth configuration.'))
        return
      }
      const state = randomToken()
      const pkce = provider.createPkce()
      // state + verifier ride along in a short-lived sealed cookie, so the
      // callback can validate the flow without any server-side storage.
      const flowCookie = buildCookie(
        OAUTH_COOKIE,
        seal(config.sessionKey, { state, verifier: pkce.verifier }),
        { maxAge: OAUTH_FLOW_TTL_SECONDS, secure },
      )
      redirect(response, provider.createAuthorizationUrl(config.oauth, state, pkce), { 'set-cookie': flowCookie })
    },

    'GET /api/auth/callback': async (request, response, url) => {
      const secure = isSecureRequest(request, config.trustProxy)
      const clearFlow = expired(OAUTH_COOKIE, secure)
      const fail = (message) =>
        redirect(response, `/?auth=error&message=${encodeURIComponent(message)}`, { 'set-cookie': clearFlow })

      const flow = unseal(config.sessionKey, cookies(request)[OAUTH_COOKIE])
      if (!flow?.state) return fail('The sign-in session expired. Try connecting again.')

      const returnedState = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const oauthError = url.searchParams.get('error')

      if (returnedState !== flow.state) return fail('The request security check is invalid.')
      if (oauthError || !code) {
        return fail(url.searchParams.get('error_description') || oauthError || 'Authorization canceled.')
      }

      try {
        const token = await provider.exchangeAuthorizationCode(config.oauth, code, flow.verifier)
        if (!token.refresh_token) {
          return fail('Google did not return a refresh token. Revoke the app’s access and connect again.')
        }
        // Only the refresh token is persisted: it keeps the cookie far below the
        // 4 KB limit, and a fresh access token is minted per sync.
        const sessionCookie = buildCookie(
          SESSION_COOKIE,
          seal(config.sessionKey, { refresh_token: token.refresh_token }),
          { maxAge: SESSION_TTL_SECONDS, secure },
        )
        redirect(response, '/?auth=ok', { 'set-cookie': [sessionCookie, clearFlow] })
      } catch (error) {
        return fail(error.message || 'The token exchange failed.')
      }
    },

    'POST /api/auth/disconnect': async (request, response) => {
      const secure = isSecureRequest(request, config.trustProxy)
      const current = session(request)
      if (current?.refresh_token) {
        // Best effort: a failed revoke must not block the local sign-out.
        try {
          await provider.revokeToken({ refresh_token: current.refresh_token })
        } catch { /* already revoked or unreachable */ }
      }
      sendJson(response, 200, publicStatus(config, null), { 'set-cookie': expired(SESSION_COOKIE, secure) })
    },
  }
}
