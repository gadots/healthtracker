import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createAssistantManager } = require('./assistant-manager.cjs') as {
  createAssistantManager: (options: Record<string, unknown>) => {
    listProviders: () => Array<{ id: string; label: string }>
    getActiveProviderId: () => string
    setActiveProvider: (id: string) => Record<string, unknown>
    getStatus: () => Record<string, unknown>
    getUsageLog: (limit?: number) => Record<string, unknown>
    startTurn: (input: Record<string, unknown>) => Promise<Record<string, any>>
    cancelTurn: () => Promise<boolean>
    reset: () => Promise<Record<string, unknown>>
    dispose: () => Promise<void>
  }
}

function fakeProvider(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    label: id,
    getStatus: vi.fn(() => ({ provider: id, state: 'ready', available: true, connected: true, authenticated: true, busy: false, threadId: null, turnId: null, lastError: null, version: null })),
    startTurn: vi.fn(async (input: Record<string, unknown>) => ({ threadId: 't1', turnId: 'x1', status: 'completed', text: `${id}-reply`, meta: null })),
    cancelTurn: vi.fn(async () => true),
    reset: vi.fn(async () => ({})),
    dispose: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('AssistantManager', () => {
  it('defaults to the first provider and lets startTurn delegate to it', async () => {
    const claude = fakeProvider('claude')
    const codex = fakeProvider('codex')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }, { id: 'codex', provider: codex }] })

    expect(manager.getActiveProviderId()).toBe('claude')
    const result = await manager.startTurn({ text: 'hi', healthContext: '{}' })
    expect(result).toMatchObject({ provider: 'claude', text: 'claude-reply' })
    expect(claude.startTurn).toHaveBeenCalledTimes(1)
    expect(codex.startTurn).not.toHaveBeenCalled()
  })

  it('persists a provider switch through the onProviderChange hook', () => {
    const claude = fakeProvider('claude')
    const codex = fakeProvider('codex')
    const persisted: string[] = []
    const manager = createAssistantManager({
      providers: [{ id: 'claude', provider: claude }, { id: 'codex', provider: codex }],
      onProviderChange: (id: string) => persisted.push(id),
    })

    manager.setActiveProvider('codex')
    expect(manager.getActiveProviderId()).toBe('codex')
    expect(persisted).toEqual(['codex'])
  })

  it('caches an identical question over unchanged health data and skips the provider on the second call', async () => {
    const claude = fakeProvider('claude')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }] })

    const context = JSON.stringify({ generatedAt: '2026-06-01T00:00:00Z', steps: 8000 })
    await manager.startTurn({ text: 'How many steps?', healthContext: context })
    // Same question, same underlying data, but a fresh generatedAt timestamp
    // (as the renderer always produces) — must still hit the cache.
    const secondContext = JSON.stringify({ generatedAt: '2026-06-01T00:05:00Z', steps: 8000 })
    const second = await manager.startTurn({ text: 'How many steps?', healthContext: secondContext })

    expect(claude.startTurn).toHaveBeenCalledTimes(1)
    expect(second.cacheHit).toBe(true)
    expect(second.text).toBe('claude-reply')
  })

  it('does not cache across different questions or changed data', async () => {
    const claude = fakeProvider('claude')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }] })

    await manager.startTurn({ text: 'How many steps?', healthContext: JSON.stringify({ generatedAt: 't1', steps: 8000 }) })
    await manager.startTurn({ text: 'How many steps?', healthContext: JSON.stringify({ generatedAt: 't2', steps: 9000 }) })
    await manager.startTurn({ text: 'How did I sleep?', healthContext: JSON.stringify({ generatedAt: 't3', steps: 9000 }) })

    expect(claude.startTurn).toHaveBeenCalledTimes(3)
  })

  it('falls back to the other provider when the active one is unavailable before producing output', async () => {
    const notFoundError = Object.assign(new Error('Claude CLI was not found.'), { code: 'CLAUDE_BINARY_NOT_FOUND' })
    const claude = fakeProvider('claude', { startTurn: vi.fn(async () => { throw notFoundError }) })
    const codex = fakeProvider('codex')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }, { id: 'codex', provider: codex }] })

    const result = await manager.startTurn({ text: 'hi', healthContext: '{}' })

    expect(result).toMatchObject({ provider: 'codex', fallbackFrom: 'claude', text: 'codex-reply' })
    expect(manager.getStatus().lastFallback).toMatchObject({ from: 'claude', to: 'codex' })
  })

  it('does not fall back once partial output has already streamed to the user', async () => {
    const midStreamError = Object.assign(new Error('The Claude turn timed out.'), { code: 'CLAUDE_TURN_TIMEOUT' })
    const claude = fakeProvider('claude', {
      startTurn: vi.fn(async (input: Record<string, unknown>) => {
        (input.onDelta as (delta: string) => void)('partial answer')
        throw midStreamError
      }),
    })
    const codex = fakeProvider('codex')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }, { id: 'codex', provider: codex }] })

    await expect(manager.startTurn({ text: 'hi', healthContext: '{}' })).rejects.toMatchObject({ code: 'CLAUDE_TURN_TIMEOUT' })
    expect(codex.startTurn).not.toHaveBeenCalled()
  })

  it('does not fall back for an ordinary turn failure that is not an availability error', async () => {
    const turnFailed = Object.assign(new Error('The Claude turn failed.'), { code: 'CLAUDE_TURN_FAILED' })
    const claude = fakeProvider('claude', { startTurn: vi.fn(async () => { throw turnFailed }) })
    const codex = fakeProvider('codex')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }, { id: 'codex', provider: codex }] })

    await expect(manager.startTurn({ text: 'hi', healthContext: '{}' })).rejects.toMatchObject({ code: 'CLAUDE_TURN_FAILED' })
    expect(codex.startTurn).not.toHaveBeenCalled()
  })

  it('records per-provider usage counters including cache hits and failures', async () => {
    const claude = fakeProvider('claude')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }] })

    await manager.startTurn({ text: 'q1', healthContext: JSON.stringify({ generatedAt: 't1' }) })
    await manager.startTurn({ text: 'q1', healthContext: JSON.stringify({ generatedAt: 't2' }) })

    const usage = manager.getUsageLog() as { summary: Record<string, any>; entries: unknown[] }
    expect(usage.summary.claude).toMatchObject({ turnsStarted: 2, turnsCompleted: 1, cacheHits: 1, turnsFailed: 0 })
    expect(usage.entries).toHaveLength(2)
  })

  it('routes cancelTurn to whichever provider currently has an attempt in flight', async () => {
    let resolveTurn: (value: Record<string, unknown>) => void = () => {}
    const claude = fakeProvider('claude', {
      startTurn: vi.fn(() => new Promise((resolve) => { resolveTurn = resolve })),
    })
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }] })

    const pending = manager.startTurn({ text: 'hi', healthContext: '{}' })
    await Promise.resolve()
    await manager.cancelTurn()
    expect(claude.cancelTurn).toHaveBeenCalledTimes(1)
    resolveTurn({ threadId: null, turnId: null, status: 'completed', text: 'done' })
    await pending
  })

  it('fans reset and dispose out to every provider', async () => {
    const claude = fakeProvider('claude')
    const codex = fakeProvider('codex')
    const manager = createAssistantManager({ providers: [{ id: 'claude', provider: claude }, { id: 'codex', provider: codex }] })

    await manager.reset()
    expect(claude.reset).toHaveBeenCalledTimes(1)
    expect(codex.reset).toHaveBeenCalledTimes(1)

    await manager.dispose()
    expect(claude.dispose).toHaveBeenCalledTimes(1)
    expect(codex.dispose).toHaveBeenCalledTimes(1)
  })
})
