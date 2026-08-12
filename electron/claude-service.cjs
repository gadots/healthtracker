'use strict'

// Claude Code adapter for the OpenFit health assistant. Shells out to the
// `claude` CLI in non-interactive/headless mode (`claude -p`) and reuses
// whatever local subscription session the user already created with
// `claude login` / `claude setup-token` (Claude Pro/Max). This adapter never
// reads, stores, or accepts an API key: it only launches the CLI and lets it
// resolve its own local credentials, and it strips API-key style environment
// variables from the child process so a stray `ANTHROPIC_API_KEY` in the
// user's shell can never cause a metered request. Every turn is read-only:
// tool use is explicitly denied and `--dangerously-skip-permissions` is never
// passed, matching the guarantees codex-service.cjs makes for Codex.
//
// Unlike Codex's app-server, `claude -p` is a one-shot batch process per
// turn rather than a persistent JSONL protocol. Multi-turn memory is
// recreated with `--resume <session_id>`, using the session id the CLI
// returns from the previous turn's JSON result.

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sanitizeMessage } = require('./text-sanitize.cjs')
const { HEALTH_ASSISTANT_INSTRUCTIONS, READ_ONLY_TOOL_DENYLIST, isAuthFailureMessage } = require('./assistant-provider.cjs')

const DEFAULT_TURN_TIMEOUT_MS = 3 * 60_000
const DEFAULT_MAX_TURNS = 4
const DEFAULT_MAX_HEALTH_CONTEXT_CHARS = 500_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

// Never let a caller widen this. There is intentionally no constructor
// option that can set `--permission-mode` to anything other than `default`,
// and `--dangerously-skip-permissions` must never appear in `spawnArgs`.
const PERMISSION_MODE = 'default'

// Environment variables that would let the CLI bill a pay-per-token API key
// instead of using the interactive subscription login. Stripped from the
// child's environment even if present in the parent process's env.
const API_KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY']

class ClaudeServiceError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ClaudeServiceError'
    this.code = code
  }
}

function serviceError(error, fallback, code) {
  if (error instanceof ClaudeServiceError) return error
  return new ClaudeServiceError(sanitizeMessage(error?.message || fallback), code)
}

function abortError(message = 'The Claude turn was cancelled.') {
  const error = new ClaudeServiceError(message, 'CLAUDE_TURN_CANCELLED')
  error.name = 'AbortError'
  return error
}

function isPathLike(value, pathImpl) {
  return pathImpl.isAbsolute(value) || value.includes('/') || value.includes('\\')
}

function executableExtensions(env, platform) {
  if (platform !== 'win32') return ['']
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  return ['', ...extensions.map((extension) => extension.toLowerCase()), ...extensions.map((extension) => extension.toUpperCase())]
}

