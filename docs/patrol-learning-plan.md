# Patrol learning pilot and next milestones

The local routing and bounded robustness pilot is implemented. It searches **fleet size, centralized routing parameters and a patrol-speed fraction together** through seeded simulation-based parameter search, not a neural network. New experiments can test diverse synthetic environments with limited endurance and charging. The operator explicitly starts an experiment; background trials do not alter the visible patrol mission. Results describe the **best strategies tested on a finite scenario suite**, not a globally optimal controller, a proven minimum fleet, or a strategy guaranteed to work in every condition.

The historical reference remains [patrol baseline v1](patrol-baseline.md), recorded in commit `a64256f`, with frozen raw results in `benchmarks/patrol-baseline-v1/`. Across its ten published 5,000-person scenarios, five uniform-route drones achieved 53.9137% mean population on-time coverage and 5.0736 mean gap cost despite 100% sampled geographic freshness. The uniform engine remains available for regression checks and matched comparisons. Learning does not commit, push, deploy, or control physical aircraft.

## Implemented scope

- Search fleet sizes 1–8 from the first generation, not a five-drone-only improvement phase. A compute-budget interruption can leave evaluations incomplete; the UI does not claim untested fleets were evaluated.
- Keep one adaptive incumbent per fleet and a separate uniform baseline per size. Subsequent generations mutate bounded parameters and retain candidates using training results.
- Keep scenario population totals and seeds, sensing radius, maximum speed, battery specifications, geographic targets, crowded-area deadlines, and density thresholds outside the learned action space. Scenarios may vary these environmental constraints; the optimizer cannot lower requirements to improve a score. It may learn a patrol speed between 50% and 100% of the scenario's maximum.
- Keep fleet size fixed within each trial. Failed aircraft remain part of deployed cost; policies cannot spawn, remove, or teleport aircraft.
- Run held-out healthy evaluations and a separate one-drone-loss check when budget permits. Incomplete evaluations are not scored or eligible for application.
- Report fleet/service trade-offs and unmet requirements. Lower gap cost alone does not establish feasibility.
- Preserve the classic unlimited-endurance visible mission by default. New learning runs default to the diverse profile; restoring a legacy report retains its current-mission profile.

The model still uses stationary population and circular overhead sensing with no building occlusion. Aircraft fly in separate altitude lanes above the buildings. This is not a low-altitude visibility or collision-avoidance learning system.

## Objective and pilot gates

The continuous population objective is unchanged:

```text
gapCost(time) = sum(people[cell] * (age[cell] / deadline[cell])^2) / totalPeople
```

Smaller observation gaps remain better before a deadline is missed. Never-observed cells retain the conservative age `missionTime + deadline` and never count as fresh. With no people, population objectives are not applicable rather than perfect scores. Episode means are time-weighted 0.5-second samples, not exact continuous-time integrals.

| Recorded metric | Meaning |
| --- | --- |
| Geographic minimum/mean | Freshness on 40 m planning samples; 208 in the classic environment, with counts changing for other boundaries. |
| Dense-audit minimum/mean | Separate geographic freshness on an offset 10 m grid. |
| Area-target fraction | Fraction of evaluation samples where both grids meet the configured target. |
| Population on-time share | Population-weighted share meeting location-specific deadlines. |
| Hotspot on-time share | Population-weighted share meeting deadlines in crowded cells. |
| Weighted age and gap cost | Population service averaged over the scored episode. |
| Maximum observation age | Worst sampled planning-cell age, including conservative unseen ages. |
| Never-observed people | Maximum unseen population during the scored interval. |
| Sampled travel distance | Sum of aircraft displacement between evaluation snapshots, not exact path length or energy use. |
| Feasible scenario fraction | Share of complete scenarios meeting all sampled service and energy checks. |
| Worst-case gap cost | Largest scenario-mean gap cost, not a percentile or the largest instantaneous gap. |
| Energy and service totals | Full-pack-equivalent energy use, completed charges, reserve breaches and stranded-aircraft counts. These totals include warm-up, unlike the scored service averages. |

A candidate receives the pilot's **tested feasible** label only when held-out healthy trials satisfy every sampled check:

1. Both geographic grids meet the configured freshness target at every evaluation sample.
2. Every crowded location meets its deadline at every evaluation sample. An empty hotspot set does not fail this check.
3. No people remain never observed during the evaluated interval.
4. No aircraft strands and no battery reserve breach occurs, including during warm-up. Every completed scenario must pass, not just the aggregate average.

These are strict pilot labels, not an agreed operational tolerance for hotspot misses or recovery. Among passing candidates, the recommendation chooses the smallest tested fleet, then better service metrics. If none passes, it reports that no tested strategy meets the requirements; it does not relax targets automatically.

