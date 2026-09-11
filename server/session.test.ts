import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM module without type declarations
import { buildCookie, parseCookies, seal, unseal } from './session.mjs'

const key = crypto.randomBytes(32)

describe('session sealing', () => {
  it('round-trips a session through seal and unseal', () => {
    const sealed = seal(key, { refresh_token: 'abc123' })
    expect(sealed).not.toContain('abc123')
    expect(unseal(key, sealed)).toEqual({ refresh_token: 'abc123' })
  })

  it('rejects a value sealed with a different key', () => {
    const sealed = seal(crypto.randomBytes(32), { refresh_token: 'abc123' })
    expect(unseal(key, sealed)).toBeNull()
  })

  it('rejects a tampered payload rather than trusting it', () => {
    const sealed = seal(key, { refresh_token: 'abc123' })
    const bytes = Buffer.from(sealed, 'base64url')
    bytes[bytes.length - 1] ^= 0xff
    expect(unseal(key, bytes.toString('base64url'))).toBeNull()
  })

  it('treats missing or malformed cookies as no session', () => {
    expect(unseal(key, '')).toBeNull()
    expect(unseal(key, undefined)).toBeNull()
    expect(unseal(key, 'not-base64-at-all!!')).toBeNull()
  })
})

describe('cookies', () => {
  it('parses a cookie header into a jar', () => {
    expect(parseCookies('of_session=abc; other=def')).toEqual({ of_session: 'abc', other: 'def' })
    expect(parseCookies(undefined)).toEqual({})
  })

  it('marks session cookies HttpOnly and SameSite=Lax so the OAuth redirect works', () => {
    const cookie = buildCookie('of_session', 'value', { maxAge: 60, secure: true })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
  })

  it('omits Secure when served over plain http for local development', () => {
    expect(buildCookie('of_session', 'value', { maxAge: 60, secure: false })).not.toContain('Secure')
  })
})
