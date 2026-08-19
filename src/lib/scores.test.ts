import { describe, expect, it } from 'vitest'
import { createDemoArchive, createDemoData } from '@/data/demo'
import type { DashboardData, TimePoint } from '@/types'
import {
  buildHealthMonitor,
  computeDailyHeartRateZones,
  computeDayStrain,
  computeDynamicSleepPerformance,
  computeRecoveryScore,
  computeSleepConsistency,
  computeSleepDebt,
  computeSleepNeed,
  computeSleepPerformance,
  computeWeeklyAssessment,
  estimateMaxHeartRate,
  mergedDayHistory,
} from './scores'

function withHeartRateMax(data: DashboardData, heartRateMax: number | null): DashboardData {
  return { ...data, health: { ...data.health, heartRateMax } }
}

function withSleepTimes(data: DashboardData, startTime: string, endTime: string): DashboardData {
  return { ...data, sleep: { ...data.sleep, startTime, endTime } }
}

function archiveWithSleepTimes(dates: string[], bedClock: string, wakeClock: string): DashboardData[] {
  return dates.map((date) => withSleepTimes(createDemoData(date), `${date}T${bedClock}:00`, `${date}T${wakeClock}:00`))
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

describe('computeSleepDebt', () => {
  it('is null with fewer than 7 nights of trend data', () => {
    const data = createDemoData('2026-06-22')
    const thin: DashboardData = { ...data, trends: data.trends.slice(-3) }
    expect(computeSleepDebt(thin).minutes).toBeNull()
  })

  it('sums the shortfall against the need across the trailing nights', () => {
    const data = createDemoData('2026-06-22')
    const nights = data.trends.slice(-7).map((point) => ({ ...point, sleepMinutes: 400 }))
    const data7: DashboardData = { ...data, trends: [...data.trends.slice(0, -7), ...nights] }

    const debt = computeSleepDebt(data7, 480, 7)
    expect(debt.nightsCounted).toBe(7)
    expect(debt.minutes).toBe(7 * 80)
  })

  it('never counts a well-rested night as negative debt', () => {
    const data = createDemoData('2026-06-22')
    const nights = data.trends.slice(-7).map((point) => ({ ...point, sleepMinutes: 600 }))
    const data7: DashboardData = { ...data, trends: [...data.trends.slice(0, -7), ...nights] }

    expect(computeSleepDebt(data7, 480, 7).minutes).toBe(0)
  })
})

describe('computeSleepNeed', () => {
  it('defers to the static goal (returns null) without enough debt history', () => {
    const data = createDemoData('2026-06-22')
    const thin: DashboardData = { ...data, trends: data.trends.slice(-3) }
    const strain = computeDayStrain(thin, [])
    const debt = computeSleepDebt(thin)

    const need = computeSleepNeed(thin, strain, debt)
    expect(need.neededMinutes).toBeNull()
  })

  it('raises the need above baseline after real debt and high strain, and credits naps', () => {
    const data = createDemoData('2026-06-22')
    const shortNights = data.trends.slice(-7).map((point) => ({ ...point, sleepMinutes: 350 }))
    const strained: DashboardData = {
      ...data,
      sleep: { ...data.sleep, goalMinutes: 480, naps: [{ id: 'n', date: data.selectedDate, startTime: 't', endTime: 't', durationMinutes: 20 }] },
      trends: [...data.trends.slice(0, -7), ...shortNights],
    }
    const strain = { value: 18, band: 'all-out' as const, zones: { light: 0, moderate: 0, vigorous: 0, peak: 200 } }
    const debt = computeSleepDebt(strained)

    const need = computeSleepNeed(strained, strain, debt)
    expect(need.neededMinutes).not.toBeNull()
    expect(need.neededMinutes!).toBeGreaterThan(480)
    expect(need.napCreditMinutes).toBe(20)
  })
})

describe('computeDynamicSleepPerformance', () => {
  it('falls back to the static goal when there is not enough debt history', () => {
    const data = createDemoData('2026-06-22')
    const thin: DashboardData = { ...data, trends: data.trends.slice(-3), sleep: { ...data.sleep, totalMinutes: 460, goalMinutes: 480 } }

    const dynamic = computeDynamicSleepPerformance(thin, [])
    const staticResult = computeSleepPerformance(thin)
    expect(dynamic.percent).toBe(staticResult.percent)
  })
})

describe('computeSleepConsistency', () => {
  it('is null with fewer than 4 nights of bed/wake data', () => {
    const data = createDemoData('2026-06-22')
    const archive = archiveWithSleepTimes(['2026-06-19', '2026-06-20'], '23:00', '07:00')
    expect(computeSleepConsistency(data, archive).percent).toBeNull()
  })

  it('scores identical bed/wake times as fully consistent', () => {
    const dates = ['2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21']
    const archive = archiveWithSleepTimes(dates, '23:00', '07:00')
    const data = withSleepTimes(createDemoData('2026-06-22'), '2026-06-22T23:00:00', '2026-06-23T07:00:00')

    const consistency = computeSleepConsistency(data, archive)
    expect(consistency.percent).toBe(100)
  })

  it('scores erratic bed times lower than consistent ones', () => {
    const dates = ['2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21']
    const steadyArchive = archiveWithSleepTimes(dates, '23:00', '07:00')
    const erraticArchive = [
      withSleepTimes(createDemoData('2026-06-18'), '2026-06-18T21:30:00', '2026-06-19T05:30:00'),
      withSleepTimes(createDemoData('2026-06-19'), '2026-06-19T23:50:00', '2026-06-20T08:10:00'),
      withSleepTimes(createDemoData('2026-06-20'), '2026-06-21T01:20:00', '2026-06-21T09:00:00'),
      withSleepTimes(createDemoData('2026-06-21'), '2026-06-21T22:15:00', '2026-06-22T06:05:00'),
    ]
    const data = withSleepTimes(createDemoData('2026-06-22'), '2026-06-22T23:00:00', '2026-06-23T07:00:00')

    const steady = computeSleepConsistency(data, steadyArchive)
    const erratic = computeSleepConsistency(data, erraticArchive)
    expect(steady.percent).not.toBeNull()
    expect(erratic.percent).not.toBeNull()
    expect(erratic.percent!).toBeLessThan(steady.percent!)
  })
})

describe('computeWeeklyAssessment', () => {
  it('is null (averageSleepPerformance) with fewer than 5 nights', () => {
    const data = createDemoData('2026-06-22')
    expect(computeWeeklyAssessment(data, []).averageSleepPerformance).toBeNull()
  })

  it('averages sleep performance across the week once enough nights exist', () => {
    const dates = ['2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21']
    const archive = dates.map((date) => {
      const day = createDemoData(date)
      return { ...day, sleep: { ...day.sleep, totalMinutes: 480, goalMinutes: 480 } }
    })
    const data = createDemoData('2026-06-22')

    const weekly = computeWeeklyAssessment(data, archive)
    expect(weekly.averageSleepPerformance).not.toBeNull()
    expect(weekly.nightsCounted).toBeGreaterThanOrEqual(5)
  })
})

// The reported bug: with an empty archive these scores silently vanished, so
// demo mode could not be used to verify them. Demo now ships a real 14-day
// archive and every derived score must survive on it.
describe('demo mode surfaces every derived score', () => {
  const DATES = ['2026-06-22', '2026-01-05', '2025-11-02', '2026-12-31']

  it.each(DATES)('produces every score on %s', (date) => {
    const data = createDemoData(date)
    const archive = createDemoArchive(date)

    const consistency = computeSleepConsistency(data, archive)
    expect(consistency.percent).not.toBeNull()
    // A band, not a constant: pinning a number would make the test a change
    // detector, and a perfect 100 would mean the demo nights went flat again.
    expect(consistency.percent!).toBeGreaterThan(40)
    expect(consistency.percent!).toBeLessThan(100)

    const weekly = computeWeeklyAssessment(data, archive)
    expect(weekly.averageSleepPerformance).not.toBeNull()
    expect(weekly.nightsCounted).toBeGreaterThanOrEqual(5)

    const maxHeartRate = estimateMaxHeartRate(data, archive)
    expect(maxHeartRate.isTodayOnly).toBe(false)
    expect(maxHeartRate.bpm).toBeGreaterThanOrEqual(data.health.heartRateMax!)

    expect(computeDayStrain(data, archive).value).not.toBeNull()
    expect(computeDailyHeartRateZones(data, archive)).not.toBeNull()
    expect(computeSleepDebt(data).minutes).not.toBeNull()
    expect(computeSleepNeed(data, computeDayStrain(data, archive), computeSleepDebt(data)).neededMinutes).not.toBeNull()

    const sleepPerformance = computeDynamicSleepPerformance(data, archive)
    expect(sleepPerformance.percent).not.toBeNull()
    expect(computeRecoveryScore(data, sleepPerformance).value).not.toBeNull()
  })

  it('varies day strain across the archive instead of repeating one value', () => {
    const archive = createDemoArchive('2026-06-22')
    const strains = archive.map((day) => computeDayStrain(day, archive).value)

    expect(strains.every((value) => value !== null)).toBe(true)
    // Guards against a flat generator, which is what made the scores useless.
    expect(new Set(strains).size).toBeGreaterThanOrEqual(5)
    expect(Math.max(...strains as number[]) - Math.min(...strains as number[])).toBeGreaterThan(2)
  })
})
