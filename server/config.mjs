import crypto from 'node:crypto'

/**
 * Server-side configuration for the hosted web app.
 *
 * Nothing here is ever sent to the browser: the OAuth client secret and the
 * session key stay in this process. Note that none of these are `VITE_*`
 * variables — anything with that prefix is inlined into the public bundle.
 */

function required(env, name) {
  const value = env[name]
  if (!value || !value.trim()) throw new Error(`Missing required environment variable ${name}.`)
  return value.trim()
}

function sessionKey(env) {
  const raw = required(env, 'SESSION_SECRET')
  // Accept hex or base64, but insist on a real 32-byte key rather than
  // silently stretching a short password.
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length !== 32) {
    throw new Error('SESSION_SECRET must be 32 bytes, hex or base64 encoded. Generate one with: openssl rand -hex 32')
  }
  return decoded
}

const MIN_PASSPHRASE_LENGTH = 12

/**
 * The gate is the only thing between this deployment and the open internet, so
 * a missing or weak passphrase fails startup rather than quietly serving the
 * dashboard to anyone. `ALLOW_NO_PASSPHRASE=1` is the explicit local-dev escape.
 */
function gatePassphrase(env) {
  const value = (env.APP_PASSPHRASE || '').trim()
  if (!value) {
    if (env.ALLOW_NO_PASSPHRASE === '1') return null
    throw new Error(
      'Missing APP_PASSPHRASE: the web app refuses to start without its access gate. '
      + 'Generate one with `openssl rand -base64 24`, or set ALLOW_NO_PASSPHRASE=1 for local development only.',
    )
  }
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`APP_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters. Generate one with: openssl rand -base64 24`)
  }
  return value
}

export function loadConfig(env = process.env) {
  const mockHealth = env.MOCK_HEALTH === '1'
  const redirectUri = env.OAUTH_REDIRECT_URI?.trim() || ''

  if (redirectUri) {
    const parsed = new URL(redirectUri)
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    if (parsed.protocol !== 'https:' && !loopback) {
      throw new Error('OAUTH_REDIRECT_URI must use https outside of local development.')
    }
  }

  const passphrase = gatePassphrase(env)

  return {
    passphrase,
    // null only under ALLOW_NO_PASSPHRASE, which leaves the gate open.
    gateEnabled: passphrase !== null,
    gateTtlSeconds: Math.max(1, Number(env.GATE_TTL_HOURS || 12)) * 3600,
    port: Number(env.PORT || 42814),
    host: env.HOST || '0.0.0.0',
    // Behind a proxy, trust X-Forwarded-Proto so `Secure` cookies are set correctly.
    trustProxy: env.TRUST_PROXY !== '0',
    mockHealth,
    sessionKey: sessionKey(env),
    oauth: {
      clientId: mockHealth ? 'mock-client' : required(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: mockHealth ? 'mock-secret' : required(env, 'GOOGLE_CLIENT_SECRET'),
      redirectUri: redirectUri || `http://127.0.0.1:${Number(env.PORT || 42814)}/api/auth/callback`,
      provider: 'google-health',
    },
  }
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex')
}
