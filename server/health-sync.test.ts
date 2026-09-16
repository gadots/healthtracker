import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM module without type declarations
import { assertUsefulPayload } from './health-sync.mjs'

function payload(total: number, successfulKeys: string[]) {
  return { requestStats: { total, succeeded: successfulKeys.length, successfulKeys } }
}

describe('assertUsefulPayload', () => {
  it('accepts a sync with enough sources and a real measurement', () => {
    const good = payload(30, ['identity', 'profileRaw', 'stepsDaily', 'sleepRaw', 'hrvRaw', 'spo2Raw'])
    expect(() => assertUsefulPayload(good)).not.toThrow()
  })

  it('rejects a sync that returned only metadata, never a measurement', () => {
    const metadataOnly = payload(30, ['identity', 'profileRaw', 'settingsRaw', 'devicesRaw', 'userInfo', 'irnProfileRaw'])
    expect(() => assertUsefulPayload(metadataOnly)).toThrow(/not return enough valid sources/)
  })

  it('rejects a sync below the 20% success floor', () => {
    // 5 of 30 succeeded: under ceil(30 * 0.2) = 6.
    expect(() => assertUsefulPayload(payload(30, ['stepsDaily', 'sleepRaw', 'hrvRaw', 'spo2Raw', 'cardioRaw']))).toThrow()
  })

  it('accepts exactly the 20% floor', () => {
    const atFloor = payload(30, ['stepsDaily', 'sleepRaw', 'hrvRaw', 'spo2Raw', 'cardioRaw', 'breathingRaw'])
    expect(() => assertUsefulPayload(atFloor)).not.toThrow()
  })

  it('requires at least three responses even for a tiny job list', () => {
    expect(() => assertUsefulPayload(payload(2, ['stepsDaily']))).toThrow()
  })

  it('rejects an empty or malformed payload', () => {
    expect(() => assertUsefulPayload({})).toThrow()
    expect(() => assertUsefulPayload(payload(0, []))).toThrow()
  })
})
