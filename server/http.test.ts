import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM module without type declarations
import { isSecureRequest, validSyncDate } from './http.mjs'

describe('validSyncDate', () => {
  const today = '2026-03-12'

  it('accepts today and past dates', () => {
    expect(validSyncDate('2026-03-12', today)).toBe(true)
    expect(validSyncDate('2025-12-31', today)).toBe(true)
  })

  it('rejects future dates', () => {
    expect(validSyncDate('2026-03-13', today)).toBe(false)
  })

  it('rejects anything that is not a plain YYYY-MM-DD string', () => {
    for (const value of ['', 'nope', '2026-3-2', '2026-03-12T00:00:00Z', '../../etc/passwd', null, 42, {}]) {
      expect(validSyncDate(value, today)).toBe(false)
    }
  })
})

describe('isSecureRequest', () => {
  const plain = { socket: {}, headers: {} }

  it('trusts a TLS socket', () => {
    expect(isSecureRequest({ socket: { encrypted: true }, headers: {} }, false)).toBe(true)
  })

  it('honours x-forwarded-proto only when the proxy is trusted', () => {
    const forwarded = { socket: {}, headers: { 'x-forwarded-proto': 'https' } }
    expect(isSecureRequest(forwarded, true)).toBe(true)
    expect(isSecureRequest(forwarded, false)).toBe(false)
  })

  it('reads only the first hop of a forwarded chain', () => {
    expect(isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https, http' } }, true)).toBe(true)
    expect(isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'http, https' } }, true)).toBe(false)
  })

  it('defaults to insecure', () => {
    expect(isSecureRequest(plain, true)).toBe(false)
  })
})
