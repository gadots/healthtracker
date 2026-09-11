import type { RawFitbitPayload, RawHealthArchive } from '@/types'

/**
 * Browser-side stand-in for the desktop app's encrypted day cache
 * (`electron/health-cache.cjs`). Same `{version, lastDate, days}` shape, but
 * held in `sessionStorage` so it lives and dies with the tab — there is no
 * database and nothing is written to disk.
 */
export const ARCHIVE_VERSION = 2

const ARCHIVE_KEY = 'openfit:archive'
const LAST_SYNC_KEY = 'openfit:lastSyncAt'

export function emptyArchive(): RawHealthArchive {
  return { version: ARCHIVE_VERSION, lastDate: null, days: {} }
}

export function normalizeArchive(value: unknown): RawHealthArchive {
  const archive = value as RawHealthArchive | null
  if (archive?.version === ARCHIVE_VERSION && archive.days && typeof archive.days === 'object') {
    return {
      version: ARCHIVE_VERSION,
      lastDate: typeof archive.lastDate === 'string' ? archive.lastDate : null,
      days: { ...archive.days },
    }
  }
  return emptyArchive()
}

export function storeDay(value: unknown, payload: RawFitbitPayload): RawHealthArchive {
  const archive = normalizeArchive(value)
  return {
    version: ARCHIVE_VERSION,
    lastDate: payload.date,
    days: { ...archive.days, [payload.date]: payload },
  }
}

export function cachedDay(value: unknown, date: string): RawFitbitPayload | null {
  return normalizeArchive(value).days[date] || null
}

export function latestDay(value: unknown): RawFitbitPayload | null {
  const archive = normalizeArchive(value)
  if (archive.lastDate && archive.days[archive.lastDate]) return archive.days[archive.lastDate]
  const dates = Object.keys(archive.days).sort()
  return dates.length ? archive.days[dates.at(-1)!] : null
}

/** sessionStorage throws in some privacy modes; the dashboard must still work. */
function safeSession<T>(run: (storage: Storage) => T, fallback: T): T {
  try {
    return run(window.sessionStorage)
  } catch {
    return fallback
  }
}

export function readArchive(): RawHealthArchive {
  return safeSession((storage) => {
    const raw = storage.getItem(ARCHIVE_KEY)
    return raw ? normalizeArchive(JSON.parse(raw)) : emptyArchive()
  }, emptyArchive())
}

export function writeArchive(archive: RawHealthArchive) {
  safeSession((storage) => storage.setItem(ARCHIVE_KEY, JSON.stringify(archive)), undefined)
}

export function rememberDay(payload: RawFitbitPayload): RawHealthArchive {
  const archive = storeDay(readArchive(), payload)
  writeArchive(archive)
  writeLastSyncAt(payload.generatedAt)
  return archive
}

export function clearArchive() {
  safeSession((storage) => {
    storage.removeItem(ARCHIVE_KEY)
    storage.removeItem(LAST_SYNC_KEY)
  }, undefined)
}

export function readLastSyncAt(): string | null {
  return safeSession((storage) => storage.getItem(LAST_SYNC_KEY), null)
}

export function writeLastSyncAt(value: string) {
  safeSession((storage) => storage.setItem(LAST_SYNC_KEY, value), undefined)
}
