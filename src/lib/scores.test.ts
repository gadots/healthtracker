import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import type { DashboardData, TimePoint } from '@/types'
import {
  buildHealthMonitor,
  computeDailyHeartRateZones,
  computeDayStrain,
  computeRecoveryScore,
  computeSleepPerformance,
  estimateMaxHeartRate,
  mergedDayHistory,
} from './scores'

function withHeartRateMax(data: DashboardData, heartRateMax: number | null): DashboardData {
  return { ...data, health: { ...data.health, heartRateMax } }
}

function flatHeartSeries(value: number, count: number, stepMinutes: number): TimePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const totalMinutes = index * stepMinutes
    const time = `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
    return { time, value }
  })
}

describe('mergedDayHistory', () => {
  it('lets the currently viewed day win over a stale cached copy of the same date', () => {
    const archived = createDemoData('2026-06-20')
    const stale = { ...archived, health: { ...archived.health, restingHeartRate: 999 } }
    const current = createDemoData('2026-06-20')

    const merged = mergedDayHistory(current, [stale])

    expect(merged).toHaveLength(1)
    expect(merged[0].health.restingHeartRate).toBe(current.health.restingHeartRate)
  })

  it('sorts chronologically', () => {
    const day1 = createDemoData('2026-06-18')
    const day2 = createDemoData('2026-06-20')
    const day3 = createDemoData('2026-06-19')

    const merged = mergedDayHistory(day2, [day1, day3])

    expect(merged.map((day) => day.selectedDate)).toEqual(['2026-06-18', '2026-06-19', '2026-06-20'])
  })
})

describe('estimateMaxHeartRate', () => {
  it('falls back to today only when there is no cached archive', () => {
    const data = withHeartRateMax(createDemoData('2026-06-22'), 171)
    const estimate = estimateMaxHeartRate(data, [])

    expect(estimate).toMatchObject({ bpm: 171, observedAt: '2026-06-22', sampleDays: 1, isTodayOnly: true })
  })

  it('ratchets up when a higher reading appears in the archive, never down', () => {
    const data = withHeartRateMax(createDemoData('2026-06-22'), 165)
    const archive = [withHeartRateMax(createDemoData('2026-06-20'), 182), withHeartRateMax(createDemoData('2026-06-21'), 170)]

    const estimate = estimateMaxHeartRate(data, archive)

    expect(estimate).toMatchObject({ bpm: 182, observedAt: '2026-06-20', sampleDays: 3, isTodayOnly: false })
  })

  it('returns null with no heart rate data anywhere', () => {
    const data = withHeartRateMax(createDemoData('2026-06-22'), null)
    expect(estimateMaxHeartRate(data, []).bpm).toBeNull()
  })
})

describe('buildHealthMonitor', () => {
  it('flags a value far outside the personal baseline and hides metrics with no value', () => {
    const data = createDemoData('2026-06-22')
    // Force a resting heart rate far above the trend history that compareWithPersonalBaseline uses.
    const spiked: DashboardData = {
      ...data,
      health: { ...data.health, restingHeartRate: 130, hrvMs: null },
    }

    const panel = buildHealthMonitor(spiked)
    const rhr = panel.metrics.find((metric) => metric.key === 'restingHeartRate')

    expect(rhr?.flag).toBe('above-range')
    expect(panel.metrics.some((metric) => metric.key === 'hrv')).toBe(false)
    expect(panel.hasFlags).toBe(true)
  })

  it('marks a metric insufficient-data with too few baseline samples', () => {
    const data = createDemoData('2026-06-22')
    const thin: DashboardData = { ...data, trends: data.trends.slice(-1) }

    const panel = buildHealthMonitor(thin)
    expect(panel.metrics.every((metric) => metric.flag === 'insufficient-data')).toBe(true)
    expect(panel.hasFlags).toBe(false)
  })
})

describe('computeDailyHeartRateZones / computeDayStrain', () => {
  it('returns null without enough intraday coverage', () => {
    const data = withHeartRateMax(createDemoData('2026-06-22'), 180)
    const sparse: DashboardData = { ...data, health: { ...data.health, heartRateIntraday: flatHeartSeries(90, 3, 30) } }

    expect(computeDailyHeartRateZones(sparse, [])).toBeNull()
    expect(computeDayStrain(sparse, []).value).toBeNull()
  })

  it('returns null without a max heart rate estimate', () => {
    const data = withHeartRateMax(createDemoData('2026-06-22'), null)
    expect(computeDailyHeartRateZones(data, [])).toBeNull()
  })

  it('buckets a full day of near-max effort into the peak zone and produces a high strain score', () => {
    const base = withHeartRateMax(createDemoData('2026-06-22'), 180)
    const allOut: DashboardData = { ...base, health: { ...base.health, heartRateIntraday: flatHeartSeries(171, 288, 5) } }

    const zones = computeDailyHeartRateZones(allOut, [])
    expect(zones?.zones.peak).toBeGreaterThan(1000)
    expect(zones?.zones.light).toBe(0)

    const strain = computeDayStrain(allOut, [])
    expect(strain.value).not.toBeNull()
    expect(strain.value!).toBeGreaterThan(0)
    expect(strain.value!).toBeLessThanOrEqual(21)
    expect(strain.band).toBe('all-out')
  })

  it('reports a light day as low strain, not null', () => {
    const base = withHeartRateMax(createDemoData('2026-06-22'), 180)
    const resting: DashboardData = { ...base, health: { ...base.health, heartRateIntraday: flatHeartSeries(70, 288, 5) } }

    const strain = computeDayStrain(resting, [])
    expect(strain.value).toBe(0)
    expect(strain.band).toBe('light')
  })
})

describe('computeSleepPerformance', () => {
  it('is null without a recorded sleep duration', () => {
    const data = createDemoData('2026-06-22')
    const noSleep: DashboardData = { ...data, sleep: { ...data.sleep, totalMinutes: null } }
    expect(computeSleepPerformance(noSleep).percent).toBeNull()
  })

  it('computes a percentage of the sleep need and bands it', () => {
    const data = createDemoData('2026-06-22')
    const full: DashboardData = { ...data, sleep: { ...data.sleep, totalMinutes: 460, goalMinutes: 480 } }

    const result = computeSleepPerformance(full)
    expect(result.percent).toBe(96)
    expect(result.band).toBe('excellent')
  })

  it('accepts an externally supplied need (for the Tier 3 dynamic Sleep Need)', () => {
    const data = createDemoData('2026-06-22')
    const short: DashboardData = { ...data, sleep: { ...data.sleep, totalMinutes: 300, goalMinutes: 480 } }

    const result = computeSleepPerformance(short, 400)
    expect(result.percent).toBe(75)
    expect(result.neededMinutes).toBe(400)
  })
})

describe('computeRecoveryScore', () => {
  it('is hidden with fewer than 2 usable components', () => {
    const data = createDemoData('2026-06-22')
    const thin: DashboardData = { ...data, trends: data.trends.slice(-1) }
    const sleepPerformance = computeSleepPerformance({ ...thin, sleep: { ...thin.sleep, totalMinutes: null } })

    const recovery = computeRecoveryScore(thin, sleepPerformance)
    expect(recovery.value).toBeNull()
    expect(recovery.band).toBeNull()
  })

  it('produces a 0-100 score when enough components have history', () => {
    const data = createDemoData('2026-06-22')
    const sleepPerformance = computeSleepPerformance(data)

    const recovery = computeRecoveryScore(data, sleepPerformance)
    expect(recovery.value).not.toBeNull()
    expect(recovery.value!).toBeGreaterThanOrEqual(0)
    expect(recovery.value!).toBeLessThanOrEqual(100)
    expect(['low', 'moderate', 'high']).toContain(recovery.band)
  })
})
