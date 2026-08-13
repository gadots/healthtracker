'use strict'

// Provider-agnostic orchestrator sitting between main.cjs and the two
// AssistantProvider adapters (codex-service.cjs, claude-service.cjs). main.cjs
// and the renderer only ever talk to this manager, never to a specific
// provider class, so adding a third provider later never touches the IPC
// surface or the UI's chat logic.
//
// Responsibilities beyond simple delegation:
//   - remembers which provider the user picked (Claude by default);
//   - falls back to the other provider automatically when the active one is
//     unavailable/unauthenticated and nothing has streamed to the user yet;
//   - caches identical questions asked about unchanged health data so a
//     repeat question doesn't spend another turn of the subscription;
//   - keeps a local, in-memory, per-provider usage log (turns, cache hits,
//     failures, and — for Claude — the CLI's own turn/cost/duration numbers).

const { hashTurnRequest } = require('./assistant-provider.cjs')

const DEFAULT_CACHE_TTL_MS = 10 * 60_000
const DEFAULT_CACHE_LIMIT = 50
const DEFAULT_USAGE_LOG_LIMIT = 200

const AVAILABILITY_ERROR_CODES = new Set([
  'CODEX_BINARY_NOT_FOUND',
  'CLAUDE_BINARY_NOT_FOUND',
  'CLAUDE_UNAUTHENTICATED',
  'CODEX_DISPOSED',
  'CLAUDE_DISPOSED',
  'CODEX_NOT_CONNECTED',
])

function isAvailabilityError(error) {
  return Boolean(error && AVAILABILITY_ERROR_CODES.has(error.code))
}

function emptySummary() {
  return { turnsStarted: 0, turnsCompleted: 0, turnsFailed: 0, cacheHits: 0, totalDurationMs: 0, lastUsedAt: null }
}

class AssistantManager {
  /**
   * @param {Object} options
   * @param {Array<{id: string, provider: object}>} options.providers - ordered list, first is the default
   * @param {string} [options.defaultProviderId]
   * @param {(id: string) => void} [options.onProviderChange] - persistence hook, called after a successful switch
   * @param {boolean} [options.autoFallback]
   * @param {number} [options.cacheTtlMs]
   */
  constructor(options = {}) {
    const providers = options.providers || []
    if (!providers.length) throw new Error('AssistantManager requires at least one provider.')
    this._providers = new Map(providers.map((entry) => [entry.id, entry.provider]))
    this._order = providers.map((entry) => entry.id)
    this._onProviderChange = typeof options.onProviderChange === 'function' ? options.onProviderChange : null
    this._autoFallback = options.autoFallback !== false
    this._cacheTtlMs = Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs > 0 ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS
    this._cacheLimit = Number.isFinite(options.cacheLimit) && options.cacheLimit > 0 ? options.cacheLimit : DEFAULT_CACHE_LIMIT

    const requestedDefault = options.defaultProviderId
    this._activeProviderId = this._providers.has(requestedDefault) ? requestedDefault : this._order[0]

    this._cache = new Map()
    this._usageLog = []
    this._usageSummary = new Map(this._order.map((id) => [id, emptySummary()]))
    this._lastFallback = null
    this._currentAttemptProviderId = null
  }

  listProviders() {
    return this._order.map((id) => ({ id, label: this._providers.get(id).label || id }))
  }

  getActiveProviderId() {
    return this._activeProviderId
  }

  setActiveProvider(id) {
    if (!this._providers.has(id)) throw new Error(`Unknown assistant provider: ${id}`)
    this._activeProviderId = id
    this._lastFallback = null
    if (this._onProviderChange) { try { this._onProviderChange(id) } catch { /* persistence failure surfaces via getStatus() staying stale, not fatal */ } }
    return this.getStatus()
  }

  getStatus() {
    const providers = {}
    for (const [id, provider] of this._providers) providers[id] = provider.getStatus()
    return {
      activeProvider: this._activeProviderId,
      providers,
      lastFallback: this._lastFallback,
    }
  }

  getUsageLog(limit = 50) {
    const summary = {}
    for (const [id, value] of this._usageSummary) summary[id] = { ...value }
    return {
      summary,
      entries: this._usageLog.slice(-Math.max(1, Math.min(limit, this._usageLog.length || 1))),
    }
  }

