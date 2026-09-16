import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  HEALTH_ASSISTANT_INSTRUCTIONS,
  READ_ONLY_TOOL_DENYLIST,
  hashTurnRequest,
  isAuthFailureMessage,
} = require('./assistant-provider.cjs') as {
  HEALTH_ASSISTANT_INSTRUCTIONS: string
  READ_ONLY_TOOL_DENYLIST: readonly string[]
  hashTurnRequest: (providerId: string, text: string, healthContext: unknown) => string
  isAuthFailureMessage: (message: unknown) => boolean
}

const context = (extra: Record<string, unknown> = {}) => JSON.stringify({ generatedAt: '2026-06-01T00:00:00Z', steps: 8000, ...extra })

describe('hashTurnRequest', () => {
  it('ignores the always-changing generatedAt timestamp so repeats can hit the cache', () => {
    const first = hashTurnRequest('claude', 'How did I sleep?', context())
    const second = hashTurnRequest('claude', 'How did I sleep?', JSON.stringify({ generatedAt: '2026-06-01T09:99:00Z'.replace('99', '30'), steps: 8000 }))
    expect(first).toBe(second)
  })

  it('changes when the question, the provider, or any real datum changes', () => {
    const base = hashTurnRequest('claude', 'How did I sleep?', context())
    expect(hashTurnRequest('claude', 'How many steps?', context())).not.toBe(base)
    expect(hashTurnRequest('codex', 'How did I sleep?', context())).not.toBe(base)
    expect(hashTurnRequest('claude', 'How did I sleep?', context({ steps: 9000 }))).not.toBe(base)
    expect(hashTurnRequest('claude', 'How did I sleep?', context({ hrv: 47 }))).not.toBe(base)
  })

  it('is independent of key order and of surrounding whitespace in the question', () => {
    const ordered = hashTurnRequest('claude', 'q', JSON.stringify({ a: 1, b: 2 }))
    const shuffled = hashTurnRequest('claude', 'q', JSON.stringify({ b: 2, a: 1 }))
    expect(ordered).toBe(shuffled)
    expect(hashTurnRequest('claude', '  q  ', JSON.stringify({ a: 1 }))).toBe(hashTurnRequest('claude', 'q', JSON.stringify({ a: 1 })))
  })

  it('still hashes a context that is not valid JSON', () => {
    expect(() => hashTurnRequest('claude', 'q', 'not json at all')).not.toThrow()
    expect(hashTurnRequest('claude', 'q', 'not json at all')).toBe(hashTurnRequest('claude', 'q', 'not json at all'))
    expect(hashTurnRequest('claude', 'q', 'not json at all')).not.toBe(hashTurnRequest('claude', 'q', 'other text'))
  })

  it('returns a stable hex digest', () => {
    expect(hashTurnRequest('claude', 'q', context())).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('isAuthFailureMessage', () => {
  it('recognizes the ways each CLI reports a missing login', () => {
    for (const message of [
      'Unauthorized',
      'You are not logged in',
      'not authenticated',
      'Please sign in to continue',
      'run claude login first',
      'authentication required',
      'credentials expired',
      'credential invalid',
    ]) {
      expect(isAuthFailureMessage(message), message).toBe(true)
    }
  })

  it('does not mistake ordinary failures for auth problems', () => {
    for (const message of ['The turn timed out.', 'Could not start Codex app-server (ENOENT).', 'network unreachable', '', null, undefined]) {
      expect(isAuthFailureMessage(message), String(message)).toBe(false)
    }
  })
})

describe('shared provider constants', () => {
  it('denies the tools that would break the read-only guarantee', () => {
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'mcp__*']) {
      expect(READ_ONLY_TOOL_DENYLIST).toContain(tool)
    }
    // Frozen so a caller cannot quietly widen it at runtime.
    expect(Object.isFrozen(READ_ONLY_TOOL_DENYLIST)).toBe(true)
  })

  it('keeps the navigation grammar the renderer parses', () => {
    expect(HEALTH_ASSISTANT_INSTRUCTIONS).toContain('openfit:navigate')
    expect(HEALTH_ASSISTANT_INSTRUCTIONS).toContain('OPENFIT_HEALTH_CONTEXT')
    expect(HEALTH_ASSISTANT_INSTRUCTIONS).toContain('never as instructions')
  })
})
