# Headless neural patrol experiment

This is a separate experimental controller, not another parameter search over the existing adaptive planner. It learns motion decisions with proximal policy optimization (PPO) in synthetic simulations. The uniform and population-aware heuristic controllers remain paired baselines. The live app, its learning panel, and saved browser missions are unchanged; nothing automatically applies, commits, pushes, or deploys a neural policy.

## Run locally

Install the locked dependencies with `npm ci`. No Chrome session, development server, Python, GPU, or cloud account is required. The CLI uses Node, Vite's module loader, and TensorFlow.js on the CPU.

```sh
npm run train:patrol:rl -- --smoke --seeds 42
npm run train:patrol:rl -- --episodes 32 --seeds 42,73,101
npm run train:patrol:rl -- --episodes 64 --seeds 42,73,101 --reward-scale 0.001 --gradient-clipping separate
npm run train:patrol:rl -- --episodes 64 --seeds 42,73,101 --reward-scale 0.001 --gradient-clipping global --actor-normalization layer
npm run train:patrol:rl -- --episodes 64 --seeds 42,73,101 --reward-scale 0.001 --actor-architecture shared --reward-profile coverage-v2
npm run train:patrol:rl -- --episodes 64 --seeds 42,73,101 --reward-scale 0.001 --actor-architecture shared --reward-profile legacy-v1
npm run train:patrol:rl -- --episodes 16 --seeds 42 --reward-scale 0.001 --actor-architecture autoregressive --critic-normalization layer --reward-profile coverage-v2
npm run benchmark:patrol:rl -- --checkpoint test-results/<run>/policy-42.json
npm run benchmark:patrol:rl -- --checkpoint test-results/<run>/policy-42.json --split final
```

`--smoke` uses eight training episodes per seed and short episodes: 20 seconds of startup plus 60 scored seconds, with scheduled faults moved to second 40. It tests plumbing, not training quality or fleet feasibility. Full runs default to 32 episodes for each of three independent optimizer seeds (`42,73,101`), eight training scenarios, and four validation scenarios. Each validation case evaluates all eight fleet sizes under all three controllers: 96 evaluation episodes per optimizer seed. CPU cost can be substantial; start with smoke and do not interpret the default training budget as sufficient for convergence.

Training episode counts must be positive multiples of eight. Optional flags include `--scenario-seed`, `--train-scenarios`, `--validation-scenarios`, and `--output <new-directory>`. The output directory must not already exist. The default is a timestamped directory under ignored `test-results/`. `Ctrl-C` retains completed work and marks the run cancelled; an interrupted evaluation is not complete evidence. Use `--help` for accepted arguments.

Optimization experiments use `--reward-scale <1e-8–1e8>` and `--gradient-clipping global|separate`. Defaults remain `1` and `global` to preserve the original control. The scale is a constant positive numerical unit conversion, not a change in reward priorities or coverage targets; `0.001` is an experimental candidate, not an established best value. Separate clipping caps the actor and critic gradient norms independently before the same Adam optimizer updates their disjoint parameters. Both settings are saved in the protocol and checkpoint. Evaluation rejects training-option overrides and restores the checkpoint's settings.

`--reward-profile coverage-v2|legacy-v1` changes the task objective independently of those numerical settings. New training defaults to `coverage-v2`, prioritizing whole-area freshness with a small active-camera overlap penalty. Use `legacy-v1` explicitly for the original objective. Evaluation inherits the saved profile and rejects profile overrides. Reward profiles, exact coefficients, and per-component episode totals are recorded so unlike reward totals cannot be silently compared. The previously trained and currently served seed-101 model still uses the legacy objective; changing the reward does not retrain its weights.

`--actor-normalization none|layer` is an independent architecture ablation, defaulting to `none`. `layer` normalizes only the actor's first-layer preactivations within each network input row: `(z - mean(z)) / sqrt(mean((z - mean(z))^2) + 1e-5)`, followed by tanh. It uses no learned scale/offset or batch/running statistics, adds no parameters or RNG draws, and leaves the actor's second layer and critic unchanged. Normalization changes the policy function, not the environment's reward, action masks, or qualification targets.

`--actor-architecture dense|shared|autoregressive` defaults to the historical `dense` control. `shared` replaces the slot-specific actor with one learned `68 → 32 → 32 → 1` scorer reused for every drone/action pair. `autoregressive` uses an `80 → 32 → 32 → 1` scorer that additionally conditions later choices on earlier selected drone actions. Both require the existing patrol observation schema. All architectures use the same action masks and reward. Optimization/architecture settings are saved and restored; evaluation rejects overrides.

`--critic-normalization none|layer` defaults to `none`. `layer` applies the same non-affine, per-input-row layer normalization before the critic's first tanh, independently of actor normalization. It changes neither parameter shapes nor initialization RNG. Critic values, training gradients, and saturation diagnostics use the same normalized forward path. This option fixes the measured activation-saturation mechanism, but the controlled fit probe below does not establish better held-out prediction; do not treat it as a proven default upgrade.

Final evaluation requires an explicitly supplied frozen checkpoint and `--split final`; training never evaluates final cases. Keep final results out of policy selection and parameter tuning. The CLI's `benchmark:patrol:rl` script supplies `--evaluate`, so evaluation performs no weight updates.

## Local visual preview

The already prepared local preview only needs the development server. To prepare a different, source-compatible completed run, replace the placeholder with that run's directory:

```sh
node scripts/prepare-patrol-preview.mjs --run test-results/<source-compatible-completed-run> --default-seed 101
npm run dev
```

Open `http://127.0.0.1:5173/neural.html`, then click **Start patrol**. The current local preview uses the shared actor's 64-episode seed 101 checkpoint. The initial mission is paused: eight aircraft and a 640 m NYC sandbox with moving crowds and finite batteries. Eight aircraft is an inspection choice, not a qualified minimum. NYC is separate from the held-out validation matrix; its later sanity-check results are recorded below, not treated as fleet qualification. Saved validation cases are also available, including their scheduled faults, so the observed benchmark behavior can be replayed. Reload an already open page after preparing different models.

Policy, scenario, controller, and fleet changes are staged until **Apply preview**; applying starts a new paused mission. Reset replays the same applied settings. Compare with the uniform or adaptive controller using the same scenario and inventory. Simulation speed is adjustable; leaving the tab or losing focus pauses playback. The screen shows actual command decisions, coverage, population revisit gaps, camera footprints, aircraft battery/service state, and the independent geographic audit. It does not train in the browser, certify a fleet, or modify saved learning reports.

The frozen-policy browser implementation uses the saved neural weights without TensorFlow.js. It preserves the CPU evaluator's float32 accumulation and deterministic action selection. Playback uses the same half-second simulation samples and five-second control/population schedule; parity tests cover motion, charging, faults, and observation history. It does not evaluate the training reward. Existing prepared models remain usable after the reward upgrade, but re-preparing or CLI-evaluating historical runs still requires their original source fingerprints; those checks are not relaxed to accommodate changed reward code.

Preparation validates checkpoints, completion metadata, matching runtime source hashes, and the saved scenario suite before copying assets into ignored `.local/patrol-preview/`. Shared-actor models also require the exact recorded shared-feature module fingerprint; autoregressive models require both shared and coordination feature fingerprints. Legacy dense models do not acquire a dependency on new feature semantics. New outer-v2 artifacts additionally require matching canonical reward metadata/settings in the report and policy and the reward-module source fingerprint before replacing the preview. The Vite development middleware serves only its manifest and policy JSON files through `/__patrol_preview/`; it is read-only and does not participate in production builds or the production preview server. Neither model weights nor the standalone page are included in the normal production build. The main app's Routing laboratory remains the heuristic baseline.

## Controller and simulation contract

A centralized feed-forward actor and critic each have two 32-unit tanh layers. PPO uses clipped policy updates, generalized advantage estimation, Adam, entropy regularization, and gradient-norm clipping. Training samples masked actions; evaluation chooses the highest-probability valid action. Artificial episode horizons are truncations, not terminal failures: value estimates bootstrap from the final observation before resetting.

The shared actor derives 68 unitless features per drone/action solely from the existing observation: ego service/battery state, mission context, candidate action geometry, sensor-scale and three-times-sensor-scale raster summaries and their changes from the current position, and symmetric peer summaries. Raster features preserve population, both age channels, visited state, population/age joint moments, and valid support. Smooth radial pooling has nonzero tails so distant demand is not completely invisible. Return/standby target sensing summaries are zero because those services do not observe. The model learns the final logits; there is no fixed urgency formula, destination ranking, scripted patrol, or reward for changing its mind.

Peer reductions use canonical physical-feature ordering and exclude absent slots. Relabeling drone slots therefore relabels logits without changing physical preferences. Peer service eligibility remains approximate under pending faults, because the actor receives no privileged simulator fault flags. Raster means are not unique people counts or exact camera footprints: the 16×16 input can repeat underlying cells. Shared scoring also does not guarantee coordinated joint decisions or resolve perfect symmetry among co-located identical drones; it remains a factorized, memoryless policy capped at eight drones.

The opt-in autoregressive actor makes choices sequentially within each five-second decision, in a deterministic order derived from observed drone features. Its extra twelve features summarize earlier controllable/sensing/return/standby choices, later controllable drones, current service occupancy, and candidate overlap/proximity to earlier planned sensing at the segment midpoint and endpoint. These are input features to a learned scorer, not fixed action penalties, reservations, routes, or additional masks. Analytic disk intersections are approximate intent geometry, not boundary-clipped union coverage; the existing independent audit remains authoritative for reward. Noncontrollable forced-hover heads do not contribute fictitious sensing intentions.

During PPO updates, recorded earlier actions supply the exact same conditional inputs (teacher forcing), and the likelihood ratio uses the sum of selected conditional log-probabilities across drones. Features are cached once per transition across update epochs; no later action is visible to an earlier decision. The entropy term is a conditional exploration surrogate evaluated at recorded behavior-policy prefixes, not exact current-policy joint entropy. Autoregressive actor state-variation diagnostics include prefix changes as well as observation changes. Canonical order is permutation-consistent for distinct observed drones, but not rotation-equivariant; indistinguishable ties use slot order to allow symmetry breaking. This controller still has no memory across decisions, guaranteed joint optimum, or guaranteed staggered charging.

