/**
 * Stand-in for `google-health-service.cjs` used when `MOCK_HEALTH=1`.
 *
 * It emits the same legacy-Fitbit-shaped `RawFitbitPayload` that
 * `translateGoogleHealth()` produces, so the whole web path — bridge, sync
 * gate, normalization, every view — can be exercised end to end without Google
 * credentials or network access.
 */

const MOCK_TOKEN = { refresh_token: 'mock-refresh-token', expiresAt: 0 }

function shiftIso(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

/** Deterministic pseudo-random so repeated syncs of a date agree. */
function seeded(index, salt = 1) {
  return Math.abs(Math.sin((index + 1) * 12.9898 * salt) * 43_758.5453) % 1
}

function trendSeries(selectedDate, days, build) {
  return Array.from({ length: days }, (_, index) => build(shiftIso(selectedDate, index - (days - 1)), index))
}

export function createMockPayload(selectedDate) {
  const steps = 7_400 + Math.round(seeded(0) * 4_000)
  const restingHeartRate = 52 + Math.round(seeded(1) * 8)

  const endpoints = {
    profile: { user: { displayName: 'Demo Account', memberSince: '2021-04-02', timezone: 'Europe/Madrid', avatar640: null } },
    devices: [{ id: 'mock-1', deviceVersion: 'Fitbit Air', type: 'TRACKER', battery: 'High', batteryLevel: 78, lastSyncTime: `${selectedDate}T08:12:00.000`, features: ['HEART_RATE', 'SLEEP', 'SPO2'] }],
    activity: {
      summary: {
        steps,
        caloriesOut: 2_380,
        floors: 11,
        sedentaryMinutes: 610,
        lightlyActiveMinutes: 186,
        fairlyActiveMinutes: 31,
        veryActiveMinutes: 22,
        distances: [{ activity: 'total', distance: 8.4 }],
      },
    },
    activityGoals: { goals: { steps: 10_000, caloriesOut: 2_600, distance: 8, floors: 10, activeMinutes: 30 } },
    stepsIntraday: {
      'activities-steps-intraday': {
        dataset: Array.from({ length: 24 }, (_, hour) => ({
          time: `${String(hour).padStart(2, '0')}:00:00`,
          value: hour < 6 ? 0 : Math.round(seeded(hour, 3) * 900),
        })),
      },
    },
    heartIntraday: {
      'activities-heart': [{ value: { restingHeartRate, heartRateZones: [] } }],
      'activities-heart-intraday': {
        dataset: Array.from({ length: 48 }, (_, index) => ({
          time: `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}:00`,
          value: 54 + Math.round(seeded(index, 5) * 46),
        })),
      },
    },
    sleep: {
      sleep: [{
        isMainSleep: true,
        dateOfSleep: selectedDate,
        startTime: `${shiftIso(selectedDate, -1)}T23:36:00.000`,
        endTime: `${selectedDate}T07:04:00.000`,
        minutesAsleep: 413,
        minutesAwake: 35,
        timeInBed: 448,
        efficiency: 92,
        minutesToFallAsleep: 12,
        minutesAfterWakeup: 6,
        levels: {
          summary: { deep: { minutes: 78 }, light: { minutes: 224 }, rem: { minutes: 111 }, wake: { minutes: 35 } },
          data: [
            { dateTime: `${shiftIso(selectedDate, -1)}T23:36:00.000`, level: 'light', seconds: 2_400 },
            { dateTime: `${selectedDate}T00:16:00.000`, level: 'deep', seconds: 3_600 },
            { dateTime: `${selectedDate}T01:16:00.000`, level: 'rem', seconds: 2_700 },
            { dateTime: `${selectedDate}T02:01:00.000`, level: 'light', seconds: 9_000 },
            { dateTime: `${selectedDate}T04:31:00.000`, level: 'rem', seconds: 3_960 },
            { dateTime: `${selectedDate}T05:37:00.000`, level: 'light', seconds: 4_200 },
            { dateTime: `${selectedDate}T06:47:00.000`, level: 'wake', seconds: 1_020 },
          ],
        },
      }],
    },
    sleepGoal: { goal: { minDuration: 450 } },
    bodyWeight: { weight: trendSeries(selectedDate, 14, (date, index) => ({ date, weight: Number((74.2 + seeded(index, 7) * 1.2).toFixed(1)), bmi: 22.6 })) },
    bodyFat: { fat: [{ date: selectedDate, fat: 17.4 }] },
    weightGoal: { goal: { weight: 73 } },
    water: { summary: { water: 1_850 } },
    waterGoal: { goal: { goal: 2_500 } },
    food: { summary: { calories: 2_140 } },
    breathing: { br: [{ value: { breathingRate: 14.2 } }] },
    hrv: { hrv: [{ value: { dailyRmssd: 41, deepRmssd: 46 } }] },
    spo2: { value: { avg: 96.4, min: 93, max: 99 } },
    skinTemperature: { tempSkin: [{ value: { nightlyRelative: -0.2 } }] },
    cardio: { cardioScore: [{ value: { vo2Max: '44-48' } }] },
    stepsTrend: { 'activities-steps': trendSeries(selectedDate, 14, (date, index) => ({ dateTime: date, value: String(6_200 + Math.round(seeded(index, 11) * 5_200)) })) },
    caloriesTrend: { 'activities-calories': trendSeries(selectedDate, 14, (date, index) => ({ dateTime: date, value: String(2_150 + Math.round(seeded(index, 13) * 500)) })) },
    heartTrend: { 'activities-heart': trendSeries(selectedDate, 14, (date, index) => ({ dateTime: date, value: { restingHeartRate: 50 + Math.round(seeded(index, 17) * 9) } })) },
    sleepTrend: { sleep: trendSeries(selectedDate, 14, (date, index) => ({ dateOfSleep: date, isMainSleep: true, minutesAsleep: 372 + Math.round(seeded(index, 19) * 90), efficiency: 88 + Math.round(seeded(index, 23) * 8) })) },
    activities: {
      activities: [{
        logId: 'mock-activity-1',
        activityName: 'Outdoor run',
        startTime: `${selectedDate}T18:12:00.000`,
        duration: 2_340_000,
        calories: 412,
        distance: 6.2,
        averageHeartRate: 151,
        steps: 6_050,
      }],
    },
  }

  // `requestStats.successfulKeys` reports the *pre-translation* Google job keys,
  // not the legacy-shaped keys in `endpoints` — same as the real adapter, so the
  // quality gate in `health-sync.mjs` sees what it expects.
  const successfulKeys = [
    'identity', 'profileRaw', 'settingsRaw', 'devicesRaw', 'userInfo',
    'stepsDaily', 'caloriesDaily', 'distanceDaily', 'floorsDaily', 'activeMinutesDaily',
    'zoneMinutesDaily', 'sedentaryDaily', 'weightDaily', 'fatDaily', 'waterDaily',
    'nutritionDaily', 'stepsIntradayRaw', 'heartIntradayRaw', 'restingHeartRaw', 'hrvRaw',
    'spo2Raw', 'breathingRaw', 'skinTemperatureRaw', 'cardioRaw', 'sleepRaw', 'activitiesRaw',
  ]
  return {
    source: 'google-health',
    date: selectedDate,
    generatedAt: new Date().toISOString(),
    endpoints,
    errors: [],
    rateLimit: { limit: 300, remaining: 299, resetSeconds: 60 },
    requestStats: { total: 30, succeeded: successfulKeys.length, successfulKeys },
  }
}

export const mockProvider = {
  provider: 'google-health',
  createPkce: () => ({ verifier: 'mock-verifier', challenge: 'mock-challenge' }),
  createAuthorizationUrl: (_config, state) => `/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
  exchangeAuthorizationCode: async () => ({ ...MOCK_TOKEN }),
  refreshAccessToken: async (_config, token) => ({ ...token, access_token: 'mock-access-token', expiresAt: Date.now() + 3_600_000 }),
  revokeToken: async () => {},
  syncData: async (_accessToken, date) => createMockPayload(date),
}
