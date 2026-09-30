import { describe, expect, it } from 'vitest'
import { normalizeFitbitData } from '@/data/normalize'
import { computeDayStrain, computeSleepConsistency, estimateMaxHeartRate } from '@/lib/scores'
import type { DashboardData, RawFitbitPayload } from '@/types'
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
    expect(data.sleep.totalMinutes).toBeGreaterThan(240)
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

/**
 * The derived scores read variation, not just presence, so the generator has
 * obligations beyond "every field is populated". Each case here failed before
 * the generator was rewritten.
 */
describe('mock provider feeds the derived scores', () => {
  const dates = Array.from({ length: 14 }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`)
  const days: DashboardData[] = dates.map((date) => normalizeFitbitData(createMockPayload(date) as RawFitbitPayload))
  const today = days.at(-1) as DashboardData
  const archive = days.slice(0, -1)

  it('samples heart rate every 5 minutes for a full day', () => {
    // Day Strain credits every sample with the series' average spacing, so a
    // coarser interval multiplies each zone minute. 288 is also what
    // compactIntraday() caps real Google data at.
    expect(today.health.heartRateIntraday.length).toBe(288)
    const [first, second] = today.health.heartRateIntraday
    expect(first.time).toBe('00:00')
    expect(second.time).toBe('00:05')
  })

  it('keeps every day peaking well above its own waking baseline', () => {
    // The personalized maximum is the highest reading seen. When a single day
    // is synced with no archive behind it, that day's own peak is the ceiling
    // the zones are measured against, and a low one prices ordinary waking
    // minutes as zone minutes.
    for (const day of days) {
      expect(day.health.heartRateMax).toBeGreaterThan(144)
    }
  })

  it('does not pin Day Strain at its ceiling, archive or not', () => {
    const withArchive = days.map((day, index) => computeDayStrain(day, days.slice(0, index)).value)
    const alone = days.map((day) => computeDayStrain(day, []).value)

    for (const value of [...withArchive, ...alone]) {
      expect(value).not.toBeNull()
      expect(value as number).toBeLessThan(21)
    }
    // And it has to actually move between days, not just sit below the cap.
    expect(new Set(withArchive).size).toBeGreaterThan(6)
  })

  it('varies vitals by date instead of repeating one day', () => {
    const distinct = (values: Array<number | null>) => new Set(values.filter((value) => value !== null)).size
    expect(distinct(days.map((day) => day.health.hrvMs))).toBeGreaterThan(6)
    expect(distinct(days.map((day) => day.health.spo2))).toBeGreaterThan(6)
    expect(distinct(days.map((day) => day.health.breathingRate))).toBeGreaterThan(6)
    expect(distinct(days.map((day) => day.sleep.totalMinutes))).toBeGreaterThan(6)
  })

  it('shifts bedtimes enough that Sleep Consistency is earned', () => {
    const bedtimes = new Set(days.map((day) => day.sleep.startTime?.slice(11, 16)))
    expect(bedtimes.size).toBeGreaterThan(6)
    // A generator that repeats one night reports a flawless 100 out of nothing.
    const consistency = computeSleepConsistency(today, archive)
    expect(consistency?.percent).toBeLessThan(100)
    expect(consistency?.percent).toBeGreaterThan(50)
  })

  it('reports a plausible personalized maximum heart rate', () => {
    const estimate = estimateMaxHeartRate(today, archive)
    expect(estimate.bpm).toBeGreaterThan(150)
    expect(estimate.bpm).toBeLessThan(205)
    expect(estimate.isTodayOnly).toBe(false)
  })

  it('records naps on some days and not others', () => {
    const napCounts = days.map((day) => day.sleep.naps.length)
    expect(napCounts.some((count) => count > 0)).toBe(true)
    expect(napCounts.some((count) => count === 0)).toBe(true)
  })
})