The environment and episode reports always use raw rewards. `PPOAgent.update` accepts raw transition rewards and multiplies them by `rewardScale` exactly once before GAE. `act().value`, `value()`, transition values/next values, and the bootstrap argument already use learner units and are not scaled a second time. Fresh critic output weights are initialized in those units; actor initialization and RNG draws are unchanged. Raw/global optimization retains the original numerical settings, but reproducing the previous task also requires `legacy-v1` rewards. Do not rescale a loaded checkpoint's values manually or treat a changed scale or reward profile as exact optimizer continuation.

When selecting the shared architecture, the actor's parameter shapes necessarily change. Its initialization restores the legacy actor RNG draw budget before initializing the critic, so matched seeds retain exactly the same initial critic weights and post-initialization sampling RNG as the dense control. Candidate features are precomputed once per rollout update and reused through PPO epochs; gradients update all shared MLP weights, not the fixed feature extractor.

Update diagnostics include raw/scaled reward ranges, learner-unit return/value ranges, critic RMSE and explained variance before the update, hidden-layer saturation, separate actor/critic gradient and clipped-gradient norms, and actual parameter displacement over the full update. Divide learner-unit RMSE/values by the saved scale to compare raw units. `criticExplainedVarianceValid` is zero when target variance is zero; its accompanying zero is a placeholder, not evidence of successful prediction. These are rollout fitting diagnostics, not held-out prediction scores. Normalized entropy averages entropy divided by `log(valid actions)` over heads with more than one choice; it is zero when there are no choices, which does not demonstrate policy collapse.

Actor diagnostics record mean absolute first-layer preactivation before normalization and both layers' saturation (`abs(tanh) >= 0.99`) over all rollout observations before each update. `actorStateTotalVariation` and `actorStateGreedyAgreement` compare current logits against logits from the rollout's first observation, with the same current action mask on each side and only multi-action heads counted. `actorStateDecisionHeads` records that denominator; both metrics are zero placeholders when it is zero. Rollouts can cross episode boundaries and slot/fleet changes. This is coarse within-rollout state variation, not an episode-frozen intervention or a measure restricted to healthy physical drones. None of these measurements consumes sampling randomness or updates weights.

Activation telemetry averages one hidden row per state for dense actors and all 216 candidate rows per state for shared actors, including padded/masked candidates. These are different representation granularities. Held-out shared-actor probes should additionally report activation health over legal candidates of healthy, responsive decision heads rather than compare those raw training averages as equivalent samples.

Every five simulated seconds, the policy chooses one action for each available drone: eight horizontal directions at 50%, 75%, or 100% of maximum speed, hover, return to depot, or standby at the depot. These are 27 high-level actions, not motor commands. The single global observation includes a 16×16 raster of population and observation ages, all eight padded drone slots with position/battery/service/destination state, and current environment and mission requirements. Drone slots are shuffled during training. Scenario IDs, seeds, family labels, future fault schedules, and the episode end time are not observations.

There are no geographic ownership bands, urgency-score destination selection, reserved-footprint allocation penalties, or predetermined patrol sweeps in the neural controller. Dense/shared controllers produce independent drone distributions from the same global state; the autoregressive controller additionally observes earlier chosen actions within that decision. None explicitly searches a globally optimal multi-step route. Training visits every fleet size from 1–8 in each shuffled block of eight episodes. Inventory stays fixed within an episode, including charging, standby, and failed aircraft. The smallest acceptable inventory is selected by held-out testing, not by letting a policy delete drones or relax targets.

The shared engine still enforces boundaries, speed limits, battery consumption, reserve protection, finite charging pads, and fault detection. Action masks disallow out-of-bound and energy-infeasible patrol legs; a return safety shield remains a fallback. Separate altitude lanes avoid the need to learn aircraft separation. Buildings do not occlude camera footprints; obstacle avoidance, camera images, person tracking, descent/landing/takeoff, and real-aircraft dynamics are not modeled. Initial aircraft positions are matched across controllers and staged instantly. This is not a flight-ready collision-avoidance system.

## Scenarios and reward

Seed partitions for training, validation, and final tests are disjoint. Training includes circular and district boundaries; validation mixes unseen familiar geometry with held-out corridors. Final cases use harsher sensor, speed, reserve, and endurance/recharge conditions. Population families are persistent crowds, moving crowds, abrupt surges, and diffuse demand. Population is generated from seed and absolute time, independently of actions or fleet size. Counts vary within ±35% of the base, subject to integer rounding and the 50,000-person cap; zero stays zero. Concentrated families retain hotspots instead of repeatedly blending into uniform density. The wrapper refreshes population every five seconds, preserving location observation history.

Full episodes have 120 seconds of startup followed by at least three nominal endurance-plus-recharge periods of scored simulation. Population samples are spaced 40 m apart; a separate 10 m geographic audit samples every 0.5 seconds. Reported integrals and minima are sampled approximations, not continuous-time guarantees. Overlapping drones do not count the same person's coverage twice.

### Coverage-priority objective (default `coverage-v2`)

For a sample of length `dt`, define `N = total inventory`, `C = geographic audit coverage / 100`, `T = required coverage / 100`, and `H = current population`. A bounded age cost is `age / (age + deadline)` for previously observed locations and `1` for never-observed locations. `A` is its mean across **every inside-boundary 10 m audit point**, using the geographic revisit window (normally 120 seconds), including unpopulated areas. Let `O` be duplicate active camera footprint samples divided by summed active camera footprint samples, measured on that same grid.

```text
geographyCost = 4 * A + 4 * (1 - C) + 8 * max(0, T - C) / max(T, 0.000001)
populationCost = 2 * sum(population[cell] / max(1, H) * boundedLocalAge[cell])
unobservedCost = (H - uniqueCurrentlyInViewPopulation) / max(1, H)
overlapCost = 0.25 * O
reward = -(geographyCost + populationCost + unobservedCost + overlapCost + 0.02 * N) * dt / 5
         - 20 * newReserveViolations - 50 * newlyStrandedDrones - newForcedReturns
```

Geography has a maximum cost of 16 per five seconds, versus 2 for population revisit age, 1 for current unseen population, and at most 0.25 for overlap. These are initial design weights, not tuned optima or a lexicographic guarantee that every geographic improvement outweighs any population change. Bounding population urgency prevents an arbitrarily overdue crowd from overwhelming the whole-area objective. Linear target shortfall keeps pressure near 95%; bounded geographic age also rewards fresher observations before they expire. The audit averages over area, rather than multiplying by raw map size, so equivalent coverage fractions are comparable across differently sized environments.

Overlap is **actual redundant sensing area**, not nearby-drone distance or population-weighted duplication. Only healthy patrolling sensors count, and only the part of each footprint inside the mission boundary counts. Returning, waiting, charging, standby, and faulted drones do not incur this cost. Two nearby drones with disjoint sampled footprints have zero overlap cost; two co-located active cameras have `O = 0.5`. No active footprints means `O = 0`, not a positive reward; lost sensing still harms population visibility and geographic freshness. Transient handover overlap is permitted, not masked out. Since this is a bounded soft penalty, it does not guarantee coordinated allocation or enforce aircraft separation.

### Original objective (`legacy-v1`)

With `B = max(1, basePopulation)` and `r[cell] = observationAge / localDeadline`, the original arithmetic is retained for explicit controls:

```text
populationCost = sum(population[cell] / B * (r[cell] + max(0, r[cell] - 1)^2))
unobservedCost = (currentPopulation - currentlyInViewPopulation) / B
geographyCost = 1 - C + 10 * max(0, T - C)^2
reward = -(populationCost + unobservedCost + geographyCost + 0.02 * N) * dt / 5
         - 20 * newReserveViolations - 50 * newlyStrandedDrones - newForcedReturns
```

Both profiles specify outcomes, not routes, and prefer shorter gaps before a deadline. Only the legacy profile has the unbounded quadratic overdue penalty. Local deadlines interpolate from 120 seconds for empty cells to 15 seconds at 80 people per cell, using the scenario's configured values. Legacy never-observed cells use the conservative age `simulationTime + localDeadline`; the new reward assigns bounded cost 1 instead. The reported `gapCost` remains the existing population-weighted squared normalized-age metric under either profile; evaluation metrics and qualification requirements do not change with reward shaping.

Training reward, signed `rewardComponents`, energy totals, violations, and inventory-drone-seconds include startup. Population/coverage service metrics and sampled distance exclude startup. Population and hotspot service metrics use person-time weighting. Demand changes take effect after scoring the preceding interval, not retroactively. Episode results identify their profile; evaluation summaries reject mixtures of profiles. `calculatePatrolReward` supplies versioned scores, while the older three-argument `patrolReward` helper remains explicitly legacy-compatible. The new environment/training/evaluation API default is `coverage-v2`.

## Qualification and known limitations

Compare paired scenario-and-fleet results against both baselines across independent optimizer seeds. The adaptive comparison uses its default parameters, not an automatically selected historical best policy. A larger reward alone is not qualification. A smallest validated fleet is reported only after the complete evaluation matrix exists and every healthy validation case satisfies all of the following:

- Full-length protocol; both geographic grids meet the configured coverage target at every scored sample.
- Every crowded cell meets its deadline at every scored sample; no people remain at never-observed locations.
- No stranded drones, reserve breaches, rejected commands, or safety-shield forced returns.

Fault cases are reported separately, including whether the scheduled fault was actually applied. A healthy-suite fleet result is not a resilience claim. No final-test result automatically changes the chosen fleet or the live app, and `promotionEligible` remains false.

Two feasibility caveats must remain visible. A sudden crowd inherits the location's existing scan age and can become overdue immediately under its new shorter deadline; there is no undisclosed arrival grace period. Also, environment validation checks parameter bounds, not whether every initial staged position can reach the depot while preserving reserve. Some harsh final combinations can therefore start infeasible even with an immediate return. These cases are not silently repaired or evidence that more training alone would solve them. Review initial charge, reserve, and direct-return energy before attributing such failures to policy quality.

