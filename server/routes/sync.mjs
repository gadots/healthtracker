import { buildCookie, seal, SESSION_COOKIE } from '../session.mjs'
import { isSecureRequest, localIsoDate, readJsonBody, sendJson, validSyncDate } from '../http.mjs'
import { assertUsefulPayload } from '../health-sync.mjs'

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

export function registerSyncRoutes({ config, provider, session }) {
  return {
    'POST /api/sync': async (request, response) => {
      const current = session(request)
      if (!current?.refresh_token) {
        sendJson(response, 401, { message: 'Not connected. Sign in with Google Health first.' })
        return
      }

      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { message: error.message })
        return
      }

      if (!validSyncDate(body.date, localIsoDate())) {
        sendJson(response, 400, { message: 'Provide a valid date (YYYY-MM-DD) that is not in the future.' })
        return
      }

      let token
      try {
        // Mint a short-lived access token per request; it is never stored and
        // never leaves this process.
        token = await provider.refreshAccessToken(config.oauth, { refresh_token: current.refresh_token })
      } catch (error) {
        sendJson(response, 401, { message: error.message || 'The Google authorization expired. Connect again.' })
        return
      }

      const headers = {}
      if (token.refresh_token && token.refresh_token !== current.refresh_token) {
        // Google rotated the refresh token — persist the new one or the next
        // sync fails.
        headers['set-cookie'] = buildCookie(
          SESSION_COOKIE,
          seal(config.sessionKey, { refresh_token: token.refresh_token }),
          { maxAge: SESSION_TTL_SECONDS, secure: isSecureRequest(request, config.trustProxy) },
        )
      }

      try {
        const payload = await provider.syncData(token.access_token, body.date, () => {})
        assertUsefulPayload(payload)
        sendJson(response, 200, payload, headers)
      } catch (error) {
        sendJson(response, 502, { message: error.message || 'The sync failed.' }, headers)
      }
    },
  }
}
