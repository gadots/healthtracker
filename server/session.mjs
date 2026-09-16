import crypto from 'node:crypto'

/**
 * The entire "database" of this deployment: an AES-256-GCM sealed value carried
 * in an httpOnly cookie. Nothing is persisted server-side, so the app scales
 * horizontally and stores no health data at rest.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export function seal(key, value) {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

export function unseal(key, sealed) {
  if (typeof sealed !== 'string' || !sealed) return null
  try {
    const raw = Buffer.from(sealed, 'base64url')
    if (raw.length <= IV_BYTES + 16) return null
    const decipher = crypto.createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + 16))
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + 16)), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    // Tampered, truncated, or sealed with a rotated key — treat as no session.
    return null
  }
}

export function parseCookies(header) {
  const jar = {}
  if (!header) return jar
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

export function buildCookie(name, value, { maxAge, secure }) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: the cookie must survive Google's redirect back to us.
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

export const SESSION_COOKIE = 'of_session'
export const OAUTH_COOKIE = 'of_oauth'
