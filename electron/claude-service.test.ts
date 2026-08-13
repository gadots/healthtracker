import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createClaudeService } = require('./claude-service.cjs') as {
  createClaudeService: (options?: Record<string, unknown>) => {
    getStatus: () => Record<string, unknown>
    start: () => Promise<Record<string, unknown>>
    startTurn: (input: Record<string, unknown>) => Promise<Record<string, any>>
    cancelTurn: () => Promise<boolean>
    reset: () => Promise<Record<string, unknown>>
    dispose: () => Promise<void>
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  stdinData = ''
  killed = false
  exitCode: number | null = null
  signalCode: string | null = null

  constructor(private readonly onStdin: (data: string, child: FakeChild) => void = () => {}) {
    super()
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.stdinData += chunk.toString()
        done()
      },
      final: (done) => {
        this.onStdin(this.stdinData, this)
        done()
      },
    })
  }

  kill(signal = 'SIGTERM') {
    this.killed = true
    this.signalCode = signal
    return true
  }

  finish(result: Record<string, any>, exitCode = 0) {
    this.stdout.end(JSON.stringify(result))
    queueMicrotask(() => this.emit('close', exitCode, null))
  }
}

describe('Claude CLI service', () => {
  it('runs a headless turn with the read-only flags and parses the JSON result', async () => {
    let capturedArgs: string[] | undefined
    let capturedEnv: Record<string, unknown> | undefined
    const child = new FakeChild((stdin, current) => {
      expect(stdin).toContain('<OPENFIT_HEALTH_CONTEXT>')
      expect(stdin).toContain('How did I sleep?')
      current.finish({ result: 'You slept 7h30m.', session_id: 'sess-1', is_error: false, num_turns: 1, duration_ms: 420, total_cost_usd: 0.0031 })
    })
    const spawn = vi.fn((_binary: string, args: string[], options: Record<string, unknown>) => {
      capturedArgs = args
      capturedEnv = options.env as Record<string, unknown>
      return child
    })
    const service = createClaudeService({
      spawn,
      resolveBinary: () => '/mock/claude',
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-should-be-stripped' },
    })

    const result = await service.startTurn({ text: 'How did I sleep?', healthContext: { date: '2026-06-23', sleepMinutes: 450 } })

    expect(result).toEqual({
      threadId: 'sess-1',
      turnId: expect.any(String),
      status: 'completed',
      text: 'You slept 7h30m.',
      meta: { turnsUsed: 1, durationMs: 420, costUsd: 0.0031 },
    })
    expect(capturedArgs).toEqual(expect.arrayContaining([
      '-p', '--output-format', 'json',
      '--permission-mode', 'default',
      '--max-turns', '4',
    ]))
    expect(capturedArgs).not.toContain('--dangerously-skip-permissions')
    expect(capturedArgs?.[capturedArgs.indexOf('--disallowed-tools') + 1]).toContain('Bash')
    expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(service.getStatus()).toMatchObject({ provider: 'claude', state: 'ready', connected: true, threadId: 'sess-1', authenticated: true })
  })

  it('resumes the previous session id on the next turn', async () => {
    const args: string[][] = []
    const spawn = vi.fn((_binary: string, callArgs: string[]) => {
      args.push(callArgs)
      const child = new FakeChild((_stdin, current) => {
        current.finish({ result: 'ok', session_id: 'sess-42', is_error: false })
      })
      return child
    })
    const service = createClaudeService({ spawn, resolveBinary: () => '/mock/claude' })

    await service.startTurn({ text: 'first', healthContext: '{}' })
    await service.startTurn({ text: 'second', healthContext: '{}' })

    expect(args[0]).not.toContain('--resume')
    expect(args[1]).toEqual(expect.arrayContaining(['--resume', 'sess-42']))
  })

  it('reports a missing Claude binary without spawning', async () => {
    const spawn = vi.fn()
    const service = createClaudeService({ spawn, resolveBinary: () => null })

    await expect(service.start()).rejects.toMatchObject({ code: 'CLAUDE_BINARY_NOT_FOUND' })
    expect(spawn).not.toHaveBeenCalled()
    expect(service.getStatus()).toMatchObject({ available: false, connected: false, authenticated: false })
  })

  it('classifies an unauthenticated CLI as CLAUDE_UNAUTHENTICATED without leaking stderr', async () => {
    const child = new FakeChild((_stdin, current) => {
      current.stderr.write('Please run `claude login` to authenticate. token=super-secret-value')
      current.stdout.end('')
      queueMicrotask(() => current.emit('close', 1, null))
    })
    const service = createClaudeService({ spawn: () => child, resolveBinary: () => '/mock/claude' })

    let caught: any
    try { await service.startTurn({ text: 'hi', healthContext: '{}' }) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'CLAUDE_UNAUTHENTICATED' })
    expect(caught.message).not.toContain('super-secret-value')
    expect(service.getStatus().authenticated).toBe(false)
  })

  it('sanitizes spawn failures and never exposes raw error text', async () => {
    const spawn = vi.fn(() => {
      throw Object.assign(new Error('sk-leaked-secret-value'), { code: 'ENOENT' })
    })
    const service = createClaudeService({ spawn, resolveBinary: () => '/mock/claude' })

    let caught: any
    try { await service.startTurn({ text: 'hi', healthContext: '{}' }) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'CLAUDE_SPAWN_FAILED' })
    expect(caught.message).not.toContain('sk-leaked-secret-value')
  })

  it('cancels an in-flight turn and rejects with an AbortError', async () => {
    const child = new FakeChild()
    const service = createClaudeService({ spawn: () => child, resolveBinary: () => '/mock/claude' })

    const turn = service.startTurn({ text: 'slow question', healthContext: '{}' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await service.cancelTurn()
    child.emit('close', null, 'SIGTERM')

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.killed).toBe(true)
  })

  it('rejects an empty message without spawning', async () => {
    const spawn = vi.fn()
    const service = createClaudeService({ spawn, resolveBinary: () => '/mock/claude' })
    await expect(service.startTurn({ text: '   ', healthContext: '{}' })).rejects.toMatchObject({ code: 'CLAUDE_INVALID_TURN' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