Neither finite validation success nor more training proves global optimality or real-world transfer. The feed-forward policy has no temporal memory, the action vocabulary is discrete, and the synthetic world is simplified. Learned behavior can exploit simulator omissions. Short runs may perform worse than either heuristic baseline.

## Artifacts and reproducibility

Each run writes `protocol.json`, `scenarios.json`, per-seed `policy-<seed>.json`, `training-<seed>.json`, `evaluation-<seed>.json`, and a final `report.json`; failures after output-directory creation receive `error.json`. Invalid arguments/checkpoint metadata are rejected before output creation. Evaluation-only runs do not write new training or policy artifacts. Protocol/policy records include the protocol version, settings, canonical reward definition, Git commit, dirty-working-tree flag, and SHA-256 fingerprints for the recorded runtime modules (including reward code), CLI runner, `package.json`, and `package-lock.json`. Evaluation rejects missing or mismatched source/dependency fingerprints, with no compatibility override. The evaluation protocol also records the loaded policy file's SHA-256, original seed, and settings. Preserve the manifest and exact source/dependency versions with the weights; a Git commit alone does not describe uncommitted experiments.

New policy files use outer `astro-patrol-rl-policy` version 2 with required canonical reward metadata and matching `settings.rewardProfile`. Outer version 1 implies `legacy-v1`; it cannot be relabelled as coverage-priority. The frozen browser loader supports both outer versions without altering actor actions. The action/observation protocol and inner PPO architecture format are unchanged by this reward revision. Reward totals from different profiles are not directly comparable performance measures; use unchanged coverage, population, gap, and safety metrics.

Policy files include architecture, PPO settings, weights, seed, and random-generator state. New inner PPO checkpoints use version 5 to record critic normalization and permit the autoregressive actor. Strict version-1 loading assigns the original `1/global/none/dense` semantics; version 2 preserves scale/clipping and assigns actor normalization `none` and architecture `dense`; version 3 additionally preserves actor normalization; version 4 preserves dense/shared architecture. All version-1–4 checkpoints imply critic normalization `none` and reject autoregressive relabelling. Frozen browser inference accepts all five versions without TensorFlow.js. Unknown or missing fields and architecture/weight-shape mismatches are rejected rather than guessed. Shared and coordination feature implementations are included in new CLI provenance fingerprints. The environment protocol and outer reward-artifact version remain unchanged by these architecture options. Fingerprint checks still apply: legacy format support does not authorize evaluation against different recorded source/dependency versions. Checkpoints support checked inference and possible programmatic warm starts, not exact optimizer resume: Adam moments and the in-progress rollout are not saved. The CLI's checkpoint option is evaluation-only. Artifacts are local experimental records, never automatic deployment approvals.

Playwright's disposable output is isolated under `test-results/e2e/`; it must not clean the parent directory containing experiments. Keep important experiment artifacts in a separate backed-up location as well. TensorFlow.js is a development-only dependency and is not imported by the web app. Its current umbrella package brings an `argparse`/`sprintf-js` chain with three moderate npm-audit findings; there is no patched `sprintf-js` release in the available registry. The training code does not use that CLI formatting chain. Do not apply npm's suggested downgrade to TensorFlow.js 2.1 merely to silence the report.

## Initial implementation check — 2026-10-06

Validation passed 267 unit tests, 28 browser tests, and the production build. The three frozen historical benchmarks reproduce exactly, excluding timing metadata. A saved neural checkpoint reproduces all 96 matched smoke-evaluation episodes exactly after reload. Three optimizer seeds completed short training checks; a separate seed-42 pilot completed eight full-length training episodes, 2,258 control steps, 36 PPO updates, and 96 held-out evaluation episodes spanning battery/recharge cycles.

The full pilot **does not qualify any fleet and underperforms both baselines** on all three healthy eight-drone validation cases. This establishes working training, checkpointing, and evaluation, not a useful converged patrol policy. No candidate was applied to the live app. Local full-pilot artifacts are in `test-results/patrol-rl-2026-10-06T09-50-44.345Z/`; the three-seed smoke is in `test-results/patrol-rl-2026-10-06T09-50-37.791Z/`. These ignored artifacts are not included in Git.

During validation, Playwright's former default output directory cleared older ignored `test-results/` artifacts. The output-directory isolation above fixes the cause. Frozen benchmark outputs were regenerated and the preceding current-setup search was reconstructed with matching parameters and aggregate results in `test-results/regenerated-current-setup-2026-10-06/`. That directory explicitly records regeneration; original timestamps and detailed replay/demand diagnostics were not recovered. Tracked baseline archives were unaffected.

## Reward and critic investigation — 2026-10-06

Three longer, source-matched runs increased training from 64 to 256 episodes per optimizer seed without changing the scenario suite or PPO settings. Healthy eight-drone crowded-person on-time coverage averaged 38.41% before and 30.92% afterward; no fleet qualified. This regression prompted diagnostics, not an automatic change to the simulator or live preview. Matched results are in ignored `test-results/patrol-rl-more-2026-10-06T13-37-41Z/comparison.json`.

Diagnostics are reproducible from the scripts and JSON in ignored `test-results/patrol-rl-diagnostics-2026-10-06/`. No production source, reward definition, saved checkpoint, or preview model was changed. Forty focused network/environment/experiment tests pass, including termination and truncation bootstrapping checks; review found no apparent GAE episode-boundary bug.

### Measured scale and saturation

`reward-probe.mjs` replays 36 frozen validation episodes: three 256-episode policies, four scenarios, and fleets of one, four, and eight. All episodes exactly reproduce their saved results. Across 11,412 control steps, absolute reward has median 685 and p99 10,714; absolute 64-step GAE targets have median 9,557 and p99 142,210. These are lambda-return targets using the existing bootstrap estimates, not ground-truth continuing returns.

The critic predicts almost the same value for every state within each seed: approximately −52.54, −51.75, and −52.26. Within-case explained variance is approximately zero. At sampled states, every second-layer critic activation has `abs(tanh) > 0.99`; first-layer saturation is above 99.9%. Current output-weight bounds are approximately 52, explaining why these checkpoints cannot represent their much larger targets without substantial weight changes. This is a bound from the saved weights, not a permanent architectural output limit.

On these trajectories, quadratic overdue-population cost contributes 98.00% of accumulated cost, versus 0.287% geography and 0.055% immediate unobserved-population cost. Never-observed locations contribute 63.61% of cost. Steps with no action choice account for 26.02%; a failed sole drone cannot remedy subsequent growing coverage penalties. These empirical shares are not fixed reward coefficients or evidence that population-count randomization itself is the main scaling problem. Advantage standardization does not standardize the critic's targets.

### Actual optimizer effect

`gradient-probe.mjs` compares 24 early/late stochastic training-trajectory windows across all three saved policies. It intercepts real optimizer inputs and parameter changes, verifying separately recomputed gradients against the implementation. Median raw actor/critic gradient norms are 0.985/299.51; joint clipping reduces the supplied actor norm to 0.001537. However, this is not a proportionate reduction in learning: Adam rescales gradients using its moments and epsilon. Independent clipping increases the paired first Adam actor-step norm by a median 1.69× over 21 nonzero cases, not hundreds of times. Each comparison starts with fresh Adam state because optimizer moments were not saved.

Consistent 0.001 reward/value units improve short-window raw-unit critic RMSE, but the old critic remains effectively constant. This is numerical conditioning and mean-offset adjustment, not restored state-dependent predictions or improved patrol coverage.

### Controlled critic-only fitting

`critic-fit.mjs` freezes the seed-73 actor and generates 16 full training-suite episodes: independent fitting and holdout trajectories over the same eight training scenarios, alternating fleets four/eight. Each split has 2,258 observations. Four critic arms use identical minibatches for 512 updates against fixed 64-step GAE targets, with fresh Adam state. Scaled arms also rescale the critic output head to preserve initial predictions in raw units.

| Critic initialization / reward units | Holdout raw-unit RMSE | Holdout explained variance |
| --- | ---: | ---: |
| Existing / raw | 1,667.8 | ≈0 |
| Existing / 0.001 | 2,319.3 | ≈0 |
| Fresh / raw | 1,687.3 | ≈0 |
| Fresh / 0.001 | 1,021.5 | 0.5952 |

The fresh scaled critic retains state sensitivity; its second-layer holdout saturation is 7.31%, while the existing critic stays 100% saturated with either scale. Fresh raw training also tends toward constant predictions. Scaling alone therefore does not promptly repair the existing critic in this experiment.

This is one-seed fixed-target optimization evidence, not a new trained patrol, unseen-scenario generalization result, or proof that 0.001 is optimal. Fit and holdout target standard deviations differ substantially (10,945 versus 1,511) because stochastic trajectories have heavy-tailed outcomes. Actor weights remain frozen; no final-test scenarios are used.

### Recommended next experiment

Start fresh matched PPO runs rather than extending the saturated checkpoints. Cross consistent fixed reward/value-unit scaling with independent actor/critic gradient clipping; preserve the original reward-term ratios, safety constraints, fleet sizes, raw-unit service metrics, and held-out suites. A constant positive unit conversion is different from clipping or log-transforming overdue penalties, which changes the task objective. Record critic explained variance and saturation, target ranges, actor/critic gradient norms, actual parameter changes, and entropy relative to available action choices. Only a subsequent multi-seed patrol evaluation can establish whether improved critic fitting improves coverage. The live preview remains on the previous 64-episode models.

## Controlled scaling/clipping experiment — 2026-10-07

Implemented opt-in scaling and independent clipping, strict checkpoint-v2 metadata with legacy inference support, and the diagnostics described above. Defaults remain unchanged. The fresh 2×2 experiment used scales `1`/`0.001` and `global`/`separate` clipping, each with optimizer seeds 42/73/101 and 64 episodes. All eight fleet sizes, the original eight training scenarios, four validation scenarios, and battery/fault/reward/qualification rules stayed fixed. Totals: 12 runs, 768 training episodes, 216,768 control steps, 300.64 simulated training hours, and 1,152 matched evaluation episodes. No final-test cases were used.

The original-setting controls reproduce the previous 64-episode weights, RNG state, training episode results, original update metrics, and all evaluation results exactly. The comparison verifies the recorded source snapshot, identical scenario schedules and population demand, unchanged deterministic baselines, complete evaluation matrices, applied faults, and fleet qualification independently.

