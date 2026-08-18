import type { DashboardData, HeartZoneMinutes } from '@/types'
import { compareWithPersonalBaseline, type BaselineComparison } from './home-analysis'

// OpenFit-original derived scores. Every function here is a pure function
// over already-normalized DashboardData, following the same convention as
// home-analysis.ts: no network, no IPC, no side effects, fully unit
// testable against createDemoData() fixtures. See docs/DERIVED_SCORES.md
// for the documented formula and inputs behind each score, and
// docs/HOME_DASHBOARD_MODEL.md for why these exist alongside raw
// measurements without pretending to reproduce a manufacturer's
// proprietary algorithm.

/** How a value compares with the user's own typical range for that metric. */
export type RangeFlag = 'typical' | 'above-range' | 'below-range' | 'insufficient-data'

/**
 * Merges the currently viewed day with the locally cached archive into one
 * chronological, de-duplicated history (the viewed day wins over a stale
 * cached copy of the same date). Shared by every archive-dependent score
 * below instead of each one re-deriving it.
 */
export function mergedDayHistory(data: DashboardData, archiveDays: DashboardData[]): DashboardData[] {
  const byDate = new Map<string, DashboardData>()
  for (const day of archiveDays) byDate.set(day.selectedDate, day)
  byDate.set(data.selectedDate, data)
  return [...byDate.values()].sort((left, right) => left.selectedDate.localeCompare(right.selectedDate))
}

function flagFromComparison(comparison: BaselineComparison, minSampleCount = 3): RangeFlag {
  if (comparison.current === null || comparison.sampleCount < minSampleCount || comparison.stddev === null || comparison.stddev === 0) {
    return 'insufficient-data'
  }
  const deviations = (comparison.current - comparison.baseline!) / comparison.stddev
  if (deviations >= 1.5) return 'above-range'
  if (deviations <= -1.5) return 'below-range'
  return 'typical'
}

// --- Max Heart Rate --------------------------------------------------------

export interface MaxHeartRateEstimate {
  bpm: number | null
  /** Date the highest reading so far was recorded. */
  observedAt: string | null
  /** How many days (including today) contributed a heartRateMax reading. */
  sampleDays: number
  /** True when the estimate rests on the selected day alone (no cached history yet). */
  isTodayOnly: boolean
}

/**
 * The highest heart rate ever observed across the local history, refined
 * automatically as more days accumulate in the cache — mirrors how a
 * personalized max HR should only ever move up when a genuinely higher
 * reading appears, never down.
 */
export function estimateMaxHeartRate(data: DashboardData, archiveDays: DashboardData[]): MaxHeartRateEstimate {
  const days = mergedDayHistory(data, archiveDays)
  let best: { bpm: number; date: string } | null = null
  let sampleDays = 0
  for (const day of days) {
    const candidate = day.health.heartRateMax
    if (candidate === null || !Number.isFinite(candidate)) continue
    sampleDays += 1
    if (!best || candidate > best.bpm) best = { bpm: candidate, date: day.selectedDate }
  }
  return {
    bpm: best?.bpm ?? null,
    observedAt: best?.date ?? null,
    sampleDays,
    isTodayOnly: archiveDays.length === 0,
  }
}

// --- Health Monitor ----------------------------------------------------

export interface HealthMonitorMetric {
  key: 'restingHeartRate' | 'hrv' | 'breathingRate' | 'spo2' | 'skinTemperature'
  label: string
  value: number | null
  unit: string
  flag: RangeFlag
  comparison: BaselineComparison
}

export interface HealthMonitorPanel {
  metrics: HealthMonitorMetric[]
  /** True when at least one metric has enough history to be flagged (typical or not). */
  hasFlags: boolean
}

/**
 * Last night's key recovery-adjacent vitals, each flagged against the
 * user's own trailing 7-day typical range (>=1.5 personal standard
 * deviations away). This does not diagnose anything — it is the same
 * "compare with yourself" pattern already used elsewhere in OpenFit,
 * just assembled into one panel instead of scattered scorecards.
 */
