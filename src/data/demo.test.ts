import { describe, expect, it } from 'vitest'
import type { DashboardData } from '../types'
import { createDemoArchive, createDemoData } from './demo'

const DATES = ['2026-06-22', '2026-01-05', '2025-11-02', '2026-12-31']

function minutesBetween(start: string, end: string) {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000)
}

describe('createDemoData', () => {
  it('creates a complete deterministic dashboard for the selected date', () => {
    const first = createDemoData('2026-06-22')
    const second = createDemoData('2026-06-22')

    expect(first.selectedDate).toBe('2026-06-22')
    expect(first.activity.steps).toBe(second.activity.steps)
    expect(first.trends).toHaveLength(14)
    expect(first.health.heartRateIntraday).toHaveLength(288)
    expect(first.sleep.stages.reduce((sum, stage) => sum + stage.minutes, 0)).toBeGreaterThan(0)
  })

  it('varies by calendar date instead of repeating one canned day', () => {
    const days = DATES.map((date) => createDemoData(date))
    const fields: Array<(day: DashboardData) => unknown> = [
      (day) => day.activity.steps,
      (day) => day.sleep.totalMinutes,
      (day) => day.health.heartRateMax,
      (day) => day.sleep.startTime,
    ]
    for (const field of fields) {
      expect(new Set(days.map(field)).size).toBeGreaterThan(1)
    }
  })

  it('keeps the night internally consistent', () => {
    for (const date of DATES) {
      const { sleep } = createDemoData(date)
      expect(minutesBetween(sleep.startTime!, sleep.endTime!)).toBe(sleep.timeInBed)
      expect(sleep.totalMinutes! + sleep.minutesAwake!).toBe(sleep.timeInBed)
      const asleepStages = sleep.stages.filter((stage) => stage.key !== 'wake')
      expect(asleepStages.reduce((sum, stage) => sum + stage.minutes, 0)).toBe(sleep.totalMinutes)
      expect(sleep.stages.find((stage) => stage.key === 'wake')!.minutes).toBe(sleep.minutesAwake)
    }
  })

  it('derives the heart-rate range from the intraday series it renders', () => {
    for (const date of DATES) {
      const { health } = createDemoData(date)
      const values = health.heartRateIntraday.map((point) => point.value)
      expect(health.heartRateMax).toBe(Math.max(...values))
      expect(health.heartRateMin).toBe(Math.min(...values))
    }
  })

  it('agrees with the last point of its own trend window', () => {
    for (const date of DATES) {
      const data = createDemoData(date)
      const latest = data.trends.at(-1)!
      expect(latest.date).toBe(date)
      expect(latest.steps).toBe(data.activity.steps)
      expect(latest.sleepMinutes).toBe(data.sleep.totalMinutes)
      expect(latest.sleepEfficiency).toBe(data.sleep.efficiency)
    }
  })

  it('emits naps whose duration matches their timestamps', () => {
    const withNaps = DATES.map((date) => createDemoData(date)).flatMap((data) => data.sleep.naps)
    expect(withNaps.length).toBeGreaterThan(0)
    for (const nap of withNaps) {
      expect(minutesBetween(nap.startTime, nap.endTime)).toBe(nap.durationMinutes)
    }
  })
})

describe('createDemoArchive', () => {
  it('returns the prior days, oldest first, ending the day before the selected date', () => {
    const archive = createDemoArchive('2026-06-22', 14)

    expect(archive).toHaveLength(14)
    expect(archive.at(-1)!.selectedDate).toBe('2026-06-21')
    expect(archive[0].selectedDate).toBe('2026-06-08')
    const dates = archive.map((day) => day.selectedDate)
    expect([...dates].sort()).toEqual(dates)
    expect(dates).not.toContain('2026-06-22')
  })

  it('carries the fields the archive-dependent scores need', () => {
    for (const day of createDemoArchive('2026-06-22')) {
      expect(day.source).toBe('demo')
      expect(day.sleep.startTime).toBeTruthy()
      expect(day.sleep.endTime).toBeTruthy()
      expect(day.health.heartRateMax).not.toBeNull()
      expect(day.health.heartRateIntraday.length).toBeGreaterThan(0)
    }
  })

  it('matches what the user sees when navigating to that same day', () => {
    // `generatedAt` and `device.lastSyncTime` are wall-clock stamps taken at
    // call time, so blank them and compare every actual measurement.
    const stable = (day: DashboardData) => ({
      ...day,
      generatedAt: '',
      device: day.device ? { ...day.device, lastSyncTime: '' } : null,
    })
    for (const day of createDemoArchive('2026-06-22', 3)) {
      expect(stable(day)).toEqual(stable(createDemoData(day.selectedDate)))
    }
  })

  it('has both nap days and nap-free days so nap credit is not constant', () => {
    const archive = createDemoArchive('2026-06-22')
    const napDays = archive.filter((day) => day.sleep.naps.length > 0).length
    expect(napDays).toBeGreaterThan(0)
    expect(napDays).toBeLessThan(archive.length)
  })
})
