import { describe, expect, it } from 'vitest'
import { createDemoData } from '@/data/demo'
import { analyzeHome, compareWithPersonalBaseline, periodDelta } from './home-analysis'

describe('home analysis', () => {
  it('uses goals and personal baselines without inventing a composite score', () => {
    const data = createDemoData('2026-06-22')
    const analysis = analyzeHome(data)

    expect(analysis.stepsGoalProgress).toBeCloseTo((data.activity.steps ?? 0) / (data.activity.stepsGoal ?? 1))
    expect(analysis.restingHeartRate.sampleCount).toBe(7)
    expect(analysis.hrv.sampleCount).toBe(7)
    expect(analysis.headline.title.length).toBeGreaterThan(0)
  })

  it('excludes the selected day from a personal baseline', () => {
    const data = createDemoData('2026-06-22')
    const comparison = compareWithPersonalBaseline(data, data.health.hrvMs, (point) => point.hrvMs)
    const expected = data.trends.slice(-8, -1).reduce((sum, point) => sum + (point.hrvMs ?? 0), 0) / 7

    expect(comparison.baseline).toBeCloseTo(expected)
  })

  it('reports the personal spread that the range flags depend on', () => {
    const data = createDemoData('2026-06-22')
    const constant = { ...data, trends: data.trends.map((point) => ({ ...point, hrvMs: 50 })) }

    // Identical history: no spread, so nothing can be "outside" the range.
    expect(compareWithPersonalBaseline(constant, 50, (point) => point.hrvMs).stddev).toBe(0)

    // Fewer than two samples cannot have a spread at all.
    const single = { ...data, trends: data.trends.slice(-1) }
    expect(compareWithPersonalBaseline(single, 50, (point) => point.hrvMs).stddev).toBeNull()
  })

  it('computes a population standard deviation over the lookback window', () => {
    const data = createDemoData('2026-06-22')
    const values = [2, 4, 4, 4, 5, 5, 7, 9]
    // The window excludes the selected day and keeps the last 7 prior points.
    const withSeries = {
      ...data,
      trends: data.trends.map((point, index) => ({ ...point, hrvMs: values[index % values.length] })),
    }
    const comparison = compareWithPersonalBaseline(withSeries, 5, (point) => point.hrvMs)
    const window = withSeries.trends.filter((point) => point.date < withSeries.selectedDate).slice(-7).map((point) => point.hrvMs!)
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length
    const expected = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length)

    expect(comparison.sampleCount).toBe(7)
    expect(comparison.stddev).toBeCloseTo(expected)
  })

  it('requires enough observations for a period comparison', () => {
    expect(periodDelta([1, null, 2, 3])).toBeNull()
    expect(periodDelta([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).not.toBeNull()
  })
})
