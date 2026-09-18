import crypto from 'node:crypto'

import { seal, unseal } from './session.mjs'

/**
 * Passphrase gate in front of the whole deployment — static files, `/api/*`
 * and the demo dashboard included.
 *
 * The Google session already keeps health data private, but without this a
 * stranger who finds the URL can still load the dashboard and start OAuth
 * flows against our client. The gate runs before any route or file is served.
 */

export const GATE_COOKIE = 'of_gate'

/**
 * Both sides are hashed first so the buffers always have equal length:
 * `timingSafeEqual` throws on a length mismatch, and that throw would itself
 * leak the length of the real passphrase.
 */
export function passphraseMatches(expected, candidate) {
  if (typeof expected !== 'string' || typeof candidate !== 'string' || !expected || !candidate) return false
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest()
  const b = crypto.createHash('sha256').update(candidate, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

export function isUnlocked(config, cookieValue) {
  const gate = unseal(config.sessionKey, cookieValue)
  if (!gate || gate.v !== 1) return false
  return typeof gate.exp === 'number' && gate.exp > Date.now()
}

export function sealGate(config, ttlSeconds) {
  return seal(config.sessionKey, { v: 1, exp: Date.now() + ttlSeconds * 1000 })
}

/**
 * `?next=` is the open-redirect vector: `//evil.com` and `https://evil.com`
 * would both turn the login page into a springboard. Only a single-slash local
 * path is allowed through; anything else falls back to the root.
 */
export function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/'
  // `//host` is protocol-relative, and a backslash is normalised to a slash by
  // some browsers, so both are treated as absolute.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/'
  if (value.includes('\n') || value.includes('\r')) return '/'
  return value
}

/** Client address, trusting proxy headers only when configured to. */
export function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const flyIp = request.headers['fly-client-ip']
    if (flyIp) return String(flyIp).trim()
    const forwarded = request.headers['x-forwarded-for']
    if (forwarded) return String(forwarded).split(',')[0].trim()
  }
  return request.socket?.remoteAddress || 'unknown'
}

/**
 * In-memory brute-force limiter: per-address with exponential backoff, plus a
 * global ceiling so rotating addresses does not buy unlimited attempts. Per
 * process rather than shared, which is enough while one machine stays warm.
 */
export function createAttemptLimiter({
  maxAttempts = 5,
  baseDelayMs = 2_000,
  maxDelayMs = 15 * 60_000,
  globalMaxPerWindow = 60,
  windowMs = 15 * 60_000,
  now = () => Date.now(),
} = {}) {
  const perAddress = new Map()
  let globalCount = 0
  let globalWindowStart = now()

  function prune() {
    const cutoff = now() - maxDelayMs * 2
    for (const [key, entry] of perAddress) {
      if (entry.lockedUntil < cutoff) perAddress.delete(key)
    }
  }

  return {
    /** Milliseconds the caller must wait, or 0 when an attempt is allowed. */
    retryAfterMs(address) {
      if (now() - globalWindowStart > windowMs) {
        globalWindowStart = now()
        globalCount = 0
      }
      if (globalCount >= globalMaxPerWindow) return windowMs - (now() - globalWindowStart)
      const entry = perAddress.get(address)
      if (!entry) return 0
      return Math.max(0, entry.lockedUntil - now())
    },

    recordFailure(address) {
      globalCount += 1
      const entry = perAddress.get(address) ?? { failures: 0, lockedUntil: 0 }
      entry.failures += 1
      if (entry.failures >= maxAttempts) {
        const overage = entry.failures - maxAttempts
        entry.lockedUntil = now() + Math.min(baseDelayMs * 2 ** overage, maxDelayMs)
      }
      perAddress.set(address, entry)
      prune()
    },

    recordSuccess(address) {
      perAddress.delete(address)
    },
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]
  ))
}

/**
 * Server-rendered so the gate closes before a single line of the app bundle
 * loads. A plain form with no JavaScript: it works with scripting disabled and
 * offers no script surface to attack. Palette matches the dashboard and the
 * desktop OAuth page (`electron/main.cjs`).
 */
export function loginPage({ error = null, nextPath = '/', retryAfterSeconds = 0 } = {}) {
  const disabled = retryAfterSeconds > 0
  const message = disabled
    ? `Too many attempts. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`
    : error

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#080c11">
<meta name="robots" content="noindex, nofollow">
<title>OpenFit</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;color:#edf4f5;background:#080c11;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
.card{width:min(400px,100%);padding:34px;border:1px solid #ffffff12;border-radius:20px;background:#111820;
box-shadow:0 25px 80px #0008}
.orb{display:grid;width:52px;height:52px;place-items:center;margin:0 auto 20px;border-radius:50%;
color:#5ae4c0;background:#5ae4c016;font-size:24px}
h1{margin:0 0 8px;font-size:21px;text-align:center}
.sub{margin:0 0 24px;color:#83909b;font-size:13px;line-height:1.55;text-align:center}
label{display:block;margin-bottom:7px;color:#c3ced6;font-size:12px;font-weight:600;letter-spacing:.02em}
input[type=password]{width:100%;padding:11px 13px;color:#edf4f5;font-size:14px;background:#0b1117;
border:1px solid #ffffff1f;border-radius:10px}
input[type=password]:focus{outline:none;border-color:#5ae4c0;box-shadow:0 0 0 3px #5ae4c024}
.remember{display:flex;gap:9px;align-items:center;margin:16px 0 22px;color:#83909b;font-size:13px}
.remember input{width:15px;height:15px;accent-color:#5ae4c0}
button{width:100%;padding:11px;color:#04140f;font-size:14px;font-weight:600;background:#5ae4c0;border:0;
border-radius:10px;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.error{margin:0 0 18px;padding:10px 12px;color:#ffb4ae;font-size:13px;line-height:1.5;
background:#ff7b7412;border:1px solid #ff7b7433;border-radius:10px}
.foot{margin:22px 0 0;color:#5d6873;font-size:11.5px;line-height:1.55;text-align:center}
</style></head><body><main class="card">
<div class="orb">&#9825;</div>
<h1>OpenFit</h1>
<p class="sub">This dashboard holds personal health data. Enter the passphrase to continue.</p>
${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(nextPath)}">
<label for="passphrase">Passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password"
autofocus required${disabled ? ' disabled' : ''}>
<div class="remember">
<input id="remember" name="remember" type="checkbox" value="1"${disabled ? ' disabled' : ''}>
<label for="remember" style="margin:0;font-weight:400;letter-spacing:0">Remember this device for 30 days</label>
</div>
<button type="submit"${disabled ? ' disabled' : ''}>Unlock</button>
</form>
<p class="foot">Health data is fetched from Google on demand and never stored on a server.</p>
</main></body></html>`
}
