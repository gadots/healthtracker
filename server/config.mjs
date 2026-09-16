import crypto from 'node:crypto'

/**
 * Server-side configuration for the hosted web app.
 *
 * Nothing here is ever sent to the browser: the OAuth client secret and the
 * session key stay in this process. Note that none of these are `VITE_*`
 * variables — anything with that prefix is inlined into the public bundle.
 */

function required(name) {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`Missing required environment variable ${name}.`)
  return value.trim()
}

function sessionKey() {
  const raw = required('SESSION_SECRET')
  // Accept hex or base64, but insist on a real 32-byte key rather than
  // silently stretching a short password.
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length !== 32) {
    throw new Error('SESSION_SECRET must be 32 bytes, hex or base64 encoded. Generate one with: openssl rand -hex 32')
  }
  return decoded
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

  return {
    port: Number(env.PORT || 42814),
    host: env.HOST || '0.0.0.0',
    // Behind a proxy, trust X-Forwarded-Proto so `Secure` cookies are set correctly.
    trustProxy: env.TRUST_PROXY !== '0',
    mockHealth,
    sessionKey: sessionKey(),
    oauth: {
      clientId: mockHealth ? 'mock-client' : required('GOOGLE_CLIENT_ID'),
      clientSecret: mockHealth ? 'mock-secret' : required('GOOGLE_CLIENT_SECRET'),
      redirectUri: redirectUri || `http://127.0.0.1:${Number(env.PORT || 42814)}/api/auth/callback`,
      provider: 'google-health',
    },
  }
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex')
}