  async startTurn(input) {
    const primaryId = this._activeProviderId
    const primary = this._providers.get(primaryId)
    if (!primary) throw new Error(`Unknown assistant provider: ${primaryId}`)

    const cacheKey = hashTurnRequest(primaryId, input.text, input.healthContext)
    const cached = this._readCache(cacheKey)
    if (cached) {
      this._recordUsage(primaryId, { ok: true, durationMs: 0, cacheHit: true })
      if (input.onDelta && cached.text) { try { input.onDelta(cached.text, { cacheHit: true }) } catch { /* consumer error is not our problem */ } }
      return { ...cached, provider: primaryId, cacheHit: true }
    }

    try {
      const result = await this._attempt(primary, primaryId, input)
      this._writeCache(hashTurnRequest(primaryId, input.text, input.healthContext), result)
      return { ...result, provider: primaryId }
    } catch (error) {
      const fallbackId = this._order.find((id) => id !== primaryId)
      const fallback = fallbackId ? this._providers.get(fallbackId) : null
      if (this._autoFallback && fallback && isAvailabilityError(error) && !error.partialOutput) {
        const result = await this._attempt(fallback, fallbackId, input)
        this._lastFallback = { from: primaryId, to: fallbackId, reason: error.message || String(error), at: Date.now() }
        this._writeCache(hashTurnRequest(fallbackId, input.text, input.healthContext), result)
        return { ...result, provider: fallbackId, fallbackFrom: primaryId }
      }
      throw error
    }
  }

  async _attempt(provider, providerId, input) {
    const startedAt = Date.now()
    let producedOutput = false
    this._currentAttemptProviderId = providerId
    const onDelta = (delta, meta) => {
      producedOutput = producedOutput || Boolean(delta)
      if (input.onDelta) { try { input.onDelta(delta, meta) } catch { /* consumer error is not our problem */ } }
    }
    try {
      const result = await provider.startTurn({ ...input, onDelta })
      this._recordUsage(providerId, { ok: true, durationMs: Date.now() - startedAt, meta: result.meta })
      return result
    } catch (error) {
      this._recordUsage(providerId, { ok: false, durationMs: Date.now() - startedAt, error })
      // Mark so the caller never silently discards output the user already saw.
      error.partialOutput = producedOutput
      throw error
    } finally {
      if (this._currentAttemptProviderId === providerId) this._currentAttemptProviderId = null
    }
  }

  async cancelTurn() {
    const id = this._currentAttemptProviderId
    if (!id) return false
    return this._providers.get(id).cancelTurn()
  }

  async reset() {
    await Promise.all(this._order.map((id) => this._providers.get(id).reset().catch(() => null)))
    this._lastFallback = null
    return this.getStatus()
  }

  async dispose() {
    await Promise.all(this._order.map((id) => this._providers.get(id).dispose().catch(() => null)))
  }

  _readCache(key) {
    const entry = this._cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this._cacheTtlMs) {
      this._cache.delete(key)
      return null
    }
    return entry.result
  }

  _writeCache(key, result) {
    this._cache.set(key, { result, at: Date.now() })
    if (this._cache.size > this._cacheLimit) {
      const oldestKey = this._cache.keys().next().value
      this._cache.delete(oldestKey)
    }
  }

  _recordUsage(providerId, { ok, durationMs, cacheHit = false, meta = null, error = null }) {
    const summary = this._usageSummary.get(providerId) || emptySummary()
    summary.turnsStarted += 1
    if (cacheHit) summary.cacheHits += 1
    else if (ok) summary.turnsCompleted += 1
    else summary.turnsFailed += 1
    summary.totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0
    summary.lastUsedAt = new Date().toISOString()
    this._usageSummary.set(providerId, summary)

    this._usageLog.push({
      provider: providerId,
      at: summary.lastUsedAt,
      ok,
      cacheHit,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      turnsUsed: meta?.turnsUsed ?? null,
      costUsd: meta?.costUsd ?? null,
      error: error ? String(error.message || error).slice(0, 300) : null,
    })
    if (this._usageLog.length > DEFAULT_USAGE_LOG_LIMIT) this._usageLog.splice(0, this._usageLog.length - DEFAULT_USAGE_LOG_LIMIT)
  }
}

function createAssistantManager(options) {
  return new AssistantManager(options)
}

module.exports = { AssistantManager, createAssistantManager, isAvailabilityError }
