import { describe, expect, it } from 'vitest'
import { cachedDay, emptyArchive, latestDay, normalizeArchive, storeDay } from './web-archive'
import type { RawFitbitPayload } from '@/types'

function day(date: string): RawFitbitPayload {
  return {
    source: 'google-health',
    date,
    generatedAt: `${date}T10:00:00.000Z`,
    endpoints: {},
    errors: [],
    rateLimit: { limit: null, remaining: null, resetSeconds: null },
  }
}

describe('web archive', () => {
  it('starts empty', () => {
    expect(emptyArchive()).toEqual({ version: 2, lastDate: null, days: {} })
  })

  it('stores a day and remembers it as the latest', () => {
    const archive = storeDay(emptyArchive(), day('2026-03-10'))
    expect(archive.lastDate).toBe('2026-03-10')
    expect(latestDay(archive)?.date).toBe('2026-03-10')
    expect(cachedDay(archive, '2026-03-10')?.date).toBe('2026-03-10')
  })

  it('keeps earlier days when a new one arrives', () => {
    const archive = storeDay(storeDay(emptyArchive(), day('2026-03-10')), day('2026-03-11'))
    expect(Object.keys(archive.days).sort()).toEqual(['2026-03-10', '2026-03-11'])
    expect(latestDay(archive)?.date).toBe('2026-03-11')
  })

  it('tracks the last written day, not the highest date', () => {
    // Stepping back to an earlier day should make that day the current view.
    const archive = storeDay(storeDay(emptyArchive(), day('2026-03-11')), day('2026-03-10'))
    expect(latestDay(archive)?.date).toBe('2026-03-10')
  })

  it('falls back to the newest stored date when lastDate is missing', () => {
    const archive = { version: 2, lastDate: null, days: { '2026-03-09': day('2026-03-09'), '2026-03-10': day('2026-03-10') } }
    expect(latestDay(archive)?.date).toBe('2026-03-10')
  })

  it('discards archives from an incompatible version', () => {
    expect(normalizeArchive({ version: 1, days: { x: 1 } })).toEqual(emptyArchive())
    expect(normalizeArchive(null)).toEqual(emptyArchive())
    expect(normalizeArchive('nonsense')).toEqual(emptyArchive())
  })

  it('returns null for a day that was never stored', () => {
    expect(cachedDay(emptyArchive(), '2026-03-10')).toBeNull()
    expect(latestDay(emptyArchive())).toBeNull()
  })
})
