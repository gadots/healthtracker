import { describe, expect, it } from 'vitest'
import { normalizeFitbitData } from '@/data/normalize'
import type { RawFitbitPayload } from '@/types'
// @ts-expect-error -- plain ESM modules without type declarations
import { createMockPayload } from './mock-provider.mjs'
// @ts-expect-error -- plain ESM modules without type declarations
import { assertUsefulPayload } from './health-sync.mjs'

/**
 * The mock provider stands in for Google Health in local runs, so it has to
 * survive the same pipeline as the real thing: the quality gate, then
 * normalization into the model every view reads.
 */
describe('mock provider payload', () => {
  const payload = createMockPayload('2026-03-12') as RawFitbitPayload

  it('passes the same quality gate as a real sync', () => {
    expect(() => assertUsefulPayload(payload)).not.toThrow()
  })

  it('reports pre-translation Google job keys in requestStats', () => {
    // The real adapter reports the job keys, not the translated endpoint keys.
    expect(payload.requestStats?.successfulKeys).toContain('stepsDaily')
    expect(payload.requestStats?.successfulKeys).not.toContain('stepsTrend')
  })

  it('normalizes into a dashboard with real activity, sleep and body values', () => {
    const data = normalizeFitbitData(payload)

    expect(data.selectedDate).toBe('2026-03-12')
    expect(data.activity.steps).toBeGreaterThan(0)
    expect(data.activity.stepsGoal).toBe(10_000)
    expect(data.activity.stepsIntraday.length).toBe(24)
    expect(data.health.restingHeartRate).toBeGreaterThan(0)
    expect(data.health.heartRateIntraday.length).toBeGreaterThan(0)
    expect(data.sleep.totalMinutes).toBe(413)
    expect(data.sleep.stages.reduce((sum, stage) => sum + stage.minutes, 0)).toBeGreaterThan(0)
    expect(data.body.weightKg).toBeGreaterThan(0)
    expect(data.profile.displayName).toBe('Demo Account')
    expect(data.device?.name).toBe('Fitbit Air')
  })

  it('builds a 14-day trend series the charts can plot', () => {
    const data = normalizeFitbitData(payload)
    expect(data.trends.length).toBeGreaterThanOrEqual(14)
    expect(data.trends.at(-1)?.date).toBe('2026-03-12')
    expect(data.trends.some((point) => point.steps !== null)).toBe(true)
    expect(data.trends.some((point) => point.restingHeartRate !== null)).toBe(true)
  })

  it('is deterministic for a given date', () => {
    const again = createMockPayload('2026-03-12') as RawFitbitPayload
    expect(again.endpoints).toEqual(payload.endpoints)
  })
})