Healthy eight-drone results, person-time weighted within each seed and then averaged across the three seeds:

| Reward units / clipping | Crowded on-time | People in view | Gap cost (lower is better) |
| --- | ---: | ---: | ---: |
| Raw / global control | 38.41% | 16.97% | 320.94 |
| Raw / separate | 40.48% | 17.31% | 393.38 |
| 0.001 / global | 37.77% | 16.56% | 286.99 |
| 0.001 / separate | 34.18% | 15.86% | 272.79 |
| Uniform baseline | 63.88% | — | 5.16 |
| Adaptive baseline | 74.90% | 26.30% | 2.39 |

Separate clipping alone gives a small average crowded-coverage increase but worsens mean gap cost; its seed-73 fault cases at fleet sizes one, three, and four also incur one reserve violation each. All other variants have zero reserve violations in this validation matrix, and every variant has zero stranded drones, rejected commands, and forced returns. None qualifies any fleet. The combined setting's crowded coverage ranges from 24.97% to 43.36% across seeds. There is no reliable overall improvement and no automatic promotion.

A further 36 frozen healthy fleet-eight replays exactly reproduce the saved episodes and measure critic behavior in raw reward units. Mean per-case explained variance is approximately zero for both raw variants, 0.251 for scaled/global, and 0.202 for scaled/separate. Mean second-layer saturation drops from 100% to 4.0%/10.0%; first-layer saturation remains about 95–96%. Scaling therefore restores useful value variation, but it does not by itself establish a good patrol policy. These descriptive critic comparisons use each policy's own trajectories and bootstrap-dependent targets; they are not identical-target causal tests. Training-rollout explained variance also remains variable, sometimes negative. Normalized action entropy remains high, so greedy-versus-sampled action selection and coordination are reasonable next diagnostics before increasing the training budget again.

Local artifacts are in `test-results/patrol-rl-ablation-2026-10-06T14-54-34Z/`: `plan.json`, a verified `source-snapshot/`, per-arm/seed checkpoints and logs, `comparison.json`, and `frozen-critic-evaluation.json`. They are ignored by Git. The 64-episode preview manifest and models are unchanged; no new policy is deployed.

Validation: 301 unit tests, two CLI integration tests including scaled checkpoint reload/evaluation parity, TypeScript and the production build pass. The actual-model local-preview browser test passes. One separate fixture-playback browser test fails with a negative canvas arc radius; preview rendering was not changed as part of this training experiment, and that UI issue remains unresolved.

## Action selection and coordination investigation — 2026-10-07

Frozen diagnostics reuse the twelve 64-episode checkpoints above, the same four validation scenarios, and unchanged simulator, reward, battery, fault, and qualification rules. No training, final-test evaluation, policy promotion, or runtime changes are performed. Source/checkpoint fingerprints and exact reference replays are checked by the diagnostic scripts.

### Sampling helps, but most of that benefit is exploration

`action-selection.mjs` runs 408 episodes: 96 greedy reference replays, 288 sampled-policy episodes using three independent action streams, and 24 matched masked-uniform-random controls, at fleet sizes four/eight. All 96 greedy results reproduce exactly. `fresh-policy-control.mjs` adds 96 episodes using three freshly initialized, never-trained actors with both decoding modes. Initial actor weights are identical across reward/clipping configurations. Sampling streams consume one draw per padded drone slot, independently reset per scenario/fleet; sampling repetitions are averaged within optimizer seed before comparing seeds.

Healthy eight-drone crowded-person on-time coverage, person-time weighted within each seed and then averaged:

| Controller | Greedy | Sampled |
| --- | ---: | ---: |
| Trained raw / global | 38.41% | 52.86% |
| Trained raw / separate | 40.48% | 53.35% |
| Trained 0.001 / global | 37.77% | 53.00% |
| Trained 0.001 / separate | 34.18% | 54.08% |
| Fresh, never trained | 36.49% | 50.09% |
| Masked uniform random | — | 49.68% |
| Adaptive rule-based reference | 74.90% | — |

Learned sampling exceeds fresh sampling by only 2.77–3.99 percentage points across arm means. In the fault scenario the difference is −2.32 to +0.32 points, with no consistent advantage. Trained greedy actors hover or stand by on 21.83–29.16% of controllable healthy decisions, versus 6.32% for fresh greedy and 4.90–5.79% for trained sampling. Hovering is not inherently wrong, but repeated greedy choices amplify these preferences. Every learned/random/fresh episode fails both geographic and hotspot feasibility. One sampled raw/global seed-101 fleet-four fault run breaches reserve; fresh and random controls have no safety events. Sampling is therefore not a qualified fix or justification for reducing the fleet.

### Dynamic actor inputs do not affect tested greedy behavior

`actor-sensitivity.mjs` exactly replays 48 fleet-eight episodes and probes healthy, responsive, multi-action heads after warmup every 160 simulated seconds. Across healthy arm means, 96.8–99.6% of first-layer actor activations have `abs(tanh) >= 0.99`, while normalized action entropy remains 0.934–0.964. High entropy does not imply useful dependence on the observed state.

Mirroring population, scan history, or peer positions changes none of the tested greedy choices; mean probability-distribution total variation stays below 0.00015. Independently checked feature changes are substantial, not symmetric no-ops. By contrast, cyclically relabeling drone slots, including their feature blocks and masks and inverse-mapping the outputs, changes 78–89% of healthy greedy commands, with mean total variation 0.24–0.26. This is an exact identity relabeling, not a discovered indexing bug. The dense actor has slot-specific heads despite episode-level slot shuffling.

The stronger `frozen-logits-control.mjs` intervention computes each episode's actor logits **once from its real initial observation**, then holds those logits constant while retaining **live safety/action masks** and the unchanged simulation. It reproduces **all 48 complete evaluation results exactly**, including coverage, rewards, gaps, reserves, and faults. All 121,728 action-head choices agree with the dynamic actor, including 60,104 healthy multi-action choices after warmup. Another 48 normal replays independently reproduce the saved results.

Thus, on this validation suite, the trained greedy controller behaves like fixed per-slot action preferences filtered through changing masks, rather than population-responsive allocation. This does not prove independence from every possible state or from the initial observation, and does not establish that sampled policies are exactly state-independent. Offline map/peer interventions can be physically inconsistent; the frozen-logit rollout, not those feature edits alone, establishes the behavioral equivalence.

A bounded same-input check, `actor-initialization-diagnostic.mjs`, compares all twelve trained actors and three same-seed fresh actors on three states from one validation-circle trajectory. Fresh first-layer saturation is 0%, 0%, and 4.17% across those states; trained arm/state means range from 73.96% to 98.96%. Every input group's maximum absolute feature is at most one. Mean absolute first-layer preactivation rises from 0.593–0.834 fresh to 3.47–5.73 trained, despite only small changes in overall kernel standard deviation and small biases. Larger coherent contributions from noncentered map features are a mechanism clue: saturation emerges with training rather than being present at initialization or caused by gross input overflow. This tiny matched-state check does not determine why the optimizer learns those weight changes.

### Overlap is secondary to poor positioning and uneven use

`coordinate-probe.mjs` exactly reproduces 48 neural and eight rule-based fleet-eight episodes. It measures visibility at the simulator's 0.5-second physics cadence, using the engine's actual sensing eligibility: healthy patrol service only, not returning/charging/standby cameras. Healthy neural actors spend 41.9–44.0% of inventory drone-time sensing versus 37.1% for adaptive, yet cover only 15.9–17.3% of current population versus 26.3%. Unique people visible per sensing-drone-second are 418–434 versus 782.

Duplicate person-time accounts for 7.9–11.9% of summed neural camera observations versus 7.7% for adaptive. Spatial bins visited per sensing drone are only 34.6–40.1 versus 97.8. After splitting overlapping observations equally, the strongest neural drone contributes 30.6–35.5% of union person-time and the weakest 1.4–2.1%; adaptive shares are 16.7% and 8.7%. These descriptive results favor fixing state-responsive allocation and uneven utilization before introducing a large overlap penalty. Geometric reachability diagnostics are relaxed opportunities, not proof that one joint schedule could serve all nearby crowds within their deadlines.

### Next experiment, not a deployed fix

Prioritize actor state conditioning before extending the training budget. The smallest next ablation is fresh matched actors with/without first-layer pre-tanh normalization, using one fixed scaled-PPO configuration and identical seeds, scenarios, and training budget. Keep rewards, critic settings, action space, and safety rules unchanged; record early/mid/late saturation, state sensitivity, frozen-logit agreement, fresh/random comparisons, and both greedy and sampled service metrics. Saturation is measured; the effectiveness of normalization is still a hypothesis to test. Feature centering is a separate possible ablation. Subsequently compare a shared per-drone encoder/action head with permutation-consistent peer aggregation, so mere drone relabeling cannot select different physical behavior. Neither change requires restoring rule-based path allocation. More expressive joint target selection or memory should follow evidence from these bounded ablations, not be combined into an uninterpretable redesign.

Local scripts and JSON are in ignored `test-results/patrol-rl-action-investigation-2026-10-07/`: `action-selection`, `fresh-policy-control`, `actor-sensitivity`, `frozen-logits-control`, `actor-initialization-diagnostic`, and `coordinate-probe`. These are finite validation diagnostics over three optimizer seeds, not confidence intervals, global optimality evidence, or real-world transfer claims. Saved models and the existing local preview remain unchanged.

## Controlled actor-normalization experiment — 2026-10-07

Implemented the opt-in, non-affine first-layer normalization described above, strict checkpoint-v3 serialization with v1/v2 compatibility, frozen CPU inference parity, and pre-update actor diagnostics. The default remains `none`. A fresh matched experiment changes only `actorNormalization`: `none` versus `layer`, with reward scale `0.001`, global gradient clipping, seeds 42/73/101, and 64 episodes each. Both arms start with identical weights and RNG states. All scenarios, fleet schedules, observation features, critic settings, rewards, masks, battery/fault rules, and qualification requirements remain fixed.

