import type {
  FitbitAuthStatus,
  FitbitBridge,
  RawFitbitPayload,
  RawHealthArchive,
} from '@/types'
import {
  clearArchive,
  latestDay,
  readArchive,
  readLastSyncAt,
  rememberDay,
} from './web-archive'

/**
 * `FitbitBridge` implemented over `fetch` against the stateless BFF in `server/`.
 *
 * The desktop bridge is backed by the Electron main process; this one is backed
 * by HTTP. Neither an access token nor the OAuth client secret ever reaches this
 * code — the server holds the session in an encrypted httpOnly cookie.
 */

/**
 * The OAuth callback redirects back to `/?auth=ok` (or `?auth=error&message=…`).
 * Read it once at module load and scrub the URL, so a refresh does not replay
 * the result, then hand it to the first `onAuthComplete` subscriber.
 */
const pendingAuthResult = (() => {
  const params = new URLSearchParams(window.location.search)
  const auth = params.get('auth')
  if (!auth) return null
  const message = params.get('message')
  params.delete('auth')
  params.delete('message')
  const query = params.toString()
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  return auth === 'ok'
    ? { ok: true as const }
    : { ok: false as const, error: message ?? 'Authorization failed.' }
})()

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...init,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    // The access gate expired mid-session: send the browser to the unlock page
    // rather than surfacing an opaque error behind a dashboard it cannot refresh.
    if (response.status === 401 && (payload as { locked?: boolean }).locked) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`)
      throw new Error('Session locked. Redirecting to the unlock page…')
    }
    throw new Error((payload as { message?: string }).message || `The server responded ${response.status}.`)
  }
  return payload as T
}

/** Ends the browser session: clears the gate and the Google session together. */
export function lockSession() {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/logout'
  document.body.append(form)
  form.submit()
}

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function createWebBridge(): FitbitBridge {
  let authDelivered = false

  return {
    async getStatus() {
      const status = await api<FitbitAuthStatus>('/api/status')
      // `lastSyncAt` is per-tab state, not server state — there is no database.
      return { ...status, lastSyncAt: readLastSyncAt() ?? status.lastSyncAt }
    },

    saveConfig() {
      // On the web the OAuth client lives in the server environment, so there is
      // nothing for the user to configure. The web settings panel never calls this.
      return Promise.reject(new Error('OAuth credentials are configured on the server for the web app.'))
    },

    connect() {
      // A full-page redirect rather than a popup: no popup blocker, and the
      // session cookie is set on a same-site navigation back to the app.
      window.location.assign('/api/auth/start')
      return Promise.resolve({ ok: true })
    },

    async disconnect() {
      const status = await api<FitbitAuthStatus>('/api/auth/disconnect', { method: 'POST' })
      clearArchive()
      return status
    },

    async sync(date: string) {
      const payload = await api<RawFitbitPayload>('/api/sync', {
        method: 'POST',
        body: JSON.stringify({ date }),
      })
      rememberDay(payload)
      return payload
    },

    getCachedData() {
      return Promise.resolve(latestDay(readArchive()))
    },

    getCachedArchive() {
      return Promise.resolve<RawHealthArchive>(readArchive())
    },

    exportData() {
      const archive = readArchive()
      if (!Object.keys(archive.days).length) return Promise.resolve({ canceled: true })
      const filename = `openfit-${archive.lastDate ?? 'archive'}.json`
      downloadJson(filename, archive)
      return Promise.resolve({ canceled: false, path: filename })
    },

    openExternal(url: string) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return Promise.resolve()
    },

    onAuthComplete(callback) {
      let active = true
      if (pendingAuthResult && !authDelivered) {
        authDelivered = true
        // Defer so the subscriber finishes mounting before the callback runs.
        queueMicrotask(() => {
          if (active) callback(pendingAuthResult)
        })
      }
      return () => {
        active = false
      }
    },

    onSyncProgress() {
      // The BFF returns the whole payload in one response, so there is no
      // per-endpoint progress to report. `App.tsx` falls back to an
      // indeterminate spinner when no progress arrives.
      return () => {}
    },
  }
}