function isExecutableFile(candidate, fsImpl, platform) {
  try {
    const mode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
    fsImpl.accessSync(candidate, mode)
    return fsImpl.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function resolveClaudeBinary(options = {}) {
  const env = options.env || process.env
  const fsImpl = options.fs || fs
  const pathImpl = options.path || path
  const platform = options.platform || process.platform
  const home = options.homedir || os.homedir()
  const candidates = []
  const seen = new Set()
  const extensions = executableExtensions(env, platform)

  const add = (candidate) => {
    if (!candidate) return
    const normalized = pathImpl.normalize(String(candidate).replace(/^['"]|['"]$/g, ''))
    if (!seen.has(normalized)) {
      seen.add(normalized)
      candidates.push(normalized)
    }
  }

  const addFromPath = (command) => {
    const pathEntries = String(env.PATH || '').split(pathImpl.delimiter).filter(Boolean)
    for (const entry of pathEntries) {
      const directory = entry.replace(/^['"]|['"]$/g, '')
      for (const extension of extensions) add(pathImpl.join(directory, `${command}${extension}`))
    }
  }

  const explicit = String(env.CLAUDE_BINARY || '').trim()
  if (explicit) {
    if (isPathLike(explicit, pathImpl)) add(pathImpl.resolve(explicit))
    else addFromPath(explicit)
  }

  addFromPath('claude')
  // The npm-distributed CLI (`npm install -g @anthropic-ai/claude-code`) and
  // the native installer both also drop a copy here on macOS/Linux.
  add(pathImpl.join(home, '.claude', 'local', 'claude'))

  return candidates.find((candidate) => isExecutableFile(candidate, fsImpl, platform)) || null
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

function positiveInteger(value, fallback) {
  const n = positiveNumber(value, fallback)
  return Math.max(1, Math.round(n))
}

function serializeHealthContext(value, maxChars) {
  let serialized
  try {
    if (typeof value === 'string') serialized = value.trim()
    else if (value === undefined || value === null) serialized = '{}'
    else serialized = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
  } catch {
    throw new ClaudeServiceError('The health context could not be serialized.', 'CLAUDE_INVALID_HEALTH_CONTEXT')
  }
  if (typeof serialized !== 'string') serialized = String(serialized)
  if (serialized.length > maxChars) {
    throw new ClaudeServiceError(`The compact health context exceeds ${maxChars} characters.`, 'CLAUDE_HEALTH_CONTEXT_TOO_LARGE')
  }
  return serialized
}

function normalizeTurnInput(input, maxContextChars) {
  if (!input || typeof input !== 'object') {
    throw new ClaudeServiceError('startTurn expects an options object.', 'CLAUDE_INVALID_TURN')
  }
  const text = String(input.text || '').trim()
  if (!text) throw new ClaudeServiceError('A non-empty user message is required.', 'CLAUDE_INVALID_TURN')
  const context = serializeHealthContext(input.healthContext ?? input.context, maxContextChars)
  return {
    text,
    context,
    onDelta: typeof input.onDelta === 'function' ? input.onDelta : null,
    onComplete: typeof input.onComplete === 'function' ? input.onComplete : null,
    onError: typeof input.onError === 'function' ? input.onError : null,
    signal: input.signal || null,
  }
}

function stripApiKeyEnv(env) {
  const clean = { ...env }
  for (const key of API_KEY_ENV_VARS) delete clean[key]
  return clean
}

class ClaudeService {
  constructor(options = {}) {
    this.id = 'claude'
    this.label = 'Claude'

    this._spawn = options.spawn || childProcess.spawn
    this._env = stripApiKeyEnv(options.env || process.env)
    this._cwd = options.cwd || process.cwd()
    this._resolveBinary = options.resolveBinary || (() => resolveClaudeBinary({
      env: options.binary ? { ...this._env, CLAUDE_BINARY: options.binary } : this._env,
    }))
    this._turnTimeoutMs = positiveNumber(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS)
    this._maxTurns = positiveInteger(options.maxTurns, DEFAULT_MAX_TURNS)
    this._maxHealthContextChars = positiveNumber(options.maxHealthContextChars, DEFAULT_MAX_HEALTH_CONTEXT_CHARS)
    this._terminationGraceMs = positiveNumber(options.terminationGraceMs, 1_000)
    this._model = options.model || null
    this._instructions = String(options.developerInstructions || HEALTH_ASSISTANT_INSTRUCTIONS)
    this._disallowedTools = Array.isArray(options.disallowedTools) && options.disallowedTools.length
      ? options.disallowedTools
      : READ_ONLY_TOOL_DENYLIST
    this._onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null

    this._state = 'idle'
    this._lastError = null
    this._binaryPath = null
    this._binaryResolutionAttempted = false
    this._sessionId = null
    this._active = null
    this._disposed = false
  }

  getStatus() {
    const available = this._binaryResolutionAttempted ? Boolean(this._binaryPath) : null
    return {
      provider: this.id,
      state: this._state,
      available,
      connected: Boolean(this._sessionId),
      authenticated: Boolean(available && !isAuthFailureMessage(this._lastError)),
      busy: Boolean(this._active),
      threadId: this._sessionId,
      turnId: this._active?.turnId || null,
      lastError: this._lastError,
      version: null,
    }
  }

  async start() {
    this._assertUsable()
    await this._probeBinary()
    return this.getStatus()
  }

  startTurn(input) {
    let normalized
    try {
      this._assertUsable()
      if (this._active) throw new ClaudeServiceError('A Claude turn is already running.', 'CLAUDE_TURN_IN_PROGRESS')
      normalized = normalizeTurnInput(input, this._maxHealthContextChars)
    } catch (error) {
      return Promise.reject(error)
    }

    const deferred = {}
    const promise = new Promise((resolve, reject) => { deferred.resolve = resolve; deferred.reject = reject })
    const active = {
      ...normalized,
      deferred,
      turnId: crypto.randomUUID(),
      child: null,
      stdout: '',
      stderr: '',
      timer: null,
      abortHandler: null,
      settled: false,
    }
    this._active = active
    this._setState('starting')

    if (active.signal && !active.signal.aborted && typeof active.signal.addEventListener === 'function') {
      active.abortHandler = () => this._killActive(active, abortError())
      active.signal.addEventListener('abort', active.abortHandler, { once: true })
    }

    void this._runTurn(active)
    return promise
  }

  async cancelTurn() {
    const active = this._active
    if (!active) return false
    this._killActive(active, abortError())
    return true
  }

  async reset() {
    this._assertUsable()
    if (this._active) this._killActive(this._active, abortError('The Claude conversation was reset.'))
    this._sessionId = null
    this._setState(this._binaryPath ? 'ready' : 'idle')
    return this.getStatus()
  }

  async dispose() {
    if (this._disposed) return
    this._disposed = true
    if (this._active) this._killActive(this._active, abortError('The Claude service was disposed.'))
    this._setState('disposed')
  }

  _assertUsable() {
    if (this._disposed) throw new ClaudeServiceError('The Claude service has been disposed.', 'CLAUDE_DISPOSED')
  }

  async _probeBinary() {
    if (this._binaryResolutionAttempted) return this._binaryPath
    this._binaryResolutionAttempted = true
    try {
      this._binaryPath = await this._resolveBinary() || null
    } catch {
      this._binaryPath = null
    }
    if (!this._binaryPath) {
      const error = new ClaudeServiceError(
        'Claude CLI was not found. Install it with `npm install -g @anthropic-ai/claude-code` and run `claude login`, or set CLAUDE_BINARY.',
        'CLAUDE_BINARY_NOT_FOUND',
      )
      this._setState('error', error)
      throw error
    }
    this._setState('ready')
    return this._binaryPath
  }

  async _runTurn(active) {
    try {
      const binary = await this._probeBinary()
      if (this._active !== active) return

      const args = this._buildArgs()
      let child
      try {
        child = this._spawn(binary, args, {
          cwd: this._cwd,
          env: this._env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        const code = /^[A-Z0-9_-]+$/i.test(String(error?.code || '')) ? ` (${error.code})` : ''
        throw new ClaudeServiceError(`Could not start the Claude CLI${code}.`, 'CLAUDE_SPAWN_FAILED')
      }
      if (this._active !== active) {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        return
      }
      active.child = child
      this._setState('running')
      this._armTimeout(active)

      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', (chunk) => {
        if (active.stdout.length < MAX_OUTPUT_BYTES) active.stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        if (active.stderr.length < MAX_OUTPUT_BYTES) active.stderr += chunk
      })

      const prompt = `<OPENFIT_HEALTH_CONTEXT>\n${active.context}\n</OPENFIT_HEALTH_CONTEXT>\n\n${active.text}`
      try {
        child.stdin.end(prompt, 'utf8')
      } catch {
        // If stdin is already gone the exit handler below reports the failure.
      }

      const exit = await new Promise((resolve) => {
        child.once('error', (error) => resolve({ error }))
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      if (this._active !== active) return
      clearTimeout(active.timer)

      if (exit.error) {
        const code = /^[A-Z0-9_-]+$/i.test(String(exit.error.code || '')) ? ` (${exit.error.code})` : ''
        throw new ClaudeServiceError(`Could not run the Claude CLI${code}.`, 'CLAUDE_SPAWN_FAILED')
      }
      if (active.cancelled) throw abortError()

      const result = this._parseResult(active, exit.code)
      this._sessionId = result.threadId || this._sessionId
      this._finishSuccess(active, result)
    } catch (error) {
      if (this._active === active) this._finishError(active, error)
    }
  }

  _buildArgs() {
    const args = [
      '-p',
      '--output-format', 'json',
      '--permission-mode', PERMISSION_MODE,
      '--max-turns', String(this._maxTurns),
      '--disallowed-tools', this._disallowedTools.join(','),
      '--append-system-prompt', this._instructions,
    ]
    if (this._sessionId) args.push('--resume', this._sessionId)
    if (this._model) args.push('--model', this._model)
    return args
  }

  _parseResult(active, exitCode) {
    let parsed = null
    try {
      parsed = JSON.parse(active.stdout)
    } catch {
      parsed = null
    }

    if (!parsed || typeof parsed !== 'object') {
      const stderrHint = sanitizeMessage(active.stderr, '')
      if (isAuthFailureMessage(stderrHint) || isAuthFailureMessage(active.stdout)) {
        throw new ClaudeServiceError('Claude is not logged in. Run `claude login` (or `claude setup-token`) in a terminal, then try again.', 'CLAUDE_UNAUTHENTICATED')
      }
      throw new ClaudeServiceError(
        exitCode ? `The Claude CLI exited with code ${exitCode}.` : 'The Claude CLI returned an unreadable response.',
        'CLAUDE_PROTOCOL_ERROR',
      )
    }

    if (parsed.is_error) {
      const message = sanitizeMessage(parsed.result || parsed.error || active.stderr, 'The Claude turn failed.')
      const code = isAuthFailureMessage(message) ? 'CLAUDE_UNAUTHENTICATED' : 'CLAUDE_TURN_FAILED'
      throw new ClaudeServiceError(message, code)
    }

    const text = typeof parsed.result === 'string' ? parsed.result : ''
    return {
      threadId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      turnId: active.turnId,
      status: 'completed',
      text,
      meta: {
        turnsUsed: Number.isFinite(parsed.num_turns) ? parsed.num_turns : null,
        durationMs: Number.isFinite(parsed.duration_ms) ? parsed.duration_ms : null,
        costUsd: Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : null,
      },
    }
  }

  _armTimeout(active) {
    active.timer = setTimeout(() => {
      if (this._active !== active) return
      this._killActive(active, new ClaudeServiceError('The Claude turn timed out.', 'CLAUDE_TURN_TIMEOUT'))
    }, this._turnTimeoutMs)
    active.timer.unref?.()
  }

  _killActive(active, error) {
    if (active.settled) return
    active.cancelled = true
    clearTimeout(active.timer)
    if (active.child) {
      try { active.child.kill('SIGTERM') } catch { /* already exited */ }
      const child = active.child
      const timer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          try { child.kill('SIGKILL') } catch { /* already exited */ }
        }
      }, this._terminationGraceMs)
      timer.unref?.()
    } else {
      this._finishError(active, error)
    }
  }

  _cleanupActive(active) {
    active.settled = true
    clearTimeout(active.timer)
    if (active.signal && active.abortHandler && typeof active.signal.removeEventListener === 'function') {
      active.signal.removeEventListener('abort', active.abortHandler)
    }
    if (this._active === active) this._active = null
  }

  _finishSuccess(active, result) {
    if (active.settled) return
    this._cleanupActive(active)
    this._setState('ready')
    // Claude's `-p --output-format json` only returns the full answer once
    // the process exits (no token-level streaming), so the whole response is
    // delivered as a single delta immediately before completion. This keeps
    // the same onDelta→onComplete shape Codex uses without the caller (see
    // main.cjs) needing to know which provider produced it.
    if (result.text && active.onDelta) { try { active.onDelta(result.text, { threadId: result.threadId, turnId: active.turnId }) } catch { /* consumer error is not our problem */ } }
    if (active.onComplete) { try { active.onComplete(result) } catch { /* consumer error is not our problem */ } }
    active.deferred.resolve(result)
  }

  _finishError(active, error) {
    if (active.settled) return
    const safe = serviceError(error, 'The Claude turn failed.', 'CLAUDE_TURN_FAILED')
    this._cleanupActive(active)
    this._setState(this._binaryPath ? 'ready' : 'error', safe)
    if (active.onError) { try { active.onError(safe) } catch { /* consumer error is not our problem */ } }
    active.deferred.reject(safe)
  }

  _setState(state, error) {
    this._state = state
    if (error) this._lastError = sanitizeMessage(error.message)
    else if (state === 'idle' || state === 'ready' || state === 'running') this._lastError = null
    if (this._onStatusChange) { try { this._onStatusChange(this.getStatus()) } catch { /* listener error is not our problem */ } }
  }
}

function createClaudeService(options) {
  return new ClaudeService(options)
}

module.exports = {
  ClaudeService,
  ClaudeServiceError,
  createClaudeService,
  resolveClaudeBinary,
  __test: {
    normalizeTurnInput,
    serializeHealthContext,
  },
}
