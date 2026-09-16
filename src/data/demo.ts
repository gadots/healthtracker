import type { ActivityItem, DashboardData, NapItem, SleepStage, SleepStageKey, SleepStageSegment, TimePoint, TrendPoint } from '../types'

const dayMs = 86_400_000

function localIso(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function dateFromIso(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

/**
 * Stable integer id for a calendar date. Demo values are seeded from this
 * rather than from a day's position in the window, so the numbers for a
 * given date are identical whether that date is rendered as "today", as
 * one of the 14 trend points, or as an entry in the demo archive.
 */
function epochDay(value: string) {
  return Math.round(dateFromIso(value).getTime() / dayMs)
}

function seeded(key: number, salt: number) {
  return Math.sin(key * 12.9898 + salt * 78.233) * 0.5 + 0.5
}

function shiftIso(value: string, days: number) {
  return localIso(new Date(dateFromIso(value).getTime() + days * dayMs))
}

/** Timestamp at `minutesFromMidnight` on `date` (negative reaches the previous evening). */
function atMinutes(date: string, minutesFromMidnight: number) {
  const base = dateFromIso(date)
  return new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime() + minutesFromMidnight * 60_000
}

/** Naive local ISO (no trailing Z) so `new Date(...).getHours()` reads back the intended local clock time. */
function localIsoDateTime(milliseconds: number) {
  const date = new Date(milliseconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`
}

const stagePalette = [
  { name: 'Deep', key: 'deep', color: '#555b64', share: 0.205 },
  { name: 'Light', key: 'light', color: '#858c95', share: 0.55 },
  { name: 'REM', key: 'rem', color: '#bcc1c7', share: 0.245 },
] as const

const timelineSequence: Array<[SleepStageKey, number]> = [
  ['light', 25], ['deep', 35], ['light', 42], ['rem', 18], ['wake', 5],
  ['light', 35], ['deep', 30], ['light', 40], ['rem', 28], ['wake', 8],
  ['light', 36], ['deep', 16], ['light', 40], ['rem', 25], ['wake', 10],
  ['rem', 25], ['wake', 15],
]
const timelineSequenceMinutes = timelineSequence.reduce((sum, [, minutes]) => sum + minutes, 0)

interface DemoNight {
  startTime: string
  endTime: string
  asleepMinutes: number
  awakeMinutes: number
  timeInBedMinutes: number
  efficiency: number
  stages: SleepStage[]
  timeline: SleepStageSegment[]
}

/**
 * Single source of truth for a demo night. Both `makeTrends` and the day
 * payload read from here, so the hypnogram, the header times, `timeInBed`,
 * `efficiency` and `trends[i].sleepMinutes` can never contradict each other.
 *
 * Bed/wake times vary by roughly +-45 and +-35 minutes, with an occasional
 * late night, which lands Sleep Consistency in a believable 70-90 band
 * instead of the perfect 100 a flat generator would produce.
 */
function nightForDate(date: string): DemoNight {
  const key = epochDay(date)
  const lateNight = seeded(key, 33) > 0.85 ? 75 : 0
  const bedMinutes = Math.round(-40 + (seeded(key, 31) - 0.5) * 96 + lateNight)
  const wakeMinutes = Math.round(425 + (seeded(key, 32) - 0.5) * 70)
  const startMs = atMinutes(date, bedMinutes)
  const endMs = atMinutes(date, wakeMinutes)
  const timeInBedMinutes = Math.round((endMs - startMs) / 60_000)
  const awakeMinutes = Math.round(22 + seeded(key, 34) * 34)
  const asleepMinutes = timeInBedMinutes - awakeMinutes

  const deep = Math.round(asleepMinutes * stagePalette[0].share)
  const light = Math.round(asleepMinutes * stagePalette[1].share)
  const stages: SleepStage[] = [
    { name: 'Deep', key: 'deep', minutes: deep, color: stagePalette[0].color },
    { name: 'Light', key: 'light', minutes: light, color: stagePalette[1].color },
    // REM absorbs the rounding remainder so deep+light+rem always equals asleepMinutes.
    { name: 'REM', key: 'rem', minutes: asleepMinutes - deep - light, color: stagePalette[2].color },
    { name: 'Awake', key: 'wake', minutes: awakeMinutes, color: '#363a40' },
  ]

  const scale = timeInBedMinutes / timelineSequenceMinutes
  let cursor = startMs
  const timeline = timelineSequence.map(([type, minutes]) => {
    const startTime = localIsoDateTime(cursor)
    cursor += Math.round(minutes * scale) * 60_000
    return { type, startTime, endTime: localIsoDateTime(cursor) }
  })

  return {
    startTime: localIsoDateTime(startMs),
    endTime: localIsoDateTime(endMs),
    asleepMinutes,
    awakeMinutes,
    timeInBedMinutes,
    efficiency: Math.round(asleepMinutes / timeInBedMinutes * 100),
    stages,
    timeline,
  }
}

function makeTrends(selectedDate: string): TrendPoint[] {
  const formatter = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
  return Array.from({ length: 14 }, (_, index) => {
    const date = shiftIso(selectedDate, index - 13)
    const key = epochDay(date)
    const night = nightForDate(date)
    const activityWave = Math.sin(key * 0.9) * 1_350
    const steps = Math.round(7_200 + activityWave + seeded(key, 2) * 3_100)
    const activeMinutes = Math.round(38 + seeded(key, 5) * 48)
    return {
      date,
      label: formatter.format(dateFromIso(date)).replace('.', ''),
      steps,
      calories: Math.round(1_750 + steps * 0.055),
      distanceKm: Number((steps * 0.00079).toFixed(2)),
      floors: Math.round(5 + seeded(key, 9) * 11),
      activeMinutes,
      zoneMinutes: Math.round(activeMinutes * (0.72 + seeded(key, 10) * 0.45)),
      sedentaryMinutes: Math.round(480 + seeded(key, 11) * 130),
      restingHeartRate: Math.round(59 + seeded(key, 6) * 7),
      hrvMs: Math.round(42 + seeded(key, 12) * 14),
      breathingRate: Number((14.1 + seeded(key, 13) * 1.5).toFixed(1)),
      spo2: Number((96.2 + seeded(key, 14) * 1.6).toFixed(1)),
      skinTemperature: Number((-0.35 + seeded(key, 15) * 0.7).toFixed(1)),
      coreTemperature: null,
      cardioScore: Math.round(49 + seeded(key, 16) * 5),
      sleepMinutes: night.asleepMinutes,
      sleepScore: null,
      sleepEfficiency: night.efficiency,
      weight: Number((72.8 - (13 - index) * 0.045 + seeded(key, 3) * 0.28).toFixed(1)),
      bodyFat: Number((16.9 + seeded(key, 18) * 0.4).toFixed(1)),
      waterMl: Math.round(1_650 + seeded(key, 19) * 850),
      caloriesIn: Math.round(1_720 + seeded(key, 20) * 520),
    }
  })
}

/** Smooth bump centred on a sample index, used to shape walks and workouts. */
function bump(index: number, center: number, halfWidth: number, amplitude: number) {
  const distance = Math.abs(index - center)
  if (distance > halfWidth) return 0
  return amplitude * Math.cos((distance / halfWidth) * (Math.PI / 2))
}

const HEART_SAMPLES_PER_DAY = 288
const HEART_SAMPLE_MINUTES = 24 * 60 / HEART_SAMPLES_PER_DAY

/**
 * Per-day heart rate at the same 5-minute resolution real synced data is
 * compacted to (see compactIntraday in normalize.ts), so demo Day Strain is
 * computed over comparable granularity instead of saturating.
 *
 * Each day gets two walks plus, on roughly three days out of four, a workout
 * at a varying hour and intensity. The remaining rest days still register
 * light zone minutes from the walks, so Strain varies continuously across the
 * archive rather than collapsing to "0 or maxed out".
 */
function makeHeartSeries(date: string): TimePoint[] {
  const key = epochDay(date)
  const restingBase = 55 + seeded(key, 43) * 7
  const isRestDay = seeded(key, 46) < 0.25
  const workoutCenter = Math.round(90 + seeded(key, 44) * 150)
  const workoutPeak = 150 + seeded(key, 45) * 40
  const walkOneCenter = Math.round(108 + seeded(key, 50) * 24)
  const walkTwoCenter = Math.round(156 + seeded(key, 51) * 36)
  const walkAmplitude = 26 + seeded(key, 52) * 18

  return Array.from({ length: HEART_SAMPLES_PER_DAY }, (_, index) => {
    const totalMinutes = index * HEART_SAMPLE_MINUTES
    const hours = Math.floor(totalMinutes / 60)
    const base = hours < 7 ? restingBase : hours < 17 ? restingBase + 14 : restingBase + 9
    const workout = isRestDay ? 0 : bump(index, workoutCenter, 7, workoutPeak - (restingBase + 14))
    const walks = bump(index, walkOneCenter, 5, walkAmplitude) + bump(index, walkTwoCenter, 5, walkAmplitude)
    return {
      time: `${String(hours).padStart(2, '0')}:${String(Math.round(totalMinutes % 60)).padStart(2, '0')}`,
      value: Math.round(base + Math.sin(index * 0.35) * 4 + walks + workout),
    }
  })
}

function makeStepsSeries(): TimePoint[] {
  const values = [0, 0, 0, 0, 0, 0, 45, 420, 510, 180, 230, 340, 680, 320, 210, 460, 290, 370, 1720, 1420, 610, 280, 90, 18]
  return values.map((value, index) => ({
    time: `${String(index).padStart(2, '0')}:00`,
    value,
  }))
}

/** Naps happen on some days and not others, so nap credit in Sleep Need is visibly variable. */
function makeNaps(date: string): NapItem[] {
  const key = epochDay(date)
  if (seeded(key, 47) <= 0.62) return []
  const durationMinutes = Math.round(20 + seeded(key, 48) * 25)
  const startMs = atMinutes(date, Math.round(790 + seeded(key, 49) * 140))
  return [{
    id: `nap-${date}`,
    date,
    startTime: localIsoDateTime(startMs),
    endTime: localIsoDateTime(startMs + durationMinutes * 60_000),
    durationMinutes,
  }]
}

function makeActivities(selectedDate: string): ActivityItem[] {
  return [
    {
      id: 'run-demo',
      name: 'Outdoor run',
      date: selectedDate,
      time: '18:24',
      durationMinutes: 38,
      calories: 438,
      distanceKm: 6.24,
      averageHeartRate: 148,
      zoneMinutes: 52,
      steps: 7_842,
      averagePaceSecondsPerMeter: 38 * 60 / 6_240,
      heartZoneMinutes: { light: 6, moderate: 10, vigorous: 15, peak: 7 },
    },
    {
      id: 'walk-demo',
      name: 'Walk',
      date: selectedDate,
      time: '12:46',
      durationMinutes: 24,
      calories: 116,
      distanceKm: 1.72,
      averageHeartRate: 101,
      zoneMinutes: 8,
      steps: 2_236,
      averagePaceSecondsPerMeter: 24 * 60 / 1_720,
      heartZoneMinutes: { light: 16, moderate: 8, vigorous: 0, peak: 0 },
    },
    {
      id: 'strength-demo',
      name: 'Functional training',
      date: shiftIso(selectedDate, -1),
      time: '19:08',
      durationMinutes: 46,
      calories: 326,
      distanceKm: null,
      averageHeartRate: 126,
      zoneMinutes: 34,
      steps: null,
      averagePaceSecondsPerMeter: null,
      heartZoneMinutes: { light: 10, moderate: 15, vigorous: 18, peak: 3 },
    },
  ]
}

export function createDemoData(selectedDate = localIso()): DashboardData {
  const trends = makeTrends(selectedDate)
  const latest = trends.at(-1)!
  const latestSteps = latest.steps ?? 0
  const latestSleepMinutes = latest.sleepMinutes ?? 0
  const stepsIntraday = makeStepsSeries()
  const heartRateIntraday = makeHeartSeries(selectedDate)
  const heartValues = heartRateIntraday.map((point) => point.value)
  const night = nightForDate(selectedDate)

  return {
    source: 'demo',
    selectedDate,
    generatedAt: new Date().toISOString(),
    profile: {
      displayName: 'Flavio',
      avatar: null,
      memberSince: '2021-03-12',
      timezone: 'Europe/Rome',
    },
    device: {
      id: 'demo-tracker',
      name: 'Google Fitbit Air',
      type: 'SCREENLESS FITNESS TRACKER',
      battery: 'High',
      batteryLevel: 82,
      lastSyncTime: new Date(Date.now() - 6 * 60_000).toISOString(),
      firmware: '20001.194.91',
      features: ['STEPS', 'HEART_RATE', 'SLEEP', 'SPO2', 'SKIN_TEMPERATURE', 'ACTIVE_ZONE_MINUTES'],
    },
    activity: {
      steps: latest.steps,
      stepsGoal: 10_000,
      calories: latest.calories,
      caloriesGoal: 2_450,
      distanceKm: latest.distanceKm,
      distanceGoalKm: 8,
      floors: latest.floors,
      floorsGoal: 10,
      activeMinutes: latest.activeMinutes,
      lightActiveMinutes: 245,
      moderateActiveMinutes: Math.max(0, (latest.activeMinutes ?? 0) - 22),
      vigorousActiveMinutes: 22,
      activeMinutesGoal: 60,
      zoneMinutes: latest.zoneMinutes,
      sedentaryMinutes: latest.sedentaryMinutes,
      stepsIntraday,
      caloriesIntraday: stepsIntraday.map((point, index) => ({
        time: point.time,
        value: Math.round(62 + point.value * 0.055 + Math.sin(index) * 5),
      })),
    },
    health: {
      currentHeartRate: heartValues.at(-1) ?? 72,
      restingHeartRate: latest.restingHeartRate,
      // Derived from the series above, so the numbers on screen agree with the chart.
      heartRateMin: Math.min(...heartValues),
      heartRateMax: Math.max(...heartValues),
      heartRateIntraday,
      hrvMs: latest.hrvMs,
      hrvDeepSleepRmssdMs: (latest.hrvMs ?? 0) + 7,
      hrvEntropy: 3.61,
      nonRemHeartRate: 57,
      breathingRate: latest.breathingRate,
      spo2: latest.spo2,
      spo2Min: (latest.spo2 ?? 97) - 1.8,
      spo2Max: Math.min(100, (latest.spo2 ?? 97) + 1.1),
      skinTemperature: latest.skinTemperature,
      skinNightlyTemperatureCelsius: 33.63,
      skinBaselineTemperatureCelsius: 33.55,
      skinTemperatureStddev30dCelsius: 0.13,
      coreTemperature: null,
      vo2Max: '49–53',
      cardioScore: latest.cardioScore,
      ecgClassification: 'Ritmo sinusale',
      bloodGlucoseMgDl: null,
      irregularRhythmAlerts: 0,
    },
    sleep: {
      totalMinutes: night.asleepMinutes,
      goalMinutes: 480,
      score: latest.sleepScore,
      efficiency: night.efficiency,
      startTime: night.startTime,
      endTime: night.endTime,
      stages: night.stages,
      stageTimeline: night.timeline,
      stageTransitions: { deep: 3, light: 6, rem: 4, wake: 4 },
      minutesToFallAsleep: 0,
      minutesAfterWakeUp: 0,
      timeInBed: night.timeInBedMinutes,
      minutesAwake: night.awakeMinutes,
      naps: makeNaps(selectedDate),
    },
    body: {
      weightKg: latest.weight,
      weightGoalKg: 71.5,
      bmi: 22.6,
      bodyFat: latest.bodyFat,
      waterMl: latest.waterMl,
      waterGoalMl: 2_500,
      caloriesIn: latest.caloriesIn,
    },
    trends,
    activities: makeActivities(selectedDate),
    insights: [
      {
        id: 'activity',
        tone: 'mint',
        title: latestSteps >= 10_000 ? 'Step goal reached' : 'Movement recorded',
        body: latestSteps >= 10_000
          ? 'You exceeded your personal goal of 10,000 steps.'
          : `You are ${(10_000 - latestSteps).toLocaleString('en-US')} steps away from your personal goal.`,
      },
      {
        id: 'sleep',
        tone: 'violet',
        title: 'Sleep duration',
        body: `${latestSleepMinutes < 480 ? `${480 - latestSleepMinutes} minutes short` : 'Goal reached'} compared with your personal goal.`,
      },
      {
        id: 'heart',
        tone: 'blue',
        title: 'Resting heart rate detected',
        body: `${latest.restingHeartRate} bpm: compare it with your personal trend, not with a single day.`,
      },
    ],
    sync: {
      endpointCount: 25,
      successCount: 25,
      errors: [],
      rateLimitRemaining: 126,
    },
  }
}

/**
 * The `dayCount` days ending the day BEFORE `selectedDate`, oldest first —
 * the same "prior cached days" contract the real encrypted archive follows,
 * so demo mode exercises every archive-dependent derived score (Sleep
 * Consistency, Weekly Assessment, a refined Max Heart Rate) exactly the way
 * live data does.
 */
export function createDemoArchive(selectedDate = localIso(), dayCount = 14): DashboardData[] {
  return Array.from({ length: dayCount }, (_, index) => createDemoData(shiftIso(selectedDate, index - dayCount)))
}

export { localIso }