Training first ranks fewer stranded-aircraft events and reserve breaches, then feasibility and feasible-scenario share. Among remaining infeasible candidates, a composite geographic/hotspot deficit guides exploration; unseen population, worst-case gap cost, mean gap cost and sampled distance provide further comparisons. This score is not permission to exchange missed service requirements for fewer drones. The non-dominated frontier retains fleet/service/energy trade-offs, comparing training-only and held-out candidates separately.

Failure outcomes remain separate from the healthy recommendation. A healthy feasible result is **not** a resilient-fleet recommendation.

## Controller and engine

The uniform route family remains inside `PatrolSystem`, generalized to the selected boundary and maximum speed; the classic unlimited configuration remains the historical regression control. The adaptive policy chooses high-level destinations and one bounded patrol-speed fraction; it cannot change sensors, altitude lanes, motor outputs, battery specifications, or evaluation outcomes.

- The planner now keeps a separate 20 m geographic observation-age grid, updated by swept sensing, rather than treating visits to sparse population-cell centers as complete area coverage. Candidate destinations include this grid's centers. The independent 10 m audit remains separate and can still expose uncovered gaps.
- Precomputed footprints combine population samples and denser geographic samples so a destination can observe several locations.
- Healthy and not-yet-confirmed aircraft retain contiguous geographic responsibility bands as a soft preference. This reduces clustering while permitting useful cross-region visits.
- Footprint scores combine population urgency, observation age, approaching geographic deadlines, travel cost, and destinations reserved for other aircraft.
- Commands are assigned centrally. Confirmed failures and aircraft leaving or rejoining patrol for charging cause available aircraft's responsibility bands to be redistributed.
- Decisions run on an internal one-second simulation clock, independent of rendering or caller step size. Normal commands persist until both minimum commitment and the current leg are complete; health/strategy replanning can replace them sooner.

| Learned parameter | Range | Initial default |
| --- | --- | --- |
| `populationWeight` | 0–20 | 2 |
| `coverageWeight` | 0.01–30 | 20 |
| `ageExponent` | 1–4 | 2 |
| `travelPenalty` | 0–5 | 1 |
| `commitmentSeconds` | 1–15 seconds | 3 |
| `speedFraction` | 0.5–1 | 1 |

Speed search is enabled for diverse or battery-enabled experiments. Classic unlimited current-mission trials retain maximum-speed behavior for a matched control. The selected fraction is constant for patrol legs in that policy, not a context-sensitive acceleration or speed-control network. Return-to-base legs use the environment's maximum speed. Fleet size is selected by comparing finite trials, not by a learned function that chooses a fleet from arbitrary environmental inputs.

Strategies and command destinations are validated. The planner receives detached observation and aircraft data, not future fault schedules, injection flags, or mutable simulator references. Pending unresponsive/deviating aircraft keep their prior destination reservations and ownership until watchdog confirmation; their fault legs are not reset by periodic decisions or strategy swaps. Their faulty sensors still receive no observation credit.

Movement, geofence/altitude enforcement, and exact swept sensing on the planning grid remain engine responsibilities. All strategies start at the same fleet-indexed uniform staging positions, with no free placement advantage. `setStrategy` preserves positions, elapsed time, observation history, and health evidence. Adaptive routes and battery-service interruptions have no valid periodic cycle or conservative uniform coverage guarantee; the UI marks those estimates unavailable. The mission form's historical fleet estimate is restricted to the classic unlimited configuration.

## Synthetic environments and endurance

The mission form stages environment and aircraft changes until **Apply and reset**. Presets provide a 640 m classic circle, a 360 m compact circle, a 520 × 360 m district and a 600 × 160 m corridor. The visible map uses the corresponding boundary and marks the charging depot when endurance is enabled. Maximum speed, endurance reference, recharge time and charging-pad count are configurable. The diverse training generator samples its own reproducible environments rather than copying the visible preset.

Battery state is a fraction of one synthetic full pack. For airborne speed `v` and the environment's maximum speed `vMax`, the discharge model is:

```text
packFractionPerSecond = (0.55 + 0.45 * (v / vMax)^2) / enduranceSeconds
```

`enduranceSeconds` is the full-pack duration at maximum speed without reserves or interruptions, not guaranteed useful patrol time. Hovering still consumes 55% of the maximum-speed reference rate. The engine checks the energy required for the next patrol leg, direct return transit and reserve before continuing; the policy cannot disable this service rule. This prevents additional unsafe patrol legs, not every possible energy failure: arbitrary initial staging may already lack sufficient return energy, and injected faults can make recovery impossible. Those cases retain their violation counters and cannot pass feasibility checks.

