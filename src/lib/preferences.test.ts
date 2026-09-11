import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDataModeFallback, readDataModePreference, writeDataModePreference } from './preferences'

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  } as Storage
}

function throwingStorage(): Storage {
  return {
    get length(): number { throw new Error('denied') },
    clear: () => { throw new Error('denied') },
    key: () => { throw new Error('denied') },
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  } as unknown as Storage
}

describe('data mode preference', () => {
  beforeEach(() => { __resetDataModeFallback() })

  it('defaults to live when nothing is stored', () => {
    expect(readDataModePreference(fakeStorage())).toBe('live')
  })

  it('round-trips a demo preference', () => {
    const storage = fakeStorage()
    writeDataModePreference('demo', storage)
    expect(readDataModePreference(storage)).toBe('demo')
  })

  it('normalizes anything unrecognized back to live', () => {
    for (const stored of ['', 'DEMO', '{}', 'true', 'null']) {
      expect(readDataModePreference(fakeStorage({ 'openfit.dataMode': stored }))).toBe('live')
    }
  })

  it('survives a storage that throws, falling back to memory', () => {
    const storage = throwingStorage()
    expect(() => writeDataModePreference('demo', storage)).not.toThrow()
    // The write could not persist, but the choice still holds for this session.
    expect(readDataModePreference(storage)).toBe('demo')
  })

  it('falls back to memory when there is no storage at all', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    vi.stubGlobal('localStorage', undefined)
    try {
      writeDataModePreference('demo')
      expect(readDataModePreference()).toBe('demo')
    } finally {
      vi.unstubAllGlobals()
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
    }
  })
})
