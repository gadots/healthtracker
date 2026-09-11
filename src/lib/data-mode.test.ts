import { describe, expect, it } from 'vitest'
import { resolveDataMode } from './data-mode'

const base = { preference: 'live', connected: true, provider: 'google-health', source: 'google-health' } as const

describe('resolveDataMode', () => {
  it('reports live when connected and not forced to demo', () => {
    const state = resolveDataMode(base)
    expect(state).toMatchObject({ mode: 'live', forced: false, tone: 'live', canUseLive: true })
    expect(state.label).toBe('Live · Google Health')
  })

  it('names the legacy provider', () => {
    expect(resolveDataMode({ ...base, provider: 'fitbit-legacy' }).label).toBe('Live · Fitbit legacy')
  })

  it('honours a forced demo preference while the account stays connected', () => {
    const state = resolveDataMode({ ...base, preference: 'demo' })
    expect(state).toMatchObject({ mode: 'demo', forced: true, tone: 'demo', canUseLive: true })
    expect(state.detail).toContain('live sync is paused')
  })

  it('never reports live while the preference is demo', () => {
    for (const connected of [true, false]) {
      for (const source of ['demo', 'cache', 'google-health'] as const) {
        expect(resolveDataMode({ ...base, preference: 'demo', connected, source }).mode).toBe('demo')
      }
    }
  })

  it('shows demo, not forced, when there is no connection at all', () => {
    const state = resolveDataMode({ ...base, preference: 'demo', connected: false })
    expect(state).toMatchObject({ mode: 'demo', forced: false, canUseLive: false })
    expect(state.detail).toContain('Connect a provider')
  })

  it('distinguishes a disconnected cache from demo', () => {
    const state = resolveDataMode({ ...base, connected: false, source: 'cache' })
    expect(state).toMatchObject({ tone: 'cache', canUseLive: false })
    expect(state.label).toBe('Local cache')
  })

  it('falls back to demo when disconnected with no cached payload', () => {
    const state = resolveDataMode({ ...base, connected: false, source: 'demo' })
    expect(state).toMatchObject({ mode: 'demo', tone: 'demo', canUseLive: false })
  })

  it('blocks choosing live whenever no account is connected', () => {
    for (const preference of ['live', 'demo'] as const) {
      expect(resolveDataMode({ ...base, preference, connected: false }).canUseLive).toBe(false)
    }
  })
})
