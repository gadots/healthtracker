# Home Information Model

The home screen is not a metric catalog. It should answer four questions, in order:

1. **How is the selected day going?**
2. **What is different from my usual baseline or my goal?**
3. **Which data explains the picture?**
4. **Where can I find detail without losing context?**

OpenFit does not generate a proprietary composite score. Every summary must trace back to a measurement, an explicit goal, or a visible personal baseline.

## Metric Hierarchy

| Role | Metrics | Reason |
|---|---|---|
| Hero | steps versus goal, sleep duration versus goal, resting heart rate versus personal average | understandable, comparable, and continuously available |
| Diagnostics | hourly step distribution, 14-day steps / sleep / RHR trends, sleep stages, recent activities | explain when and why the value moved |
| Personal signals | HRV, SpO2, respiration, and skin temperature | meaningful mostly against the same user's baseline |
| Secondary context | weight, body fat, water, and logged calories | useful over time or dependent on diary completeness. They do not define the day by themselves |
| Detail / alerts | intraday HR, ECG, glucose, irregular rhythm, VO2 max | require timestamps, context, or interpretation caution. They appear on home only when an explicit alert exists |
| Operational | device, battery, sync, and errors | indicate reliability and availability, not wellbeing |

## Chart Contract

| Section | Question | Shape | Data and Benchmark | Palette |
|---|---|---|---|---|
| Daily movement | When did I move? | interactive hourly columns | 24 buckets, exact value on hover / focus | activity, single root |
| Sleep | How long and how well did I sleep? | duration + score / efficiency ring + stacked bar | personal goal, stages over the recorded period | sleep, monochrome scale |
| 14-day steps | Is movement volume changing? | daily columns | 14 days, goal line when available | activity |
| 14-day sleep | Is duration consistent? | daily columns | 14 nights, goal line | sleep |
| 14-day RHR | Is resting heart rate different from my usual? | line | personal average from the previous 7 days | heart |
| Night signals | What changed compared with me? | scorecards, no chart for a single observation | personal average when at least 3 previous days exist | recovery |

Color identifies a category, not a clinical state. Text, icon, shape, and unit must preserve meaning without color.

## Interpretation Rules

- User-configured goals take precedence over generic thresholds. `10,000 steps` is not treated as a universal medical threshold.
- HRV, RHR, respiration, SpO2, and temperature are compared first with the user's personal baseline.
- A single nightly reading is described, not diagnosed.
- Skin temperature is a deviation from the device baseline, not body temperature.
- Sleep stages are estimates from movement and heart rate. Duration and trend remain the main context.
- Weight and body fat should be read as trends. Bioimpedance is an estimate that depends on measurement conditions.
- Water and calorie intake are labeled as logged. Missing logs do not equal zero.
- `successCount / endpointCount` describes completed API reads, not clinical data completeness.

## Reference Sources

- [Fitbit: health metrics and personal ranges](https://support.google.com/fitbit/answer/14236917?hl=en)
- [Fitbit: heart rate and HRV](https://support.google.com/fitbit/answer/14237938?hl=en)
- [Fitbit: sleep score](https://support.google.com/fitbit/answer/14236513?hl=en)
- [Fitbit: sleep stages estimate](https://support.google.com/fitbit/answer/14236712?hl=en-CA)
- [Fitbit: Active Zone Minutes](https://support.google.com/fitbit/answer/14236509?hl=en)
- [Fitbit: skin temperature and baseline](https://support.google.com/fitbit/answer/14237207?hl=en)
- [CDC: sleep duration](https://www.cdc.gov/sleep/about/)
- [WHO: physical activity](https://www.who.int/health-topics/noncommunicable-diseases/physical-activity)