All six runs completed: 384 training episodes, 108,384 control steps, 1,698 rollout updates, and 576 matched validation episodes across all eight fleet sizes. Every non-normalized control reproduces the prior scaled/global weights, RNG state, training episodes, all original optimizer metrics, and complete evaluation exactly. Source snapshots, identical demand, unchanged rule-based baselines, and fleet qualification are independently verified. No final-test scenarios are used.

### Activation health improves, greedy service worsens

Eight-drone results, person-time weighted within each seed then averaged across three seeds:

| Metric | No normalization | Actor normalization |
| --- | ---: | ---: |
| Healthy crowded on-time | 37.77% | 30.86% |
| Healthy people in view | 16.56% | 14.01% |
| Healthy gap cost | 286.99 | 421.32 |
| Fault crowded on-time | 25.13% | 18.35% |
| Fault gap cost | 412.34 | 534.03 |

Healthy crowded coverage decreases in all three paired seeds, by 0.29–13.49 percentage points, averaging −6.91 points. Fault greedy coverage also decreases in every seed. Healthy mean gap cost worsens at every fleet size. Fleet two is an exception for crowded on-time coverage alone, improving from 9.02% to 12.47%, but its gap cost worsens and it does not qualify. Across all 192 neural validation episodes neither arm has stranded drones, reserve violations, rejected commands, or forced returns; **no fleet qualifies**.

The first/middle/last 32-update blocks were declared before training. In the last block, control first-layer saturation reaches 98.46–99.96% across seeds; normalized saturation is zero. Held-out healthy-state saturation likewise drops from 99.22% to zero. This eliminates the measured saturation symptom, but is not sufficient to improve patrol service.

`diagnose-final-policies.mjs` exactly reproduces all 24 fleet-eight greedy episodes and verifies frozen CPU inference against the training implementation on every decision: 7,608 calls / 60,864 head outputs. It also runs 24 independent fixed-initial-logit interventions with live masks. The controls remain exactly reproducible from fixed logits in 12/12 cases. Normalized policies reproduce 6/12 cases exactly; on healthy original-trajectory states their per-seed actionable-command agreement with initial logits is still 93.90%, 99.978%, and 99.975%. These same-state comparisons are separate from comparisons of trajectories that have diverged.

Normalized demand/history/peer perturbations produce mean distribution total variations of only 0.000348 / 0.001278 / 0.000393, while physical slot relabeling still changes 82.92% of healthy greedy decisions. Feature edits are checked to be nontrivial, and the probe uses the implementation's actual normalized forward path. Useful adaptation and permutation-consistent coordination remain unresolved despite healthier activation ranges.

### Sampling and fresh-network controls

An additional 204 frozen episodes compare trained and never-trained actors in both normalization modes, using three matched action-RNG streams and the same four validation cases at fleet eight. All 24 trained greedy replays match saved results exactly. Repetitions are averaged within initialization/optimizer seed before comparing seeds.

| Healthy crowded on-time | Greedy | Sampled |
| --- | ---: | ---: |
| Trained, no normalization | 37.77% | 53.00% |
| Trained, normalized | 30.86% | 52.36% |
| Fresh, no normalization | 36.49% | 50.09% |
| Fresh, normalized | 38.60% | 50.20% |
| Masked uniform random | — | 49.68% |
| Adaptive reference | 74.90% | — |

There is a modest contrary result in the single fault case: normalization improves trained sampled coverage from 47.11% to 50.40%, versus 47.27% for fresh normalized sampling and 47.56% for masked random. All three seedwise sampled differences are positive, but this is not broad resilience evidence. Healthy trained sampled coverage falls by 0.64 points on average, and trained normalized greedy coverage is 7.74 points below its fresh-network control. Healthy greedy hover/standby frequency rises from 22.27% to 34.82%. None of these 204 episodes meets geographic or hotspot feasibility; all have zero recorded safety events.

### Decision and validation

Do not promote this candidate or extend identical training merely because saturation improved. Keep normalization opt-in for reproducibility and the default/preview unchanged. The next bounded design should address state representation and drone-slot dependence, for example a shared per-drone action head with permutation-consistent peer aggregation, while retaining the same objective and safety contract and comparing against fresh/random controls. That redesign is not implemented in this experiment. Three optimizer seeds and one fault case remain limited descriptive evidence, not confidence intervals or global claims about normalization.

Validation passes 317 unit tests, three CLI integration tests including exact saved-policy reload for both modes, TypeScript, and the production build. Numerical tests cover per-observation normalization, finite-difference gradients, zero variance, forced masks, overflow rejection, tensor disposal, and legacy inference. The headless actual-model browser check reaches playback/reset but fails on the already observed negative canvas arc radius (`-20.5`) after the viewport change; rendering code was not modified and that separate UI bug remains unresolved.

Artifacts are local and ignored: `test-results/patrol-rl-normalization-2026-10-07T00-20-53Z/`, containing the pinned plan/source snapshot, six runs, `comparison.json`, `final-policy-diagnostics.json`, `action-selection.json`, and their runners. The existing three preview models and manifest remain byte-identical. Nothing is committed, pushed, deployed, or automatically selected.

## Shared state-conditioned actor experiment — 2026-10-07

Implemented the opt-in `--actor-architecture shared` candidate described above: one learned `68 → 32 → 32 → 1` scorer shared across drone/action pairs, with local candidate demand/history summaries and permutation-consistent peer aggregation. These are engineered observation features, not hand-written action priorities or routes. The actor learns how to combine them. The critic, reward terms, actions, masks, and simulator remain unchanged. Checkpoint v4 records the architecture; v1–v3 dense checkpoints retain compatibility. The default and existing preview remain dense.

The matched experiment uses reward scale `0.001`, global clipping, no actor normalization, optimizer seeds 42/73/101, and 64 episodes per arm/seed. Shared and dense actors necessarily have different parameter shapes, but initial critic weights and post-initialization sampling RNG are identical. All fleet sizes one through eight, the original eight training scenarios, four validation scenarios, episode schedules, demand, battery/fault rules, and qualification requirements stay fixed. Totals: six runs, 384 training episodes, 108,384 control steps, 1,698 rollout updates, and 576 validation episodes. The dense controls reproduce the preceding non-normalized controls' weights, RNG, training episodes, every existing optimizer metric, and complete evaluation exactly. Source snapshots and unchanged deterministic baselines are independently checked. No final-test cases are used.

### Substantial population-service improvement, not fleet qualification

Healthy eight-drone service, person-time weighted within each seed and then averaged across three seeds:

| Controller | Crowded on-time | People in view | Gap cost (lower is better) |
| --- | ---: | ---: | ---: |
| Dense learned control | 37.77% | 16.56% | 286.99 |
| Shared learned actor | 71.33% | 24.97% | 4.04 |
| Uniform reference | 63.88% | 16.57% | 5.16 |
| Adaptive reference | 74.90% | 26.30% | 2.39 |

Shared crowded on-time is 74.49%, 62.24%, and 77.24% for seeds 42/73/101 respectively. All three improve over their dense controls; the shared mean remains below adaptive. In the fault case, crowded on-time improves from 25.13% to 64.84% and gap cost from 412.34 to 10.81, versus adaptive's 66.38% and 3.91. Across all 96 paired scenario/fleet/seed cases, shared has no regressions in crowded on-time, population on-time, or gap cost. However, 11 cases regress in instantaneous visibility and 11 regress in peak never-observed people. These metrics are not interchangeable.

All 192 neural validation episodes record zero reserve violations, stranded drones, forced returns, or rejected commands. **No fleet qualifies.** Geographic service is not repaired: mean per-seed worst healthy audited coverage at fleet eight changes from 13.57% to 13.30%; the fault-case minimum falls from 26.51% to 2.97%. At fleet five in fault seed 101, peak never-observed population worsens from 2,148 to 6,270 despite improved on-time coverage and gap cost. This is an episode peak, not the number of unique people or an end-of-episode count. Better population-weighted service does not establish whole-area coverage, elimination of blind spots, or the feasibility of a smaller fleet.

### The actor now uses live state

`diagnose-final-policies.mjs` runs 72 episodes: 24 normal greedy replays, 24 fixed-initial-logit controls with live masks, and 24 fixed-initial-map controls with live geometry, ego/peer state, globals, and masks. Every normal replay matches the saved evaluation exactly. Frozen browser inference matches the training implementation on all 7,608 decisions / 60,864 heads, with no tensor leaks.

Among sampled healthy responsive multi-action heads, shared first-layer saturation is zero, versus 99.22% for dense. Shared activation health counts only legal candidate rows; it is not directly comparable to the padded/all-candidate training averages. Mirroring demand/history/peers produces shared mean distribution total variations of 0.238/0.305/0.0486 and changes 67.27%/77.25%/17.13% of greedy choices. Dense choices do not change under these interventions. Exact drone-slot relabeling changes 87.44% of dense choices but **zero** shared choices, with shared total variation and KL both exactly zero. These are descriptive probes, not independent statistical samples or realistic sensor perturbations.

| Shared actor input | Healthy crowded on-time | Fault crowded on-time |
| --- | ---: | ---: |
| Live observation | 71.33% | 64.84% |
| Initial logits held fixed | 24.98% | 8.66% |
| Initial demand/history raster held fixed | 39.20% | 22.49% |

Both frozen interventions worsen revisit service for all three shared seeds; none reproduces a complete shared episode. Both reproduce all twelve dense episodes exactly. On the shared actor's original healthy trajectories, same-state actionable-command agreement with initial logits is only 14.23%, and agreement with the frozen-map actor is 18.40%. These same-state comparisons are separate from actions compared on diverging rollout trajectories.

The map intervention freezes raster channels 1–4 together: population, local/global scan age, and ever-observed status. It leaves globals live, so inputs can be inconsistent. It demonstrates useful dependence on the joint live map, not isolated population causality. Healthy instantaneous visibility actually increases from 24.97% to 26.76% under the frozen-map intervention while crowded revisit coverage falls and gap cost rises from 4.04 to 1,241.49. This tradeoff is why visibility alone cannot establish success. All 72 episodes have zero recorded safety events; none passes geographic or hotspot feasibility.

### Learning exceeds fresh-network and random controls

