# Derived Scores

OpenFit computes a small set of composite estimates on top of the raw measurements returned by Google Health API v4 (or the legacy Fitbit adapter). They exist because a raw number like "HRV 47 ms" is hard to act on without knowing whether it is normal *for you*, and because the concepts they express — how recovered you are, how hard a day was, whether you slept enough — are genuinely useful.

**What these are not:**

- They are **not** a reproduction of any manufacturer's proprietary algorithm. Whoop's Recovery/Strain, Fitbit's Readiness/Sleep Score, and similar are closed formulas that are not published and not exposed through any API OpenFit reads. The scores below are OpenFit's own, deliberately simple, documented formulas over the same underlying signals.
- They are **not** medical measurements, diagnoses, or a medical device. They describe patterns in your own data over time.
- They are **not** shown when the data behind them is too thin. Every score has a minimum-sample-size gate and is hidden entirely rather than displayed at low confidence (see the "Hidden when" column).

All of this logic lives in `src/lib/scores.ts` as pure functions, unit tested in `src/lib/scores.test.ts`. Nothing here calls the network or touches the Electron main process — the scores are computed in the renderer from data already synced and normalized.

## Inputs and availability

| Score | Formula (plain language) | Inputs | Hidden when |
|---|---|---|---|
| **Max Heart Rate** | The highest heart rate ever observed across the local history. Only ever ratchets upward as higher readings appear. | `health.heartRateMax` per day (selected day + cached archive) | No heart-rate data anywhere. With no archive yet, uses the selected day alone and labels itself "today only". |
| **Health Monitor** | Each of last night's vitals is compared with its own trailing 7-day mean; flagged as above/below your typical range when it is at least 1.5 personal standard deviations away. | Resting HR, HRV, breathing rate, SpO2, skin temperature + their 7-day trends | Per metric: no value today, or fewer than 3 prior days with data (shown as "building your typical range"). |
| **Daily Heart Rate Zones** | Every intraday HR sample is bucketed into light (50–60% of max), moderate (60–70%), vigorous (70–85%), or peak (85%+) using the personalized Max HR. Sample spacing is inferred from timestamps, so compacted real data counts correct minutes. | `health.heartRateIntraday`, Max Heart Rate | No Max HR, or under ~3 hours of intraday HR coverage that day. |
| **Day Strain (0–21)** | Each zone-minute contributes weighted load (light 0.2, moderate 0.55, vigorous 0.85, peak 1.0); the total is log-compressed (`log1p(load) × 4.2`, capped at 21) so a sedentary day sits near 0 and a very hard day saturates the top of the scale instead of growing without bound. | Daily Heart Rate Zones | Same gate as Daily Heart Rate Zones. |
| **Sleep Performance (%)** | Actual sleep duration as a percentage of the Sleep Need target, clamped to 0–100. | `sleep.totalMinutes`, Sleep Need (or the static sleep goal as fallback) | No recorded sleep duration for the night. |
| **Recovery (0–100)** | Averages up to four components, each scored 0–100 by how favorable it is versus your own baseline (HRV higher is better; resting HR and breathing rate lower is better; plus Sleep Performance directly). Each baseline component maps ±2 personal standard deviations onto the 0–100 range, centered at 50. | HRV, resting HR, breathing rate (each vs. 7-day baseline), Sleep Performance | Fewer than 2 of the 4 components have enough history (each needs ≥3 prior days). |
| **Sleep Debt** | Sum of each night's shortfall against the sleep need over the trailing 14 nights, floored at zero per night so a long sleep never creates negative debt. | `trends[].sleepMinutes`, sleep goal | Fewer than 7 nights with a recorded duration. |
| **Sleep Need** | Your sleep goal as a baseline, plus extra for a hard day (4 min per Strain point above 8), plus a third of any accumulated Sleep Debt (repaid gradually, capped at 120 min of debt considered), minus minutes already napped today. Floored at 5 hours. | Sleep goal, Day Strain, Sleep Debt, naps | Sleep Debt unavailable — Sleep Performance then falls back to the static goal rather than breaking. |
| **Sleep Consistency (0–100)** | Averages a bedtime-stability and a wake-time-stability score over the last 7 archived nights. Each is the spread (standard deviation) of those clock times mapped so 0 minutes of spread = 100 and ≥2 hours = 0. Times are shifted around midnight so a 23:42 and a 00:15 bedtime count as close together. | `sleep.startTime` / `sleep.endTime` from cached archive days | Fewer than 4 nights with both timestamps. |
| **Weekly Assessment** | Average Sleep Performance across the last 7 archived nights, paired with Sleep Consistency. | Sleep Performance per night, Sleep Consistency | Fewer than 5 nights with a Sleep Performance value. |

## Where the history comes from

Two different sources, deliberately:

- **`data.trends`** — the 14-day window embedded in every sync payload (see `trendStart` in `electron/google-health-service.cjs`). Always present, so baseline comparisons, Sleep Debt, and Sleep Need work even on a fresh install.
- **`archiveDays`** — the locally cached, encrypted per-day archive (`electron/health-cache.cjs`), normalized by `normalizeHealthArchive` in `src/data/normalize.ts` and loaded in `src/App.tsx`. Only contains days the user has actually synced/opened, so it is used only where `TrendPoint` genuinely lacks the field: Max Heart Rate (needs `heartRateMax`), intraday zones/Strain (needs `heartRateIntraday`), and Sleep Consistency (needs sleep start/end timestamps).

## Verifying them without a connected account

Demo mode ships a full 14-day synthetic archive (`createDemoArchive` in `src/data/demo.ts`), not just a single day, so **every** score above — including the archive-dependent ones (Sleep Consistency, Weekly Assessment, a refined Max Heart Rate) — renders and can be checked without connecting a real account. Demo values are seeded from the calendar date rather than from a day's position in the window, which means:

- the numbers for a given date are identical whether that date is shown as "today", as a trend point, or as an archive entry;
- bed/wake times, heart-rate series, workout intensity and naps genuinely differ day to day, so Sleep Consistency lands in a believable band instead of a suspicious 100 and Day Strain varies continuously across the archive.

`src/lib/scores.test.ts` encodes this as a regression test (`demo mode surfaces every derived score`): if a future change makes any score disappear in demo mode, or flattens the generated data, that test fails.

Which data you are looking at is always visible in the top bar, and the source can be switched in **Settings -> Data source** (see `docs/ARCHITECTURE.md`).

## Where they appear

- **Today** — Recovery tile in the Overview grid.
- **Health** — Recovery card, Health Monitor panel, Max Heart Rate stat.
- **Activity** — Day Strain gauge and heart-rate zone breakdown.
- **Sleep** — Sleep Performance bullet, Naps panel, and the Sleep Need / Sleep Debt / Sleep Consistency / Weekly Sleep Performance stats.
- **AI assistant** — all of the above are included in the compact context sent to Claude or Codex (`buildHealthAssistantContext` in `src/lib/health-assistant.ts`) under `derivedScores`, alongside the disclaimer, so the assistant can answer questions like "why is my Recovery low today?" from the same numbers the UI shows. Scores that are unavailable are omitted rather than sent as nulls.

## Changing a formula

These are intentionally simple and easy to tune. If you change a weight, threshold, or gate:

1. Update the function in `src/lib/scores.ts` and its tests in `src/lib/scores.test.ts` (every score has an explicit "not enough data → null" test that must keep passing).
2. Update the corresponding row in the table above.
3. Run `npm run check`.