Aircraft move through **patrol → returning → waiting → charging → patrol**. Return transit is physical horizontal movement, not teleportation. A fixed-capacity depot serves waiting aircraft in arrival order; charging adds `1 / rechargeSeconds` pack fraction per second, so partial recharge time depends on arrival charge. Waiting and charging do not consume airborne energy. Returning, waiting, charging and faulted aircraft receive no patrol sensing credit. Available aircraft inherit the departed aircraft's work, but redistribution does not create replacement capacity.

This is an explicit abstraction: altitude is unchanged at the depot, and there is no descent, landing, takeoff, acceleration, wind, payload, battery aging or building-occlusion model. It is not a validated real-drone endurance model. Charging telemetry and reserve checks therefore describe simulation behavior, not hardware safety.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/patrol.ts` | Motion, sensing, health, baseline planning, and strategy integration. |
| `src/patrol-policy.ts` | Bounded strategy validation and footprint scheduling. |
| `src/patrol-environment.ts` | Validated boundaries, synthetic aircraft specifications, presets and discharge model. |
| `src/patrol-scenarios.ts` | Reproducible current/diverse scenario families and disjoint seed splits. |
| `src/patrol-learning-types.ts` | Strategy, metric, experiment, progress, and worker contracts. |
| `src/patrol-evaluator.ts` | Deterministic short episodes and accumulated metrics. |
| `src/patrol-audit.ts` | Independent dense geographic observation audit. |
| `src/patrol-search.ts` | Seeded joint search, incumbents, frontier, and healthy recommendation. |
| `src/patrol-training.worker.ts` | Background execution and pause/resume/cancel messaging. |
| `src/patrol-learning-checkpoint.ts` | Versioned settings/report validation and JSON serialization. |
| `src/patrol-learning-panel.ts` | Controls, results, local persistence, and explicit test-mission actions. |
| `scripts/benchmark-patrol-learning.mjs` | Headless pilot benchmark using the same search and evaluator. |

Tests cover policy/command validation, detached inputs, stepping invariance, shared staging, health preservation, evaluator aggregation, dense auditing, search controls, frontier/recommendation rules, checkpoint validation, and integrated browser controls. These verify implementation behavior, not general strategy feasibility.

## Evaluation protocol

Current identifier: `patrol-robustness-v2-energy-grid40-audit10-dt0.5`. Legacy v1 reports retain their original evaluator identity and remain read-only.

**Current-mission profile:** fixed captured geometry, population count and aircraft constraints, with different population seeds. Unlimited-endurance durations remain:

| Split | Scenarios | Warm-up per scenario | Scored duration per scenario |
| --- | --- | --- | --- |
| Training | Two population seeds | 120 seconds | 240 seconds |
| Held-out healthy validation | Two different population seeds | 120 seconds | 360 seconds |
| Separate failure check | One additional population seed | 120 seconds | 360 seconds |

For a battery-enabled current mission, each scored episode instead lasts `3 × (enduranceSeconds + rechargeSeconds)`, with the same 120-second warm-up. This spans three nominal service-cycle periods; queues and patrol behavior may produce fewer than three completed charges per aircraft. Its fault check injects a malfunction, while classic unlimited checks retain malfunction/deviation variation.

**Diverse profile:** the operator selects 3–12 training environments, default 6. Held-out validation uses `ceil(trainingCount / 2)` additional cases; one fault case is separate. Compact-circle and district families are used for training, with corridors reserved for held-out evaluation. Geometry, population count and seed, sensing radius, maximum speed, endurance, recharge time, pad count, initial charge, reserve and depot location vary reproducibly. Population remains zero throughout if the captured city is empty; otherwise counts vary around the captured population rather than becoming a learned target.

Diverse warm-up is `max(120 seconds, configured revisit window)` and each scored duration is `3 × (enduranceSeconds + rechargeSeconds)`. Its fault case injects a reproducible aircraft malfunction one endurance period after warm-up. The planner cannot see future fault schedules. The UI reports each case and the worst case, not merely a favorable combined mean.

Scenario seeds derive deterministically from the captured mission seed through split-specific offsets, independently of the optimizer seed. Two final-test seeds are reserved by the scenario generator and **are not evaluated by the search**. Reserving seeds is not final-test evidence; a frozen policy still needs a separately authorized, untouched assessment.

Evaluation steps are 0.5 seconds. Planning-grid observations use exact swept footprints, while the independent 10 m audit records instantaneous footprints at those snapshots. The audit can miss brief observations between snapshots; it is not exact continuous coverage. All grids use the scenario's configured sensing radius, 32 m in the classic preset. Coverage is a sampled-point fraction, not exact geometric area; partial boundary strips are not area-weighted. Population remains on the 40 m grid: its crowded-cell threshold is not reapplied to smaller geographic or audit cells.

Adaptive and uniform candidates share staging and scenario rules at the same fleet size. The short reports are **not interchangeable with the archived baseline's 600-second warm-up and 1,200-second scored episodes**. Short warm-up is a pilot comparison choice, not an approved startup allowance.

Held-out validation informs selection and UI eligibility, so it is not a sealed final test set. This milestone does not provide evaluated final-test evidence, confidence intervals, multi-optimizer-seed generalization, or an exhaustive fault campaign. The finite, bounded environment generator cannot establish performance in any arbitrary future condition.

## Controls and persistence

An explicit Start action creates one worker for isolated accelerated trials. The visible mission retains its current policy. The worker yields regularly for pause, cancellation, and budget checks. Controls include profile, diverse training-environment count, optimizer seed, generations, and a 15–600-second compute budget, default 120 seconds for new settings; paused time is excluded. The budget is a maximum, not a requested duration: completing the selected generations and evaluations can finish early. Throughput depends on the device, and battery-cycle cases are longer than the original short pilot.

Pause/resume continues the same in-memory worker. Cancellation or budget exhaustion retains only completed evaluations. Errors leave the visible mission unchanged. Training also pauses when the page is hidden or loses focus.

Versioned results are saved locally and can be exported/imported as JSON. Validation checks settings, bounded strategies, numerical consistency, and evaluator compatibility. **These records are not exact optimizer checkpoints:** they do not serialize suspended episodes, RNG progression, or the complete resumable process. Reloading or importing requires a new experiment to continue learning.

New results use a separate v2 browser-storage key. Restoration checks that key first and falls back to the old v1 key; new runs never overwrite or delete the original legacy record. Importing legacy data does not relabel it as a new evaluator result.

Imported and restored results are untrusted, read-only reports. Their numbers are not cryptographically verified and cannot authorize strategy application. A new local experiment must produce held-out results before its candidate can be tested. Changes to the captured mission requirements or environment fingerprint disable application until a matching experiment runs.

Applying a locally evaluated candidate is always explicit and starts a **new, paused test mission**, including its selected fleet size, in the captured visible environment. It never silently replaces a running mission. A candidate with completed held-out results but unmet gates may be used through the clearly labeled **experimental mission** action; this is an operator test, not automatic promotion or a recommendation. A diverse-suite score does not certify that visible environment. Patrol must then be started explicitly.

## Remaining milestones

1. **Broader validation:** freeze finalists before using the reserved final split; add historical long-protocol comparisons, finer time sampling, multiple optimizer seeds and broader independent environmental/fault distributions. Publish paired differences and uncertainty. The implemented finite suite is a first robustness experiment, not evidence of universal generalization.
2. **Complete metrics:** add geographic deficit duration/integral, startup reporting, weighted age percentiles, separate hotspot worst ages, and sustained post-failure recovery time. Current failure reports are aggregate outcomes, not recovery guarantees.
3. **Explicit operational gates:** agree on quiet-area maximum age, tolerated hotspot misses, startup allowance, and recovery interval. The 95% area floor and unseen-population count cannot prevent arbitrarily long gaps in every unpopulated location. Maximum age is currently reported, not enforced as a cap.
4. **Better scheduling and sensing:** evaluate the denser geographic scheduler under more scenarios; test workload-balanced regions, improved assignments/look-ahead, context-sensitive speed and energy-aware destinations, and building occlusion. Preserve the evaluator when comparing policies; version and re-baseline changes to population resolution or visibility.
5. **Resilient fleet selection:** expand beyond one pilot fault case and define a separate recommendation for surviving aircraft loss. Rerouting cannot replace missing capacity.
6. **Optional exact persistence:** serialize search/RNG/episode state only if resumable experiments justify the complexity. Imported metrics must remain untrusted.
7. **Context-conditioned learning and physical fidelity:** a controller that selects fleet size or changes speed from environmental context remains future work. So do validated aircraft energy parameters, vertical flight and takeoff/landing dynamics. These are distinct from today's bounded parameter search and horizontal charging abstraction.

A useful historical diagnostic remains a 20% reduction in five-drone gap cost, at least five percentage points better population on-time coverage, and no geographic regression. Check it under a matching protocol and the dense audit; a favorable seed or improved coarse-grid score is insufficient. Fleet search still includes all sizes from the beginning. Neural reinforcement learning is a possible later experiment, not a requirement for this interpretable pilot.