export function buildHealthMonitor(data: DashboardData): HealthMonitorPanel {
  const entries: Array<[HealthMonitorMetric['key'], string, number | null, string, (point: DashboardData['trends'][number]) => number | null]> = [
    ['restingHeartRate', 'Resting heart rate', data.health.restingHeartRate, 'bpm', (point) => point.restingHeartRate],
    ['hrv', 'HRV', data.health.hrvMs, 'ms', (point) => point.hrvMs],
    ['breathingRate', 'Breathing rate', data.health.breathingRate, 'rpm', (point) => point.breathingRate],
    ['spo2', 'Blood oxygen', data.health.spo2, '%', (point) => point.spo2],
    ['skinTemperature', 'Skin temperature', data.health.skinTemperature, '°C', (point) => point.skinTemperature],
  ]

  const metrics: HealthMonitorMetric[] = entries.map(([key, label, value, unit, selector]) => {
    const comparison = compareWithPersonalBaseline(data, value, selector)
    return { key, label, value, unit, flag: flagFromComparison(comparison), comparison }
  }).filter((metric) => metric.value !== null)

  return {
    metrics,
    hasFlags: metrics.some((metric) => metric.flag !== 'insufficient-data'),
  }
}

// --- Daily Heart Rate Zones & Day Strain --------------------------------

const STRAIN_ZONE_MULTIPLIERS: Record<keyof HeartZoneMinutes, number> = {
  light: 0.2,
  moderate: 0.55,
  vigorous: 0.85,
  peak: 1,
}

const MIN_INTRADAY_MINUTES_FOR_STRAIN = 180

export interface DailyHeartRateZones {
  zones: HeartZoneMinutes
  coveredMinutes: number
  maxHeartRate: number | null
}

