/**
 * Stand-in for `providers/google-health.cjs` used when `MOCK_HEALTH=1`.
 *
 * It emits the same legacy-Fitbit-shaped `RawFitbitPayload` that
 * `translateGoogleHealth()` produces, so the whole web path — bridge, sync
 * gate, normalization, every view — can be exercised end to end without Google
 * credentials or network access.
 *
 * Every value is seeded from the *calendar date* rather than from a position in
 * a series, so a date's numbers are identical whether it is fetched as today,
 * read back from the browser archive, or rendered as one of the 14 trend
 * points. Days must also differ from one another: the derived scores measure
 * variation (Sleep Consistency compares bedtimes, Max HR takes the highest
 * reading across days), so a generator that repeats itself reports a flawless
 * 100 built out of nothing. This mirrors `src/data/demo.ts`, which backs the
 * desktop app's demo mode; the two cannot share code because one is TypeScript
 * inside the renderer bundle and this one is plain ESM loaded by Node.
 */

const MOCK_TOKEN = { refresh_token: 'mock-refresh-token', expiresAt: 0 }

const HEART_SAMPLE_MINUTES = 5
/**
 * A full day at 5-minute spacing, which is what `compactIntraday()` in
 * `src/data/normalize.ts` caps real Google data at. The interval is
 * load-bearing: `computeDailyHeartRateZones()` credits each sample with the
 * series' average spacing, so coarse sampling inflates every zone minute.
 */
const HEART_SAMPLES_PER_DAY = (24 * 60) / HEART_SAMPLE_MINUTES

const dayMs = 86_400_000

function dateFromIso(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 12))
}

function shiftIso(date, days) {
  return new Date(dateFromIso(date).getTime() + days * dayMs).toISOString().slice(0, 10)
}

/** Stable integer id for a calendar date, so seeds follow the date and not the loop. */
function epochDay(value) {
  return Math.round(dateFromIso(value).getTime() / dayMs)
}

/** Deterministic pseudo-random in [0, 1). Repeated syncs of a date agree. */
function seeded(key, salt = 1) {
  return Math.sin(key * 12.9898 + salt * 78.233) * 0.5 + 0.5
}

/**
 * Smooth, bounded rise around `center`, used to shape walks and sessions.
 *
 * `sharpness` above 1 narrows the top without shortening the effort: a plain
 * cosine is flat near its peak, which would park a session at its maximum
 * heart rate for the better part of an hour and spend the whole thing in the
 * peak zone.
 */
function bump(index, center, halfWidth, amplitude, sharpness = 1) {
  const distance = Math.abs(index - center)
  if (distance > halfWidth) return 0
  return amplitude * Math.cos((distance / halfWidth) * (Math.PI / 2)) ** sharpness
}

