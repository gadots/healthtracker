import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM module without type declarations
import { clientAddress, createAttemptLimiter, isUnlocked, loginPage, passphraseMatches, safeNextPath, sealGate } from './gate.mjs'
// @ts-expect-error -- plain ESM module without type declarations
import { loadConfig } from './config.mjs'

const config = { sessionKey: crypto.randomBytes(32) }

describe('passphraseMatches', () => {
  it('accepts the exact passphrase', () => {
    expect(passphraseMatches('correct horse battery', 'correct horse battery')).toBe(true)
  })

  it('rejects a wrong passphrase', () => {
    expect(passphraseMatches('correct horse battery', 'correct horse batteru')).toBe(false)
  })

  it('does not throw on differing lengths', () => {
    // Hashing first keeps timingSafeEqual from throwing, which would itself
    // have leaked the real passphrase's length.
    expect(() => passphraseMatches('short', 'a much longer attempt')).not.toThrow()
    expect(passphraseMatches('short', 'a much longer attempt')).toBe(false)
  })

  it('rejects empty and non-string input', () => {
    for (const value of ['', null, undefined, 42, {}]) {
      expect(passphraseMatches('real passphrase', value as string)).toBe(false)
    }
    expect(passphraseMatches('', '')).toBe(false)
  })
})

describe('gate cookie', () => {
  it('round-trips an unlocked gate', () => {
    expect(isUnlocked(config, sealGate(config, 3_600))).toBe(true)
  })

  it('rejects an expired gate', () => {
    expect(isUnlocked(config, sealGate(config, -1))).toBe(false)
  })

  it('rejects a missing, tampered, or foreign cookie', () => {
    expect(isUnlocked(config, undefined)).toBe(false)
    expect(isUnlocked(config, 'garbage')).toBe(false)
    const sealed = sealGate({ sessionKey: crypto.randomBytes(32) }, 3_600)
    expect(isUnlocked(config, sealed)).toBe(false)
  })
})

describe('safeNextPath', () => {
  it('keeps local paths', () => {
    expect(safeNextPath('/health')).toBe('/health')
    expect(safeNextPath('/?a=1')).toBe('/?a=1')
  })

  it('refuses anything that could redirect off-site', () => {
    for (const value of [
      'https://evil.com', '//evil.com', '/\\evil.com', 'http://evil.com',
      'evil.com', '', null, undefined, '/ok\nLocation: https://evil.com',
    ]) {
      expect(safeNextPath(value as string)).toBe('/')
    }
  })
})

describe('clientAddress', () => {
  const request = {
    headers: { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
    socket: { remoteAddress: '10.1.2.3' },
  }

  it('prefers the proxy header when the proxy is trusted', () => {
    expect(clientAddress(request, true)).toBe('203.0.113.9')
    expect(clientAddress({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, socket: { remoteAddress: '10.1.2.3' } }, true))
      .toBe('198.51.100.7')
  })

  it('ignores spoofable headers when the proxy is not trusted', () => {
    // Otherwise an attacker rotates the header and escapes their own rate limit.
    expect(clientAddress(request, false)).toBe('10.1.2.3')
  })
})

describe('createAttemptLimiter', () => {
  it('allows attempts until the threshold, then locks with backoff', () => {
    let now = 1_000_000
    const limiter = createAttemptLimiter({ maxAttempts: 3, baseDelayMs: 1_000, now: () => now })

    expect(limiter.retryAfterMs('a')).toBe(0)
    limiter.recordFailure('a')
    limiter.recordFailure('a')
    expect(limiter.retryAfterMs('a')).toBe(0)

    limiter.recordFailure('a')
    expect(limiter.retryAfterMs('a')).toBe(1_000)

    limiter.recordFailure('a')
    expect(limiter.retryAfterMs('a')).toBe(2_000)

    now += 5_000
    expect(limiter.retryAfterMs('a')).toBe(0)
  })

  it('keeps addresses independent and clears on success', () => {
    let now = 1_000_000
    const limiter = createAttemptLimiter({ maxAttempts: 1, baseDelayMs: 1_000, now: () => now })
    limiter.recordFailure('a')
    expect(limiter.retryAfterMs('a')).toBeGreaterThan(0)
    expect(limiter.retryAfterMs('b')).toBe(0)
    limiter.recordSuccess('a')
    expect(limiter.retryAfterMs('a')).toBe(0)
  })

  it('applies a global ceiling so rotating addresses buys nothing', () => {
    let now = 1_000_000
    const limiter = createAttemptLimiter({ maxAttempts: 99, globalMaxPerWindow: 4, now: () => now })
    for (let i = 0; i < 4; i += 1) limiter.recordFailure(`addr-${i}`)
    expect(limiter.retryAfterMs('brand-new-address')).toBeGreaterThan(0)
  })
})

describe('loginPage', () => {
  it('carries no script and escapes the next path', () => {
    const html = loginPage({ nextPath: '/"><script>alert(1)</script>', error: '<b>bad</b>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;')
    expect(html).toContain('name="passphrase"')
    expect(html).toContain('noindex')
  })

  it('disables the form while locked out', () => {
    const html = loginPage({ retryAfterSeconds: 30 })
    expect(html).toContain('disabled')
    expect(html).toContain('30 seconds')
  })
})

describe('loadConfig gate validation', () => {
  const base = {
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    MOCK_HEALTH: '1',
  }

  it('refuses to start without a passphrase', () => {
    expect(() => loadConfig({ ...base })).toThrow(/APP_PASSPHRASE/)
  })

  it('refuses a passphrase that is too short', () => {
    expect(() => loadConfig({ ...base, APP_PASSPHRASE: 'short' })).toThrow(/at least 12/)
  })

  it('accepts a strong passphrase and enables the gate', () => {
    const config = loadConfig({ ...base, APP_PASSPHRASE: 'a-long-enough-passphrase' })
    expect(config.gateEnabled).toBe(true)
    expect(config.gateTtlSeconds).toBe(12 * 3600)
  })

  it('allows an explicit opt-out for local development only', () => {
    const config = loadConfig({ ...base, ALLOW_NO_PASSPHRASE: '1' })
    expect(config.gateEnabled).toBe(false)
  })

  it('honours a custom gate TTL', () => {
    const config = loadConfig({ ...base, APP_PASSPHRASE: 'a-long-enough-passphrase', GATE_TTL_HOURS: '48' })
    expect(config.gateTtlSeconds).toBe(48 * 3600)
  })
})