`action-selection.mjs` adds 204 frozen fleet-eight episodes, comparing trained and matching freshly initialized dense/shared actors in greedy and sampled modes, plus masked uniform random. Three action-RNG streams are averaged within each optimizer seed before the three-seed comparison. All 24 trained greedy replays match saved evaluations exactly; initial critic/RNG pairing, source/checkpoint hashes, and preview integrity are checked.

| Healthy crowded on-time | Greedy | Sampled |
| --- | ---: | ---: |
| Trained dense | 37.77% | 53.00% |
| Trained shared | 71.33% | 74.41% |
| Fresh dense | 36.49% | 50.09% |
| Fresh shared | 16.18% | 50.59% |
| Masked uniform random | — | 49.68% |
| Adaptive reference | 74.90% | — |

Shared sampled learning exceeds its matching fresh network by 23.82 percentage points, with positive gains in every optimizer seed (20.07–26.40 points), versus 2.91 points for dense. Thus, the observed improvement is not explained by an untrained shared representation or random exploration alone. Shared sampling gives 31.04% people in view and gap cost 4.25, versus shared greedy's 24.97% and 4.04: sampling is not uniformly better on every healthy metric.

In the single fault case, shared sampled crowded on-time reaches 75.52%, versus shared fresh sampling 48.29%, masked random 47.56%, and adaptive 66.38%. Gap cost is 3.62 versus dense sampling 19.22 and adaptive 3.91. This is promising but only one fault case, not general resilience evidence. All 204 episodes record zero safety events and zero geographic/hotspot feasibility passes. Decoding defaults are not changed automatically.

### Larger NYC preview sanity check

Fourteen read-only episodes use the exact existing `createNYCPreviewScenario()` at fleet eight: a 640 m diameter, 0.3217 km² city, 120-second warmup, and 1,800-second scored run. This is 2.38× the largest training area, but it is a previously inspected preview scenario, **not a pristine final test**. It does not alter the preview or qualify a fleet.

| NYC controller | Crowded on-time | People in view | Gap cost |
| --- | ---: | ---: | ---: |
| Trained dense, three-seed mean | 19.47% | 5.70% | 1,209.85 |
| Trained shared, three-seed mean | 61.53% | 14.00% | 16.05 |
| Adaptive reference | 47.00% | 9.99% | 4.37 |

Shared crowded on-time ranges from 50.44% to 68.47%, versus 2.47% for fresh shared and 13.83% for masked random. Nevertheless, adaptive retains a better gap cost and audited geographic minimum: shared averages only 9.82%, versus dense 18.56% and adaptive 19.08%, all below the 95% area target. All fourteen episodes have zero recorded safety events. This is evidence of improved demand-responsive behavior on this larger case, not whole-area success or broad transfer.

### Decision, validation, and artifacts

The shared actor fixes the measured weak state response and slot dependence, with meaningful learned population-service gains under this controlled budget. Keep it available as an experimental candidate rather than auto-promoting a seed or claiming an optimal fleet. Remaining issues include geographic blind spots, inconsistent instantaneous visibility, seed variation, and limited scenario diversity. Fleet size already varies from one to eight, but geometry still comes from eight fixed training maps rather than new per-episode environments. The shared actor is factorized and has no explicit joint assignment or memory, so permutation consistency alone does not establish coordinated optimal allocation.

Validation passes 348 unit tests, 13 script tests (four training CLI, eight isolated preview preparation, one preview middleware), TypeScript, and the production build. Tests cover contextual demand-conditioned PPO learning, slot/padding invariance, masks, batch inference, strict v4/legacy loading, tensor disposal, and shared-feature provenance before preview replacement. The production build retains its bundle-size warning. These checks do not repair or replace the previously recorded canvas viewport UI test failure; rendering code is unchanged.

Artifacts remain local and ignored under `test-results/patrol-rl-shared-actor-2026-10-07T05-46-37Z/`: pinned plan/source snapshot, six complete runs, `comparison.json`, `final-policy-diagnostics.json`, `action-selection.json`, `nyc-sanity.json`, and their runners. All sources and protected artifacts are checked before/after the probes. Training and diagnostics finish; the existing three preview models and manifest remain unchanged. Nothing is committed, pushed, deployed, or automatically selected.

## Local preview activation — 2026-10-07

After the experiment, the user approved switching the local preview to the shared actor. The preparation script publishes the unchanged v4 seed-101 checkpoint (64 episodes) from `test-results/patrol-rl-shared-actor-2026-10-07T05-46-37Z/shared/seed-101/`. Seed 101 remains the existing default, not a newly selected optimum. The previous three-model preview is backed up under `.local/patrol-preview-backup-before-shared-2026-10-07T06-23-40-761Z/`. The served model's SHA-256 and shared architecture are verified through the local HTTP endpoint. Reload an existing tab to replace its cached in-memory policy. No training, production deployment, or fleet qualification occurs.

Actual-model playback exposed the previously recorded canvas resize error. Drawing now skips geometry when either canvas dimension cannot accommodate its padding; the resize observer redraws after layout recovers. New circle/rectangle regression tests reproduce the negative-radius failure without the guard, then pass with it for hidden, narrow, short, and exactly padding-sized canvases. All seven preview browser tests, including real shared-model motion, desktop/mobile resizing, pause/reset, and load failures, pass; TypeScript and the production build pass. The warning banner retains unmet-target/blind-spot cautions without the obsolete blanket claim that all trained policies underperform the baselines.

## Reconstructed NYC movement and clustering — 2026-10-07

The preview does not persist a flight history: it retains the current state and decision count, while training/evaluation artifacts contain aggregate episode/update metrics and checkpoints rather than trajectories. After the user observed six drones converging, a bounded diagnostic reconstructed the current default NYC/eight-drone/shared-seed-101 run, plus adaptive and matched dense-seed-101 controls. These are **reconstructed default trajectories, not recovered user-tab history**; other applied settings need a corresponding replay.

Each controller runs 1,920 simulated seconds and records 3,840 half-second physics samples plus 384 five-second decision/population records. Logs contain physical drone IDs, positions, battery/service/fault state, commands, population, and camera multiplicity. Only healthy patrolling drones in patrol service count as sensing. Physics measurements precede scheduled population refreshes, matching evaluator accounting. All three complete results exactly reproduce the saved NYC sanity results; all 384 post-refresh full snapshots per controller also match the UI playback session exactly. Current model, source, and preview hashes remain unchanged; no training or runtime edits occur.

At 30 seconds, drones 1/2/3/4/7/8 form a 60.92 m horizontal-diameter cluster away from the depot. At 32 seconds, that cluster tightens to 33.85 m and all six cameras observe the same crowded cell at `(220, -60)`, containing 467 people. Each of those six drones has zero exclusive currently visible people at that instant: the others already cover its footprint's populated cells. This is a leave-one-camera-out snapshot measure, not evidence that all six can be removed simultaneously or that a smaller fleet meets the mission requirements. Total fleet visibility at that instant is 1,018 unique people versus 4,724 when individual camera counts are summed.

| Scored period, 120–1,920 seconds | Shared seed 101 | Adaptive | Matched dense seed 101 |
| --- | ---: | ---: | ---: |
| Duplicate share of summed camera person-time | 44.55% | 0.83% | 0.61% |
| People in view, person-time weighted | 16.35% | 9.99% | 5.33% |
| Time with six cameras observing one crowded cell | 44.5 s | 0 s | 0 s |

Duplication is `(sum of individual camera person-seconds − union person-seconds) / sum of individual camera person-seconds`. It is not the fraction of drone flight time wasted. Six-way same-cell overlap is intermittent (36 seconds during the 120-second warmup and 44.5 seconds during the 1,800-second scored period), while substantial lower-order overlap persists. Connected overlap clusters are reported separately because a chain of nearby drones does not prove a shared footprint. Despite the redundancy, the shared actor still observes more unique population than these controls; low overlap alone is not the objective.

The reward already counts each visible populated cell once; overlapping cameras do not multiply its population credit. However, the shared actor independently chooses each drone's masked greedy action from one pre-command snapshot. Its coarse peer-position/prior-destination summaries do not represent the other drones' newly selected actions or candidate residual demand, and training supplies a single team advantage rather than per-drone counterfactual contribution. These mechanisms permit correlated hotspot attraction; the replay establishes redundancy, not which mechanism caused it. State responsiveness is improved, but complementary allocation remains unresolved.

Local ignored artifacts: `test-results/patrol-rl-clustering-2026-10-07T06-30-24Z/summary.json`, `served-shared-101.trajectory.jsonl`, `adaptive.trajectory.jsonl`, `matched-dense-101.trajectory.jsonl`, and `reconstruct.mjs`. The trajectory filenames are relative to that directory. No automatic browser logging/export feature is added by this diagnostic.

## Coverage-priority reward revision — 2026-10-07

The user confirmed that freshly covering the whole area should take priority, with a small penalty for redundant active sensing. `coverage-v2` implements the objective documented above and becomes the default for new training. `legacy-v1` remains an explicit reproducible control. New outer policy artifacts use version 2 and record the canonical reward specification; the inner PPO checkpoint stays at version 4. Existing version-1 artifacts retain legacy semantics and cannot be relabeled as newly trained coverage-priority models.

A six-episode frozen-policy diagnostic rescores the default NYC/eight-drone trajectories under both profiles: served shared seed 101, matched dense seed 101, and adaptive. Each pair has exactly equal observations, masks, actions, 3,840 half-second full snapshots, 384 post-refresh snapshots, and service metrics. All three complete legacy results, including reward, exactly reproduce the saved NYC sanity check. This verifies a scoring change without a physics change, not learning improvement or recovered browser history. Historical source fingerprints are not migrated or bypassed in the training/preparation CLI; this separate diagnostic deliberately replays frozen weights against pinned current sources.

| Controller | Geography cost | Population cost | Overlap cost | Total cost |
| --- | ---: | ---: | ---: | ---: |
| Shared seed 101 | 7.1163 | 1.5355 | 0.09016 | 8.9019 |
| Matched dense seed 101 | 9.8877 | 2.4802 | 0.00277 | 12.5307 |
| Adaptive | 2.0889 | 1.7659 | 0.00116 | 4.0159 |