function clockTime(minutesFromMidnight) {
  const total = ((Math.round(minutesFromMidnight) % 1440) + 1440) % 1440
  const hours = Math.floor(total / 60)
  return `${String(hours).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
}

/** Naive local timestamp `minutesFromMidnight` into `date`; negative reaches the previous evening. */
function stamp(date, minutesFromMidnight) {
  const base = dateFromIso(date)
  const shifted = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    0, 0, 0,
  ) + minutesFromMidnight * 60_000)
  return `${shifted.toISOString().slice(0, 19)}.000`
}

/**
 * The day's hardest effort: how high it peaks and how long it lasts.
 *
 * The peak floor is not decoration. Day Strain measures each sample against
 * the highest reading observed, so on a day synced with no archive behind it
 * the ceiling is that day's own peak. Below roughly 145 bpm the ordinary
 * waking baseline lands above half of it and every waking minute books as a
 * zone minute. Effort varies through duration instead, which is what moves
 * the score anyway.
 *
 * Every day gets one, varying from an easy half-hour to a long hard session.
 * A day with no effort at all is not merely unrealistic here, it degenerates:
 * the personalized Max HR is the highest reading observed, and Day Strain
 * buckets samples as a percentage of it, so a day that never leaves the
 * fifties reports a maximum near 100 and then prices an ordinary waking
 * baseline as a zone minute — 700-odd of them, pinning strain at its ceiling.
 * Effort varies through intensity and duration instead, which is what actually
 * moves the score.
 */
function effortForDate(key) {
  return {
    peak: 152 + seeded(key, 45) * 38,
    // In samples either side of the centre: a 20-minute walk to a 110-minute ride.
    halfWidth: 2 + Math.round(seeded(key, 47) * 9),
    center: Math.round(190 + seeded(key, 44) * 40),
  }
}

/** Only a real session gets logged as an activity; an easy day just moved more. */
function isLoggedWorkout(key) {
  return effortForDate(key).peak > 155
}

/** The night that ends on `date`: minutes from midnight, so bedtime is negative. */
function nightForDate(date) {
  const key = epochDay(date)
  const lateNight = seeded(key, 33) > 0.85 ? 75 : 0
  const bedMinutes = -40 + Math.round(seeded(key, 31) * 48) + lateNight
  const wakeMinutes = 405 + Math.round(seeded(key, 32) * 35)
  const minutesInBed = wakeMinutes - bedMinutes
  const minutesToFallAsleep = 6 + Math.round(seeded(key, 34) * 14)
  const minutesAwake = 18 + Math.round(seeded(key, 35) * 26)
  const minutesAsleep = minutesInBed - minutesToFallAsleep - minutesAwake
  return {
    key,
    bedMinutes,
    wakeMinutes,
    minutesInBed,
    minutesToFallAsleep,
    minutesAwake,
    minutesAsleep,
    efficiency: Math.round((minutesAsleep / minutesInBed) * 100),
  }
}

/**
 * A day of heart rate: a resting baseline, a circadian lift while awake, two
 * walks, and — except on rest days — one workout.
 *
 * The workout peak matters beyond realism. The personalized Max HR is simply
 * the highest reading ever observed, and Day Strain buckets every sample as a
 * percentage of it. A series that never leaves the 50-100 range yields a max
 * of about 100, which puts a resting 55 bpm at 55% of maximum — so every
 * sample of every day counts as a zone minute and the strain scale pins at its
 * ceiling. The peak has to reach a plausible adult maximum for resting to sit
 * where resting belongs.
 */
function heartSeries(date) {
  const key = epochDay(date)
  const restingBase = 50 + seeded(key, 43) * 7
  const effort = effortForDate(key)
  const walkOneCenter = Math.round(108 + seeded(key, 50) * 24)
  const walkTwoCenter = Math.round(168 + seeded(key, 51) * 30)
  const walkAmplitude = 30 + seeded(key, 52) * 16

  // Circadian floor: asleep, awake, then winding down.
  const baseAt = (index) => {
    const hours = (index * HEART_SAMPLE_MINUTES) / 60
    return hours < 7 ? restingBase : hours < 17 ? restingBase + 12 : restingBase + 7
  }
  // Measured against the base in effect where the session actually lands, so
  // the peak is the peak rather than five beats under it in the evening.
  const sessionAmplitude = effort.peak - baseAt(effort.center)

  return Array.from({ length: HEART_SAMPLES_PER_DAY }, (_, index) => {
    const session = bump(index, effort.center, effort.halfWidth, sessionAmplitude, 2.5)
    const walks = bump(index, walkOneCenter, 5, walkAmplitude) + bump(index, walkTwoCenter, 5, walkAmplitude)
    return {
      time: clockTime(index * HEART_SAMPLE_MINUTES),
      value: Math.round(baseAt(index) + Math.sin(index * 0.35) * 3 + walks + session),
    }
  })
}

/** Stage segments that tile the night, so the timeline and the summary agree. */
function sleepLevels(date, night) {
  const asleepStart = night.bedMinutes + night.minutesToFallAsleep
  const usable = night.minutesAsleep
  const shares = [
    ['light', 0.17], ['deep', 0.16], ['rem', 0.13], ['light', 0.24],
    ['rem', 0.14], ['light', 0.16],
  ]

  let cursor = asleepStart
  const data = []
  const totals = { deep: 0, light: 0, rem: 0, wake: 0 }
  shares.forEach(([level, share], index) => {
    const minutes = index === shares.length - 1
      ? asleepStart + usable - cursor
      : Math.round(usable * share)
    data.push({ dateTime: stamp(date, cursor), level, seconds: minutes * 60 })
    totals[level] += minutes
    cursor += minutes
  })
  data.push({ dateTime: stamp(date, cursor), level: 'wake', seconds: night.minutesAwake * 60 })
  totals.wake = night.minutesAwake

  return {
    summary: {
      deep: { minutes: totals.deep },
      light: { minutes: totals.light },
      rem: { minutes: totals.rem },
      wake: { minutes: totals.wake },
    },
    data,
  }
}

/** Afternoon naps on roughly a third of days, as non-main sleep records. */
function napsForDate(date) {
  const key = epochDay(date)
  if (seeded(key, 61) > 0.34) return []
  const start = 810 + Math.round(seeded(key, 62) * 150)
  const duration = 22 + Math.round(seeded(key, 63) * 34)
  return [{
    logId: `mock-nap-${key}`,
    isMainSleep: false,
    dateOfSleep: date,
    startTime: stamp(date, start),
    endTime: stamp(date, start + duration),
    minutesAsleep: duration,
    timeInBed: duration + 4,
    efficiency: 90,
  }]
}

/** Per-day vitals, keyed on the date so the archive and the trends agree. */
function vitalsForDate(date) {
  const key = epochDay(date)
  return {
    restingHeartRate: 50 + Math.round(seeded(key, 17) * 9),
    hrvDaily: Math.round(34 + seeded(key, 71) * 22),
    hrvDeep: Math.round(39 + seeded(key, 72) * 21),
    breathingRate: Number((13.1 + seeded(key, 73) * 2.6).toFixed(1)),
    spo2Avg: Number((95.2 + seeded(key, 74) * 2.6).toFixed(1)),
    skinTemperature: Number((seeded(key, 75) * 1.6 - 0.8).toFixed(1)),
    steps: 6_200 + Math.round(seeded(key, 11) * 5_200),
    calories: 2_150 + Math.round(seeded(key, 13) * 500),
    sleepMinutes: nightForDate(date).minutesAsleep,
    sleepEfficiency: nightForDate(date).efficiency,
    weight: Number((74.2 + seeded(key, 7) * 1.2).toFixed(1)),
  }
}

function trendSeries(selectedDate, days, build) {
  return Array.from({ length: days }, (_, index) => build(shiftIso(selectedDate, index - (days - 1))))
}

export function createMockPayload(selectedDate) {
  const key = epochDay(selectedDate)
  const night = nightForDate(selectedDate)
  const vitals = vitalsForDate(selectedDate)
  const loggedWorkout = isLoggedWorkout(key)
  const heart = heartSeries(selectedDate)

  const vigorousMinutes = loggedWorkout ? 18 + Math.round(seeded(key, 81) * 22) : Math.round(seeded(key, 81) * 6)
  const moderateMinutes = 14 + Math.round(seeded(key, 82) * 26)
  const lightMinutes = 150 + Math.round(seeded(key, 83) * 70)

  const endpoints = {
    profile: { user: { displayName: 'Demo Account', memberSince: '2021-04-02', timezone: 'Europe/Madrid', avatar640: null } },
    devices: [{ id: 'mock-1', deviceVersion: 'Fitbit Air', type: 'TRACKER', battery: 'High', batteryLevel: 78, lastSyncTime: stamp(selectedDate, 492), features: ['HEART_RATE', 'SLEEP', 'SPO2'] }],
    activity: {
      summary: {
        steps: vitals.steps,
        caloriesOut: vitals.calories,
        floors: 6 + Math.round(seeded(key, 84) * 12),
        sedentaryMinutes: 1440 - night.minutesInBed - lightMinutes - moderateMinutes - vigorousMinutes,
        lightlyActiveMinutes: lightMinutes,
        fairlyActiveMinutes: moderateMinutes,
        veryActiveMinutes: vigorousMinutes,
        distances: [{ activity: 'total', distance: Number((vitals.steps * 0.00072).toFixed(1)) }],
      },
    },
    activityGoals: { goals: { steps: 10_000, caloriesOut: 2_600, distance: 8, floors: 10, activeMinutes: 30 } },
    stepsIntraday: {
      'activities-steps-intraday': {
        dataset: Array.from({ length: 24 }, (_, hour) => ({
          time: `${String(hour).padStart(2, '0')}:00:00`,
          value: hour < 6 ? 0 : Math.round(seeded(key + hour, 3) * 900),
        })),
      },
    },
    heartIntraday: {
      'activities-heart': [{ value: { restingHeartRate: vitals.restingHeartRate, heartRateZones: [] } }],
      'activities-heart-intraday': { dataset: heart },
    },
    sleep: {
      sleep: [
        {
          logId: `mock-sleep-${key}`,
          isMainSleep: true,
          dateOfSleep: selectedDate,
          startTime: stamp(selectedDate, night.bedMinutes),
          endTime: stamp(selectedDate, night.wakeMinutes),
          minutesAsleep: night.minutesAsleep,
          minutesAwake: night.minutesAwake,
          timeInBed: night.minutesInBed,
          efficiency: night.efficiency,
          minutesToFallAsleep: night.minutesToFallAsleep,
          minutesAfterWakeup: 4 + Math.round(seeded(key, 36) * 9),
          levels: sleepLevels(selectedDate, night),
        },
        ...napsForDate(selectedDate),
      ],
    },
    sleepGoal: { goal: { minDuration: 450 } },
    bodyWeight: { weight: trendSeries(selectedDate, 14, (date) => ({ date, weight: vitalsForDate(date).weight, bmi: 22.6 })) },
    bodyFat: { fat: [{ date: selectedDate, fat: Number((17.0 + seeded(key, 85) * 1.2).toFixed(1)) }] },
    weightGoal: { goal: { weight: 73 } },
    water: { summary: { water: 1_500 + Math.round(seeded(key, 86) * 900) } },
    waterGoal: { goal: { goal: 2_500 } },
    food: { summary: { calories: 1_950 + Math.round(seeded(key, 87) * 520) } },
    breathing: { br: [{ value: { breathingRate: vitals.breathingRate } }] },
    hrv: { hrv: [{ value: { dailyRmssd: vitals.hrvDaily, deepRmssd: vitals.hrvDeep } }] },
    spo2: {
      value: {
        avg: vitals.spo2Avg,
        min: Math.round(vitals.spo2Avg - 3 - seeded(key, 88) * 2),
        max: Math.min(100, Math.round(vitals.spo2Avg + 2 + seeded(key, 89) * 2)),
      },
    },
    skinTemperature: { tempSkin: [{ value: { nightlyRelative: vitals.skinTemperature } }] },
    cardio: { cardioScore: [{ value: { vo2Max: '44-48' } }] },
    stepsTrend: { 'activities-steps': trendSeries(selectedDate, 14, (date) => ({ dateTime: date, value: String(vitalsForDate(date).steps) })) },
    caloriesTrend: { 'activities-calories': trendSeries(selectedDate, 14, (date) => ({ dateTime: date, value: String(vitalsForDate(date).calories) })) },
    heartTrend: { 'activities-heart': trendSeries(selectedDate, 14, (date) => ({ dateTime: date, value: { restingHeartRate: vitalsForDate(date).restingHeartRate } })) },
    sleepTrend: {
      sleep: trendSeries(selectedDate, 14, (date) => {
        const trendNight = nightForDate(date)
        return { dateOfSleep: date, isMainSleep: true, minutesAsleep: trendNight.minutesAsleep, efficiency: trendNight.efficiency }
      }),
    },
    activities: {
      activities: loggedWorkout ? [{
        logId: `mock-activity-${key}`,
        activityName: seeded(key, 90) > 0.5 ? 'Outdoor run' : 'Indoor cycling',
        // The same centre the heart series uses, converted from sample index to
        // minutes, so the logged session sits under the day's actual peak.
        startTime: stamp(selectedDate, effortForDate(key).center * HEART_SAMPLE_MINUTES),
        duration: (28 + Math.round(seeded(key, 91) * 26)) * 60_000,
        calories: 280 + Math.round(seeded(key, 92) * 220),
        distance: Number((4.2 + seeded(key, 93) * 4).toFixed(1)),
        averageHeartRate: 132 + Math.round(seeded(key, 94) * 26),
        steps: 4_200 + Math.round(seeded(key, 95) * 2_600),
      }] : [],
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
