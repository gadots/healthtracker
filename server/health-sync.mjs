/**
 * Sync orchestration for the web app, ported from `electron/main.cjs`
 * (`syncData`, main.cjs:258-285). The provider adapter itself is reused
 * verbatim — `electron/google-health-service.cjs` only needs `node:crypto`
 * and global `fetch`, so it runs unchanged in a plain Node process.
 */

/** Keys that carry an actual measurement, as opposed to profile/settings metadata. */
export const GOOGLE_MEASUREMENT_KEYS = [
  'stepsDaily', 'caloriesDaily', 'distanceDaily', 'activeMinutesDaily', 'zoneMinutesDaily',
  'weightDaily', 'waterDaily', 'nutritionDaily', 'heartIntradayRaw', 'restingHeartRaw',
  'hrvRaw', 'spo2Raw', 'breathingRaw', 'skinTemperatureRaw', 'cardioRaw', 'sleepRaw',
  'activitiesRaw', 'ecgRaw', 'irnAlertsRaw', 'glucoseRaw',
]

/**
 * A mostly-failed sync must not be presented as real data. Mirrors the desktop
 * gate: enough endpoints answered, and at least one of them was a measurement.
 */
export function assertUsefulPayload(payload, measurementKeys = GOOGLE_MEASUREMENT_KEYS) {
  const total = Number(payload?.requestStats?.total || 0)
  const succeeded = Number(payload?.requestStats?.succeeded || 0)
  const successfulKeys = Array.isArray(payload?.requestStats?.successfulKeys)
    ? payload.requestStats.successfulKeys
    : []
  const minimumUsefulResponses = Math.max(3, Math.ceil(total * 0.2))
  const hasMeasurementResponse = successfulKeys.some((key) => measurementKeys.includes(key))

  if (!total || succeeded < minimumUsefulResponses || !hasMeasurementResponse) {
    throw new Error('The sync did not return enough valid sources. Try again in a moment.')
  }
  return payload
}
