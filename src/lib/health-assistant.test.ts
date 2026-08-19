import { describe, expect, it } from 'vitest'
import { createDemoArchive, createDemoData } from '@/data/demo'
import {
  buildHealthAssistantContext,
  parseAssistantNavigation,
  stripAssistantNavigation,
  visibleAssistantText,
} from './health-assistant'

describe('health assistant context', () => {
  it('includes every category and the selected-day detail without null noise', () => {
    const data = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(data, [data], 'sleep'))

    expect(context.app).toMatchObject({ currentPage: 'sleep', selectedDate: '2026-06-23' })
    expect(context.archive.dayCount).toBeGreaterThanOrEqual(14)
    expect(context.selectedDayDetail.summary).toHaveProperty('activity')
    expect(context.selectedDayDetail.summary).toHaveProperty('health')
    expect(context.selectedDayDetail.summary).toHaveProperty('sleep')
    expect(context.selectedDayDetail.summary).toHaveProperty('body')
    expect(context.selectedDayDetail.intraday.heartRate.length).toBeGreaterThan(0)
  })

  it('exposes the derived scores with their disclaimer so the assistant can explain them', () => {
    const data = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(data, [data], 'today'))

    expect(context.derivedScores.disclaimer).toContain('not a reproduction')
    expect(context.derivedScores.recovery.value).toBeGreaterThanOrEqual(0)
    expect(context.derivedScores.sleepPerformancePercent).toBeGreaterThan(0)
    expect(context.derivedScores.naps.length).toBeGreaterThan(0)
  })

  it('labels demo data as synthetic so the assistant cannot present it as real', () => {
    const demo = createDemoData('2026-06-23')
    const context = JSON.parse(buildHealthAssistantContext(demo, createDemoArchive('2026-06-23'), 'today'))

    expect(context.dataMode).toBe('demo')
    expect(context.derivedScores.disclaimer).toContain('synthetic demo data')
  })

  it('reports live data without the synthetic-data warning', () => {
    const demo = createDemoData('2026-06-23')
    const live = { ...demo, source: 'google-health' as const }
    const context = JSON.parse(buildHealthAssistantContext(live, [], 'today'))

    expect(context.dataMode).toBe('live')
    expect(context.derivedScores.disclaimer).not.toContain('synthetic demo data')
  })

  it('carries the archive-dependent scores once demo ships a real archive', () => {
    const date = '2026-06-23'
    const context = JSON.parse(buildHealthAssistantContext(createDemoData(date), createDemoArchive(date), 'today'))

    // These used to be pruned by withoutNulls because the demo archive was empty.
    expect(context.derivedScores.sleepConsistencyPercent).toBeGreaterThan(0)
    expect(context.derivedScores.weeklySleepPerformancePercent).toBeGreaterThan(0)
    expect(context.derivedScores.maxHeartRateBpm.isTodayOnly).toBe(false)
  })

  it('omits derived scores that do not have enough history instead of inventing them', () => {
    const data = createDemoData('2026-06-23')
    // A single trend point leaves every personal-baseline comparison and the
    // debt window short of their minimum sample counts.
    const thin = { ...data, trends: data.trends.slice(-1) }
    const context = JSON.parse(buildHealthAssistantContext(thin, [], 'today'))

    expect(context.derivedScores.recovery.value ?? null).toBeNull()
    expect(context.derivedScores.sleepDebtMinutes ?? null).toBeNull()
    expect(context.derivedScores.sleepNeedMinutes ?? null).toBeNull()
  })
})

describe('assistant navigation directives', () => {
  it('parses and removes a valid directive', () => {
    const text = 'Apro il sonno di ieri.\n<!-- openfit:navigate {"page":"sleep","date":"2026-06-22"} -->'
    expect(parseAssistantNavigation(text)).toEqual({ page: 'sleep', date: '2026-06-22' })
    expect(stripAssistantNavigation(text)).toBe('Apro il sonno di ieri.')
    expect(visibleAssistantText(text)).toBe('Apro il sonno di ieri.')
    expect(visibleAssistantText('Apro il sonno.\n<!-- pulse')).toBe('Apro il sonno.')
  })

  it('ignores invalid pages and malformed JSON', () => {
    expect(parseAssistantNavigation('<!-- openfit:navigate {"page":"admin"} -->')).toBeNull()
    expect(parseAssistantNavigation('<!-- openfit:navigate {"date":"2026-02-31"} -->')).toBeNull()
    expect(parseAssistantNavigation('<!-- openfit:navigate nope -->')).toBeNull()
  })
})
