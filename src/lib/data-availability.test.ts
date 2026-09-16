import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import type { DashboardData } from '@/types'
import {
  availableMetricCount,
  availablePages,
  hasActivityData,
  hasBodyData,
  hasHealthData,
  hasSleepData,
} from './data-availability'

/** A payload with every measurement missing, which is what a partial sync looks like. */
function emptyData(): DashboardData {
  const data = createDemoData('2026-06-22')
  return {
    ...data,
    activity: {
      ...data.activity,
      steps: null, calories: null, distanceKm: null, floors: null,
      activeMinutes: null, zoneMinutes: null, sedentaryMinutes: null,
      stepsIntraday: [], caloriesIntraday: [],
    },
    health: {
      ...data.health,
      currentHeartRate: null, restingHeartRate: null, hrvMs: null, breathingRate: null,
      spo2: null, skinTemperature: null, coreTemperature: null, cardioScore: null,
      bloodGlucoseMgDl: null, irregularRhythmAlerts: null, vo2Max: null,
      ecgClassification: null, heartRateIntraday: [],
    },
    sleep: { ...data.sleep, totalMinutes: null, score: null, stages: [] },
    body: { ...data.body, weightKg: null, bmi: null, bodyFat: null, waterMl: null, caloriesIn: null },
    activities: [],
  }
}

describe('data availability', () => {
  it('sees every category in demo data', () => {
    const data = createDemoData('2026-06-22')
    expect(hasActivityData(data)).toBe(true)
    expect(hasHealthData(data)).toBe(true)
    expect(hasSleepData(data)).toBe(true)
    expect(hasBodyData(data)).toBe(true)
  })

  it('reports nothing available on an empty payload', () => {
    const data = emptyData()
    expect(hasActivityData(data)).toBe(false)
    expect(hasHealthData(data)).toBe(false)
    expect(hasSleepData(data)).toBe(false)
    expect(hasBodyData(data)).toBe(false)
  })

  it('counts activity present from intraday samples or logged workouts alone', () => {
    const base = emptyData()
    expect(hasActivityData({ ...base, activity: { ...base.activity, stepsIntraday: [{ time: '08:00', value: 120 }] } })).toBe(true)
    expect(hasActivityData({ ...base, activities: createDemoData('2026-06-22').activities })).toBe(true)
  })

  it('counts health present from an intraday series or a string-only reading', () => {
    const base = emptyData()
    expect(hasHealthData({ ...base, health: { ...base.health, heartRateIntraday: [{ time: '08:00', value: 70 }] } })).toBe(true)
    expect(hasHealthData({ ...base, health: { ...base.health, vo2Max: '49–53' } })).toBe(true)
    expect(hasHealthData({ ...base, health: { ...base.health, ecgClassification: 'Sinus rhythm' } })).toBe(true)
  })

  it('counts sleep present from stages alone when duration is missing', () => {
    const base = emptyData()
    const staged = { ...base, sleep: { ...base.sleep, stages: createDemoData('2026-06-22').sleep.stages } }
    expect(hasSleepData(staged)).toBe(true)
  })

  it('always offers today and devices, and hides empty sections', () => {
    expect(availablePages(createDemoData('2026-06-22'))).toEqual(['today', 'activity', 'health', 'sleep', 'body', 'devices'])
    expect(availablePages(emptyData())).toEqual(['today', 'devices'])
  })

  it('counts a recorded zero but not a missing value', () => {
    const base = emptyData()
    expect(availableMetricCount(base)).toBe(0)
    expect(availableMetricCount({ ...base, activity: { ...base.activity, steps: 0 } })).toBe(1)
    expect(availableMetricCount({ ...base, activity: { ...base.activity, steps: Number.NaN } })).toBe(0)
    expect(availableMetricCount(createDemoData('2026-06-22'))).toBeGreaterThan(10)
  })
})