The table shows positive cost magnitudes under `coverage-v2`, normalized to five seconds over the full 1,920 seconds, including 120 seconds of warmup. Reward is the negative of cost; every row also includes 0.16 fleet cost and zero safety cost. Scored-only and warmup-only components are stored separately. On the shared trajectory, geography rises from 18.6% of legacy cost to 79.9% of new cost, population falls from 80.2% to 17.2%, and overlap contributes 1.0%. This measured balance is trajectory-specific, not a fixed percentage weighting. The overlap measure is geographic footprint duplication, not the earlier population-weighted 44.55% duplication statistic. Adaptive still outranks shared, then dense, under both objectives.

Validation passes: 381 unit tests, 32 CLI/preparation/server tests, seven isolated browser preview tests (including the real served model), TypeScript, and the production build. Short CLI integration tests exercise training/artifact round trips; no full training experiment is started. The source and model hashes remain unchanged during the diagnostic, and the existing local preview continues serving the original legacy-trained shared seed-101 weights. Retraining and held-out evaluation are required before claiming improved coverage or promoting a replacement model.

Local ignored diagnostic artifacts: `test-results/patrol-rl-reward-profile-2026-10-07T07-20-00Z/summary.json`, `compare-frozen.mjs`, the pinned plan, and per-controller results.

## Coverage-priority training pilot — 2026-10-07

Three fresh shared actors train with `coverage-v2` for 64 full episodes each, using seeds 42/73/101 and the previous `0.001/global/none` optimizer settings. The eight training scenarios, four validation scenarios, fleet sizes 1–8, and per-seed episode schedules match the archived legacy shared-actor experiment. No optimizer resume or final-test evaluation is used. The batch finishes in 16 minutes 56 seconds: 192 training episodes, 54,192 control steps, 849 PPO updates, and 288 validation episodes (96 neural). This is a bounded pilot on a small, repeatedly inspected validation bank, not a convergence or broad-generalization result.

Healthy eight-drone validation results, averaged equally across optimizer seeds after scored-time geographic aggregation or person-time population aggregation within each seed:

| Metric | Legacy-trained shared | Coverage-trained shared | Adaptive |
| --- | ---: | ---: | ---: |
| Mean fresh audited area | 86.73% | 96.05% | 96.32% |
| Time audited area meets 95% target | 41.43% | 86.18% | 89.30% |
| Active camera geometric overlap, time mean | 27.80% | 22.29% | 4.09% |
| Crowded-person on-time coverage | 71.33% | 64.30% | 74.90% |
| People currently in view | 24.97% | 17.12% | 26.30% |
| Population gap cost | 4.04 | 3.89 | 2.39 |

The new objective produces substantially broader geographic service, but does not consistently maintain it. All three seeds improve mean area and target-time fraction. Mean per-seed worst healthy audit coverage actually falls from 13.30% to 5.56%, including a zero-coverage case. Healthy scored time with no active sensing increases from 7.10% to 7.67%, and average active sensors fall from 3.09 to 2.89 of eight aircraft. Thus the overlap decrease is not proof of better joint allocation alone. Saved worst-coverage snapshots show charging/waiting bottlenecks; changing reward has not solved fleet availability. All 96 neural validation episodes have zero reserve violations, stranded drones, forced returns, and rejected commands, but **no fleet qualifies**. Recorded safety compliance does not imply uninterrupted surveillance.

In the single fault scenario, mean audited area improves from 72.82% to 92.06% and audit-only target time from 13.20% to 74.26%; crowded on-time coverage falls from 64.84% to 52.41%. This remains one previously inspected fault case, not resilience certification.

The larger NYC eight-drone diagnostic also improves geographic coverage, but remains well below the target:

| NYC metric, three-seed mean | Legacy-trained shared | Coverage-trained shared | Adaptive |
| --- | ---: | ---: | ---: |
| Mean fresh audited area | 53.61% | 77.87% | 89.96% |
| Time audited area meets 95% target | 0.00% | 8.95% | 32.67% |
| Active camera geometric overlap, time mean | 40.91% | 35.05% | 0.43% |
| Crowded-person on-time coverage | 61.53% | 32.51% | 47.00% |
| People currently in view | 14.00% | 5.73% | 9.99% |

These overlap values use scored-only time-mean redundant geographic footprints, not population-weighted duplication or fleet-time waste. NYC is an inspection scenario, not a pristine held-out test. All 35 frozen diagnostic replays use the common `coverage-v2` score; historical artifacts retain their legacy identity. Archived service metrics and new saved validation results reproduce exactly, while new and old training rewards are not compared across objectives. The evaluator's existing target-time field requires both planner and audit grids to meet target; the table instead reports audit-only threshold time independently sampled every half-second.

Optimizer diagnostics are finite and show active learning rather than obvious actor starvation at scale `0.001`: first-to-last-quartile actor state variation grows from 0.018 to 0.330, and final actor parameter-step norm is 0.0367 versus legacy 0.0388. The critic remains weak: final explained-variance medians across seeds are approximately −0.062, +0.019, and −0.006, with mean RMSE/return-standard-deviation 2.09 and first-layer saturation 89.5%. Small learner-unit value loss does not demonstrate good fit. These are on-policy rollout diagnostics, not a causal scale experiment; no automatic hyperparameter changes follow this pilot.

All source snapshots, deterministic baseline service results, scenario schedules, model metadata, and protected preview/historical hashes pass integrity checks. The local preview still serves the original legacy-trained shared seed 101; new checkpoints are saved but not applied, committed, pushed, or deployed. Before promotion, address the geographic-versus-population tradeoff, simultaneous charging gaps, and persistent overlap rather than treating higher mean coverage as mission success.

Local ignored artifacts: `test-results/patrol-rl-coverage-2026-10-07T07-29-30Z/`, containing `plan.json`, `source-snapshot/`, `run-training.mjs`, `completed.json`, `coverage/seed-<seed>/` checkpoints/reports, `comparison.json`, `compare.mjs`, `replay-summary.json`, per-episode diagnostic records, and `training-diagnostics.json` with its runner.

## Longer, broader coverage training — 2026-10-07

At the user's request, three fresh shared actors train for 128 full episodes each using seeds 42/73/101, unchanged `coverage-v2` reward, and the same `0.001/global/none` optimization settings. The bank expands from eight to sixteen training environments and from four to eight validation environments while preserving the original cases exactly. All fleet sizes 1–8 remain included. Both training budget and environment diversity change, so this is an endpoint comparison, not an isolated experiment on episode count. Each training scenario still receives eight episodes; these are fresh models, not resumed checkpoints or exact optimizer continuations.

Training and validation finish in 33 minutes 33 seconds: 384 training episodes, 109,464 control steps, 1,713 PPO updates, and 576 validation episodes (192 neural). Control-step counts include the partial final step of non-five-second-aligned episodes. Constructor checks for all 24 scenarios × eight fleets find no initial reserve deficits or drones without legal movement. This initial feasibility check does not establish mission feasibility. No final-test split is used.

A further 147 unique frozen episodes evaluate the previous 64-episode models on all added validation cases and fleets, then compare fleet-eight sensing behavior on both validation cohorts and NYC. Saved results reproduce exactly; current source fingerprints and canonical reward metadata match both model generations. Original, added, and NYC cases are kept separate rather than pooling different scenario difficulty.

### Results: no consistent improvement

Eight-drone healthy validation, with equal optimizer-seed weighting and scored-time geographic/person-time population aggregation:

| Metric | Original cases: 64 episodes | Original cases: 128 episodes | Added cases: 64 episodes | Added cases: 128 episodes |
| --- | ---: | ---: | ---: | ---: |
| Mean fresh audited area | 96.05% | 95.89% | 93.36% | 93.39% |
| Time audited area meets 95% target | 86.18% | 84.74% | 62.41% | 66.06% |
| Geometric overlap, scored time mean | 22.29% | 23.46% | 10.48% | 11.07% |
| Crowded-person on-time coverage | 64.30% | 63.45% | 50.43% | 49.76% |
| Population gap cost | 3.89 | 4.09 | 4.96 | 5.20 |

The added healthy cases gain target-time coverage and improve their worst observed audited coverage, but do not deliver a broad population or redundancy improvement. Across all fleets, geographic mean improves in 55/96 original-case pairs and 43/72 added healthy pairs; crowded on-time service regresses in 52/96 and 48/72 respectively. These are descriptive paired counts, not independent statistical trials.

| NYC, three-seed mean at fleet eight | 64 episodes | 128 episodes |
| --- | ---: | ---: |
| Mean fresh audited area | 77.87% | 75.86% |
| Time audited area meets 95% target | 8.95% | 8.00% |
| Geometric overlap, scored time mean | 35.05% | 40.93% |
| Crowded-person on-time coverage | 32.51% | 28.48% |
| People currently in view | 5.73% | 4.91% |
| Population gap cost | 14.07 | 15.18 |

Charging gaps remain: zero-active-sensor time changes from 7.67% to 7.63% on original healthy cases, 7.61% to 7.34% on added healthy cases, and 5.19% to 5.09% in NYC. In the new models' worst original healthy snapshot, audited freshness is only 7.33% with one patrolling drone, five waiting, and two charging. The added healthy worst is 14.88%, with one patrolling, six waiting, and one charging. These minima are worst across all selected seeds/cases, not mean per-seed minima. No fleet qualifies under the original or expanded requirements. All 192 new neural validation episodes record zero reserve violations, stranded drones, forced returns, and rejected commands; that is not continuous-surveillance success.

### Added fault-test limitation

The added moving-corridor scenario schedules a deviation, but the engine rejects that injection when the chosen aircraft is charging, waiting, or in standby rather than patrolling/returning. It applies in 0/24 old-model cases, 1/24 new-model cases (seed 73, fleet eight), 8/8 uniform cases, and 0/8 adaptive cases. The wrapper makes one scheduled attempt, not a later retry. Instrumented frozen replays record the target's actual before/after state without changing it.