function timeToMinutes(time: string): number | null {
  const match = time.match(/(\d{1,2}):(\d{2})/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/**
 * Average gap between consecutive samples, in minutes. Real synced data is
 * compacted to at most 288 points/day (see compactIntraday in
 * normalize.ts), so one sample can represent several real minutes;
 * inferring the interval from the actual timestamps (rather than assuming
 * "1 sample = 1 minute") keeps the zone/strain minutes honest for both
 * real and demo data.
 */
function averageSampleIntervalMinutes(times: string[]): number {
  const minutes = times.map(timeToMinutes).filter((value): value is number => value !== null)
  if (minutes.length < 2) return minutes.length === 1 ? 1 : 0
  let totalDelta = 0
  let count = 0
  for (let index = 1; index < minutes.length; index += 1) {
    const delta = minutes[index] - minutes[index - 1]
    if (delta > 0) { totalDelta += delta; count += 1 }
  }
  return count ? totalDelta / count : 1
}

/**
 * Buckets every intraday heart-rate sample of the selected day into the
 * same 4-zone taxonomy already used per-workout (light/moderate/vigorous/
 * peak — see ActivityItem.heartZoneMinutes), using the personalized Max
 * Heart Rate as the ceiling.
 */
export function computeDailyHeartRateZones(data: DashboardData, archiveDays: DashboardData[]): DailyHeartRateZones | null {
  const maxHeartRate = estimateMaxHeartRate(data, archiveDays).bpm
  const samples = data.health.heartRateIntraday
  const intervalMinutes = averageSampleIntervalMinutes(samples.map((sample) => sample.time))
  const coveredMinutes = Math.round(samples.length * intervalMinutes)
  if (!maxHeartRate || coveredMinutes < MIN_INTRADAY_MINUTES_FOR_STRAIN) return null

  const zones: HeartZoneMinutes = { light: 0, moderate: 0, vigorous: 0, peak: 0 }
  for (const sample of samples) {
    const percentOfMax = sample.value / maxHeartRate
    if (percentOfMax < 0.5) continue
    if (percentOfMax < 0.6) zones.light = (zones.light ?? 0) + intervalMinutes
    else if (percentOfMax < 0.7) zones.moderate = (zones.moderate ?? 0) + intervalMinutes
    else if (percentOfMax < 0.85) zones.vigorous = (zones.vigorous ?? 0) + intervalMinutes
    else zones.peak = (zones.peak ?? 0) + intervalMinutes
  }
  for (const key of Object.keys(zones) as Array<keyof HeartZoneMinutes>) {
    zones[key] = zones[key] === null ? null : Math.round(zones[key] as number)
  }

  return { zones, coveredMinutes, maxHeartRate }
}

export interface DayStrainScore {
  value: number | null
  band: 'light' | 'moderate' | 'strenuous' | 'all-out' | null
  zones: HeartZoneMinutes
}

function strainBand(value: number) {
  if (value < 10) return 'light' as const
  if (value < 14) return 'moderate' as const
  if (value < 18) return 'strenuous' as const
  return 'all-out' as const
}

/**
 * A 0-21, logarithmic estimate of the day's cumulative cardiovascular
 * exertion: each zone-minute contributes a weighted "load" point
 * (heavier zones weigh more), and the total is log-compressed so the
 * scale saturates the way a whole day of sustained high heart rate should,
 * rather than growing linearly forever. This is an OpenFit approximation
 * of the concept, not a reproduction of any manufacturer's formula.
 */
export function computeDayStrain(data: DashboardData, archiveDays: DashboardData[]): DayStrainScore {
  const zoneResult = computeDailyHeartRateZones(data, archiveDays)
  if (!zoneResult) return { value: null, band: null, zones: { light: 0, moderate: 0, vigorous: 0, peak: 0 } }

  const load = (Object.keys(STRAIN_ZONE_MULTIPLIERS) as Array<keyof HeartZoneMinutes>)
    .reduce((sum, zone) => sum + (zoneResult.zones[zone] ?? 0) * STRAIN_ZONE_MULTIPLIERS[zone], 0)

  // log1p keeps a fully sedentary day near 0 and compresses very high load
  // into the top of the scale instead of overflowing it.
  const value = Math.min(21, Number((Math.log1p(load) * 4.2).toFixed(1)))
  return { value, band: strainBand(value), zones: zoneResult.zones }
}

// --- Sleep Performance ---------------------------------------------------

const DEFAULT_SLEEP_NEED_MINUTES = 480

export interface SleepPerformanceScore {
  percent: number | null
  band: 'poor' | 'fair' | 'good' | 'excellent' | null
  actualMinutes: number | null
  neededMinutes: number | null
}

function sleepPerformanceBand(percent: number) {
  if (percent >= 90) return 'excellent' as const
  if (percent >= 75) return 'good' as const
  if (percent >= 60) return 'fair' as const
  return 'poor' as const
}

/**
 * Actual sleep versus a Sleep Need target — a static personal/default goal
 * for now (`neededMinutes`); Tier 3's dynamic Sleep Need (strain- and
 * debt-adjusted) can be passed in later without changing this function's
 * shape, only the `neededMinutes` argument callers supply.
 */
export function computeSleepPerformance(data: DashboardData, neededMinutes: number | null = data.sleep.goalMinutes ?? DEFAULT_SLEEP_NEED_MINUTES): SleepPerformanceScore {
  const actualMinutes = data.sleep.totalMinutes
  if (actualMinutes === null || neededMinutes === null || neededMinutes <= 0) {
    return { percent: null, band: null, actualMinutes, neededMinutes }
  }
  const percent = Math.max(0, Math.min(100, Math.round(actualMinutes / neededMinutes * 100)))
  return { percent, band: sleepPerformanceBand(percent), actualMinutes, neededMinutes }
}

// --- Recovery Score --------------------------------------------------------

export interface RecoveryScore {
  value: number | null
  band: 'low' | 'moderate' | 'high' | null
  componentCount: number
}

function recoveryBand(value: number) {
  if (value >= 67) return 'high' as const
  if (value >= 34) return 'moderate' as const
  return 'low' as const
}

/** Maps a personal-baseline comparison to a 0-100 "how favorable is this today" score, direction-aware per metric. */
function componentScore(comparison: BaselineComparison, higherIsBetter: boolean): number | null {
  if (comparison.current === null || comparison.baseline === null || comparison.sampleCount < 3 || !comparison.stddev) return null
  const deviations = (comparison.current - comparison.baseline) / comparison.stddev
  const signed = higherIsBetter ? deviations : -deviations
  // Squash to 0-100 around the baseline (deviation 0 -> 50), saturating by +-2 stddev.
  return Math.round(Math.max(0, Math.min(100, 50 + signed * 25)))
}

/**
 * A 0-100 estimate of how favorable today's HRV, resting heart rate,
 * breathing rate, and last night's Sleep Performance look relative to the
 * user's own recent typical range. Needs at least 2 of its 4 inputs to
 * have enough history; otherwise it is hidden rather than guessed.
 */
export function computeRecoveryScore(data: DashboardData, sleepPerformance: SleepPerformanceScore): RecoveryScore {
  const hrv = compareWithPersonalBaseline(data, data.health.hrvMs, (point) => point.hrvMs)
  const restingHeartRate = compareWithPersonalBaseline(data, data.health.restingHeartRate, (point) => point.restingHeartRate)
  const breathingRate = compareWithPersonalBaseline(data, data.health.breathingRate, (point) => point.breathingRate)

  const components = [
    componentScore(hrv, true),
    componentScore(restingHeartRate, false),
    componentScore(breathingRate, false),
    sleepPerformance.percent,
  ].filter((value): value is number => value !== null)

  if (components.length < 2) return { value: null, band: null, componentCount: components.length }
  const value = Math.round(components.reduce((sum, item) => sum + item, 0) / components.length)
  return { value, band: recoveryBand(value), componentCount: components.length }
}
