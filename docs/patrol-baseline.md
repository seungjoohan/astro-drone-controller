# Patrol performance baseline

This is the frozen performance reference for the current uniform-route patrol controller, before population-aware routing or learning. Measurements were collected on October 4, 2026 and archived on October 5, 2026. They are controlled benchmark runs, not replays of the user's manual sessions.

The controller meets the geographic objective with five healthy aircraft in this simplified model, but it does not prioritize populated areas. More aircraft improve population freshness without solving the hotspot deadline problem. These numbers describe only the tested configurations, not globally optimal fleet sizes or real-world camera performance.

## Reproduction and provenance

Run from the repository root after `npm ci`:

```sh
npm run benchmark:patrol
```

Individual suites are available as `benchmark:patrol:performance`, `benchmark:patrol:faults`, and `benchmark:patrol:fidelity`. They write fresh results to ignored `test-results/` files. They do not overwrite the frozen reference files:

- [Performance results](../benchmarks/patrol-baseline-v1/performance.json): 80 healthy scenarios plus a finer temporal-sampling check.
- [Fault results](../benchmarks/patrol-baseline-v1/faults.json): 17 failure and restoration scenarios.
- [Spatial fidelity results](../benchmarks/patrol-baseline-v1/fidelity.json): six fleet/grid comparisons.
- [Manifest](../benchmarks/patrol-baseline-v1/manifest.json): protocols and source provenance.

Compare deterministic metrics, not execution duration or creation timestamps. Floating-point arithmetic may differ slightly between runtimes. The commit containing this archive identifies the baseline implementation; the previously deployed commit does not contain this patrol feature. Do not replace this archive with later learned-policy results.

## Healthy mission protocol

The performance suite uses population seeds `1, 7, 42, 123, 301, 997, 2026, 98765, 104729, 2147483646`. Each mission warms up for 600 simulated seconds, then is measured for 1,200 seconds at 0.5-second intervals. The default seed is also checked at 0.1-second intervals. Startup performance is excluded from these steady-state measurements.

The shared settings are a 320 m circular area, 208 sample points spaced 40 m apart, a 32 m circular sensor footprint, 18 m/s drone speed, and geographic coverage of at least 95% within the preceding 120 seconds. Population defaults are 5,000 people, a crowded threshold of 80 people per sample, and a 15-second crowded-area revisit target. Less populated samples have interpolated deadlines up to 120 seconds.

The table reports equal-weight averages over the ten population scenarios. Geographic minimum is the minimum over their sampled times. Population on-time coverage is the time-average percentage of people meeting their location's deadline, not continuous visibility. Observation age is population weighted. Gap cost is the time average of the population-weighted squared ratio of observation age to the local deadline; lower is better.

| Drones | Minimum geographic freshness | Mean population on time | Mean observation age | Mean gap cost | Mean hotspot residents on time |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 | 72.12% | 34.82% | 76.69 s | 13.905 | 11.87% |
| 4 | 89.90% | 45.86% | 57.01 s | 7.897 | 17.23% |
| 5 | 100.00% | 53.91% | 45.65 s | 5.074 | 19.89% |
| 6 | 100.00% | 61.00% | 36.83 s | 3.281 | 24.07% |
| 8 | 100.00% | 70.59% | 26.70 s | 1.780 | 35.14% |

Four aircraft meet the geographic target at only 20.5% of sampled times. Five, six, and eight meet it at every sampled time. Five-aircraft hotspot observation ages reach 111.14 seconds across the tested seeds, far above the 15-second target.

For the single default scenario, seed 42 with five aircraft, mean population on-time coverage is 58.05%, mean age is 46.26 seconds, gap cost is 3.721, and hotspot residents are on time 18.01% of the time on average. The population-weighted 95th-percentile observation age is approximately 96.5 seconds, using 0.5-second age bins. These single-seed figures must not be confused with the ten-seed averages above. The finer temporal check changes mean population on-time coverage by less than 0.002 percentage points.

## Population sensitivity

Five aircraft use identical routes regardless of population. More people tighten density-dependent deadlines; they do not cause the baseline planner to reallocate attention.

| People | Mean population on time | Mean gap cost |
| --- | ---: | ---: |
| 1,000 | 96.75% | 0.290 |
| 5,000 | 53.91% | 5.074 |
| 10,000 | 36.05% | 9.429 |
| 20,000 | 28.19% | 11.552 |

Each row averages the same ten seeds. Mean observation age remains approximately 45.7 seconds. Because deadlines change with population, gap costs across these rows measure different demand scenarios rather than improvements or regressions in a policy under fixed conditions.

## Failure recovery

Faults occur at mission time 600 seconds; each run continues through 1,800 seconds with 0.25-second measurements. Population is fixed at 5,000 with seed 42. The suite fails each of the five aircraft once for malfunction and once for deviation, each of six aircraft once for malfunction, and includes one five-aircraft failure followed by restoration at time 900 seconds.

- Five to four aircraft: malfunction detection takes 3.0 seconds; deviation detection takes 3.7 seconds in these scenarios. None of the ten cases sustains geographic coverage of at least 95% for 120 consecutive seconds during the 20-minute post-fault interval. The worst observed transient geographic coverage is 77.88%.
- For five-to-four malfunction cases, the last 600 seconds average 93.22% geographic coverage and 49.53% population on-time coverage across the five failed IDs. Geographic coverage meets the target at about 15.08% of sampled times.
- Six to five aircraft: three failed-ID scenarios never drop below 95%; the other three regain it after 88.5 to 98.25 seconds and retain it for the rest of the observation horizon. The worst transient is 90.38%. Every case has 100% geographic freshness in the final 600 seconds, but population on-time coverage averages only 58.11%.
- Restoring aircraft 1 to the original five-aircraft fleet at time 900 regains sustained geographic compliance after another 78.75 seconds.

Recovery requires at least 120 consecutive observed seconds above the geographic target; the report also records whether coverage stays above target for the remainder of the finite run. This is not a guarantee of uninterrupted single-failure tolerance. Fault-report hotspot percentages count crowded cells equally, while performance-report hotspot percentages weight their residents; do not compare those fields as identical measures.

## Spatial fidelity and limitations

An independent evaluator computes analytical observation intervals for the unchanged periodic routes. It measures 120-second freshness every second from times 240 through 1439, using the original 208 points and denser 10 m and 5 m grids. The 5 m grid contains 12,892 points.

Five aircraft maintain 100% freshness at every tested time on all three grids. Four aircraft have 93.10% minimum and 96.05% mean freshness on the 5 m grid, but fall below 95% at 25% of sampled times. The original-grid figures over this different time interval are 89.42% minimum, 93.31% mean, and 79.25% of samples below target. A mean above target does not establish sustained compliance.

Neither grid proves continuous-area coverage. Buildings do not block scans, population is stationary at sample centers, and patrol flight omits launch, batteries, weather, realistic dynamics, and communications faults beyond the modeled health events. The benchmark measures mission quality, not browser frame rate. Population parameters change evaluation, not routing. Future optimizers must retain the same evaluator for baseline comparisons and separately report any upgraded camera or world model.