All 24 old/new pairs for that scheduled fault are excluded from comparable fault directional counts; their raw results remain stored with `faultApplied`, rather than being relabelled as healthy or claimed as resilience evidence. The original malfunction scenario still applies normally. An initial diagnostic assertion incorrectly assumed every scheduled fault would apply; it was corrected in the diagnostic script only, and the failed preflight remains in its log. The simulation and saved training artifacts were not altered to manufacture passing fault tests. Improve this test protocol before using the new deviation case as a robustness benchmark.

### Learning diagnostics and disposition

All 1,713 new update records are finite. Final-quartile actor state variation rises from 0.330 to 0.398 and entropy decreases from 0.841 to 0.811, with nonzero actor/critic steps throughout; the actor is not numerically inactive. Critic fit remains weak: mean RMSE/return-standard-deviation changes only from 2.09 to 2.02, while first-layer saturation increases from 89.5% to 95.1%. New explained-variance medians are 0.071/−0.013/0.151 across seeds, with strongly negative tails. These on-policy diagnostics compare different training banks and trajectories and do not establish a causal optimizer improvement.

Keep both generations as experimental baselines. The results do not justify promoting the longer-trained models or assuming another longer batch will fix coordination. Charging availability, redundant joint actions, and critic learning remain priorities for a controlled follow-up. The local preview still serves the earlier legacy-trained shared seed 101; no new model is applied, committed, pushed, or deployed. All twenty source/snapshot hashes and sixty-one protected artifact hashes remain unchanged, and all training processes exit.

Local ignored artifacts: `test-results/patrol-rl-coverage-more-2026-10-07T10-45-34Z/`, including the pinned plan and source snapshot, preflight evidence, `completed.json`, `coverage/seed-<seed>/` models, `comparison.json`, `replay-summary.json`, per-case replay records, and training diagnostics with reproducible runners.

## Learned coordination and critic normalization — 2026-10-07

The new opt-in `--actor-architecture autoregressive` addresses independent drones choosing the same destination from a stale shared snapshot. The control center selects commands sequentially in a canonical observation-based order. Each later drone's learned scorer receives the earlier drones' actual chosen commands through twelve additional features, including intended sensing endpoints/midpoints, approximate footprint overlap, and return/standby counts. These are inputs to learned weights, not hard-coded assignments, reserved routes, or extra action penalties. Existing masks, safety rules, fleet schedules, physics, and `coverage-v2` reward remain unchanged.

PPO reconstructs exactly the same conditional features from recorded actions and clips the joint likelihood ratio. Incremental and teacher-forced probabilities match, future/self commands cannot leak into a decision, and browser inference matches the trained model's greedy actions. A small contextual learning regression starts two drones in identical states and learns complementary choices for both possible earlier commands, exceeding 85% success for each after eight batches of 32 samples. This establishes conditional learnability, not optimal patrol coordination. The actor still has no temporal memory; canonical ordering is not rotation-equivariant, and its entropy regularizer is a recorded-prefix conditional surrogate rather than exact current-policy joint entropy.

Independent `--critic-normalization layer` normalizes the critic's first preactivations before tanh, using no extra learned parameters or initialization draws. The same implementation drives value inference, training gradients, and saturation diagnostics. Both additions remain opt-in; existing architecture/normalization defaults are preserved. Inner checkpoints advance to version 5, while strict version 1–4 readers retain their original behavior with critic normalization disabled. Outer reward metadata remains version 2. New artifacts fingerprint the coordination module, and preview preparation requires the relevant feature provenance instead of bypassing historical source checks.

### Fixed-target critic fit

Eight deterministic rollouts from the frozen 128-episode shared seed-101 reference generate 2,316 samples: 768 fit samples, 290 unused chronological-tail samples, and 1,258 samples from separate validation scenarios. Paired fresh critics use seeds 42/73/101, identical initial weights and minibatch schedules, and 256 batches of 64 examples. Actor weights and inference RNG never change. Targets are common frozen-reference, 64-step scaled GAE returns, so this is a bootstrap-dependent diagnostic rather than ground-truth value evaluation.

| Mean RMSE / target standard deviation; lower is better | No normalization | Layer normalization |
| --- | ---: | ---: |
| Fit samples | 0.4960 | 0.4109 |
| Unused chronological tails | 0.9291 | 1.1009 |
| Separate validation scenarios | 0.8591 | 0.8870 |

First-layer saturation on fit samples falls from 77.75% to 0.0109%, and from 78.37% to zero on the separate scenarios. Training fit improves, but neither held-out RMSE improves. Separate-scenario explained variance increases slightly while prediction bias worsens, illustrating why explained variance or activation saturation alone is insufficient. **Normalization fixes the measured saturation problem, not demonstrated value generalization.** Keep it experimental rather than changing the default.

### Controlled four-arm training pilot

Four fresh seed-42 models each train for sixteen full episodes on the same eight training environments, four validation environments, fleet sizes 1–8, schedule, reward, and `0.001/global/none` reward-scale/clipping/actor-normalization settings. The arms change only shared versus autoregressive architecture and disabled versus layer critic normalization. The batch completes 64 training episodes, 18,064 steps, 284 updates, and 384 validation episodes in 5 minutes 28 seconds, followed by 25 frozen replays. Architecture changes also change parameter shapes and sampled trajectories: this is an early one-seed comparison, not a reliable architecture ranking or convergence result.

| NYC, eight drones | Mean fresh audited area | Geometric camera overlap | Crowded-person on-time coverage |
| --- | ---: | ---: | ---: |
| Shared control | 66.11% | 40.19% | 50.23% |
| Critic normalization only | 62.57% | 22.49% | 75.74% |
| Autoregressive coordination only | 80.55% | 2.35% | 82.34% |
| Both additions | 82.63% | 4.30% | 75.92% |
| Adaptive reference | 89.96% | 0.43% | 47.00% |

Coordination alone also raises NYC instantaneous population visibility from 9.21% to 20.06% and lowers population gap cost from 13.16 to 2.71. Mean active sensors increase from 4.84 to 4.97, so the large overlap reduction is not merely caused by fewer sensing drones. Overlap is scored-time-mean redundant geographic footprint, not population-weighted duplication. NYC remains a repeatedly inspected diagnostic, not a pristine final test.

Across the three healthy validation cases at fleet eight, coordination changes mean fresh area from 93.78% to 94.49%, overlap from 23.72% to 5.57%, and crowded on-time coverage from 69.72% to 80.04%. The combined model reaches 94.71%, 7.53%, and 78.39%, respectively. Geographic and overlap statistics are scored-time weighted; population service is person-time weighted. All models still experience zero-active-sensor periods: approximately 7% of healthy scored time and 4.7–5.3% in NYC. **No fleet qualifies**, and charging availability remains unresolved. All 128 neural validation episodes record zero reserve violations, stranded drones, forced returns, and rejected commands; all 32 scheduled malfunction injections apply. Safety counters include warmup, whereas the service table excludes it.

The on-policy critic diagnostics are mixed, consistent with the separate fixed-target probe. Last-quartile RMSE/return-standard-deviation changes from 2.352 to 2.375 when normalizing the shared critic, and from 2.327 to 2.180 for the autoregressive critic. Explained-variance medians change from 0.066 to 0.226 and from 0.012 to −0.061, respectively. These involve different on-policy trajectories and do not establish a general critic improvement. Coordination is promising enough for a larger matched-seed follow-up; normalization should not be assumed beneficial merely because it eliminates saturation. This pilot does not include fresh-network patrol controls or establish an optimal fleet.

### Validation and disposition

All 420 unit tests, 50 script tests (eight training CLI, 41 isolated preview preparation, one preview middleware), seven browser preview tests, TypeScript, and the production build pass. The existing bundle-size warning remains. Validation covers conditional learning/probabilities, masks, permutations, padding, float32 frozen inference, normalization gradients and diagnostics, legacy checkpoint schemas, source provenance, and tensor disposal. The served legacy model passes the real-model browser checks.

All twenty validation replays exactly reproduce their saved results. The control's sixteen training episodes and first seventy full-rollout PPO updates exactly match the archived coverage-training prefix; its final partial update is excluded from that comparison. Pinned source hashes, reward/overlap accounting, scenario schedules, and protected model/preview hashes pass integrity checks. The existing local preview remains the legacy-trained shared seed-101 model. No new checkpoint is automatically applied, committed, pushed, or deployed.

Local ignored artifacts: `test-results/patrol-rl-coordination-2026-10-07T11-37-09Z/`, including `critic-fit-summary.json`, its fixed-target dataset and runner, validation logs, and `pilot/` with pinned plans/sources, four models, training logs, `comparison.json`, and frozen replay records/runners. All planned training and diagnostics complete; no final-test split is used.

## Local coordination preview activation — 2026-10-08

At the user's request, the local preview switches to the unchanged coordination-only pilot checkpoint: autoregressive actor, critic normalization disabled, seed 42, sixteen completed episodes, and `coverage-v2`. This is the promising experimental candidate from the four-arm comparison, not a qualified fleet or a selected general-purpose optimum. Preparation verifies the completed run, validation scenarios, reward metadata, and runtime/feature source hashes before publishing it. The served checkpoint exactly matches `test-results/patrol-rl-coordination-2026-10-07T11-37-09Z/pilot/coordination/policy-42.json`, with SHA-256 `4ed2cfbcf18c10d89eb33ca26d6b93e5d1e5a7d6a95e4d47ad0a10a8b2398968`.

The previous legacy-trained shared seed-101 preview is retained in `.local/patrol-preview-backup-before-coordination-2026-10-08T07-14-10Z/`. Open `http://127.0.0.1:5173/neural.html`; reload existing tabs to replace cached in-memory weights. The actual-artifact browser test now reads the active seed and episode count from the served manifest and verifies its checkpoint hash rather than requiring the old seed-101/64-episode model. Training outputs, prepared models, backups, and TypeScript build metadata stay ignored. Pushing the source to `main` triggers the existing CI/production workflow, but the neural preview and its local checkpoint remain excluded from production assets.

Pre-push validation passes all 420 unit tests, 50 script tests, and the complete 35-test browser suite, including the actual autoregressive checkpoint on desktop and mobile. TypeScript and the production build pass with the existing bundle-size warning; production output contains neither `neural.html` nor the local model endpoint/assets. Logs remain in ignored `test-results/release-coordination-2026-10-08/`.
