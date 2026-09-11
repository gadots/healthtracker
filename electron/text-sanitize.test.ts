import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { sanitizeMessage } = require('./text-sanitize.cjs') as {
  sanitizeMessage: (value: unknown, fallback?: string) => string
}

// This module is the last line of defence before an error message reaches a
// log, the renderer, or a test snapshot, so the redaction rules are pinned
// explicitly rather than trusted.
describe('sanitizeMessage', () => {
  it('redacts bearer tokens regardless of case', () => {
    expect(sanitizeMessage('Authorization: Bearer abc123secret')).not.toContain('abc123secret')
    expect(sanitizeMessage('failed with bearer abc123secret')).not.toContain('abc123secret')
    expect(sanitizeMessage('Bearer abc123secret')).toContain('[redacted]')
  })

  it('redacts API-key style tokens', () => {
    expect(sanitizeMessage('key sk-livesecretvalue123 rejected')).not.toContain('sk-livesecretvalue123')
    expect(sanitizeMessage('key sk-livesecretvalue123 rejected')).toContain('[redacted]')
  })

  it('redacts every labelled credential field it knows about', () => {
    const labels = ['api_key', 'api-key', 'apikey', 'access_token', 'refresh_token', 'id_token', 'session_id', 'authorization', 'cookie']
    for (const label of labels) {
      for (const separator of ['=', ': ']) {
        const message = sanitizeMessage(`request failed ${label}${separator}supersecretvalue end`)
        expect(message, `${label}${separator}`).not.toContain('supersecretvalue')
        expect(message, `${label}${separator}`).toContain('[redacted]')
      }
    }
  })

  it('redacts an uppercase credential label too', () => {
    expect(sanitizeMessage('ACCESS_TOKEN=supersecretvalue')).not.toContain('supersecretvalue')
  })

  it('strips the control characters the leading regex targets', () => {
    // The first replace in text-sanitize.cjs is a control-character class that
    // is invisible in review, so its intent is pinned here.
    const stripped = ['\u0000', '\u0007', '\u000b', '\u000c', '\u001b', '\u001f', '\u007f']
    for (const character of stripped) {
      expect(sanitizeMessage(`left${character}right`), JSON.stringify(character)).toBe('leftright')
    }
  })

  it('keeps tab and newline, which sit outside that class', () => {
    expect(sanitizeMessage('first\tsecond')).toBe('first\tsecond')
    expect(sanitizeMessage('first\nsecond')).toBe('first\nsecond')
  })

  it('keeps ordinary punctuation intact', () => {
    expect(sanitizeMessage('Could not start Codex app-server (ENOENT).')).toBe('Could not start Codex app-server (ENOENT).')
  })

  it('caps very long messages at 600 characters', () => {
    expect(sanitizeMessage('x'.repeat(5_000))).toHaveLength(600)
  })

  it('falls back when the message is empty, blank, or missing', () => {
    expect(sanitizeMessage('', 'fallback text')).toBe('fallback text')
    expect(sanitizeMessage('   ', 'fallback text')).toBe('fallback text')
    expect(sanitizeMessage(undefined, 'fallback text')).toBe('fallback text')
    expect(sanitizeMessage(null, 'fallback text')).toBe('fallback text')
    expect(sanitizeMessage(undefined)).toBe('Assistant error.')
  })

  it('coerces non-string input instead of throwing', () => {
    expect(sanitizeMessage(new Error('boom').message)).toBe('boom')
    expect(sanitizeMessage(42)).toBe('42')
    expect(() => sanitizeMessage({ nested: true })).not.toThrow()
  })
})
