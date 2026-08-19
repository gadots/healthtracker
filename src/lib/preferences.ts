import type { DataModePreference } from '@/types'

const DATA_MODE_KEY = 'openfit.dataMode'

// The packaged app loads over file:// and private-browsing modes can throw on
// access, so storage is never assumed to work. When it doesn't, the preference
// still behaves correctly for the session — it just stops surviving a restart.
let fallback: DataModePreference = 'live'

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function normalize(value: unknown): DataModePreference {
  return value === 'demo' ? 'demo' : 'live'
}

export function readDataModePreference(storage?: Storage): DataModePreference {
  const target = storageOrNull(storage)
  if (!target) return fallback
  try {
    const stored = target.getItem(DATA_MODE_KEY)
    return stored === null ? fallback : normalize(stored)
  } catch {
    return fallback
  }
}

export function writeDataModePreference(value: DataModePreference, storage?: Storage): void {
  const normalized = normalize(value)
  fallback = normalized
  const target = storageOrNull(storage)
  if (!target) return
  try {
    target.setItem(DATA_MODE_KEY, normalized)
  } catch {
    // Keeping the in-memory fallback is enough; a display preference is not
    // worth surfacing a storage failure to the user.
  }
}

/** Test seam: clears the module-level fallback between cases. */
export function __resetDataModeFallback() {
  fallback = 'live'
}
