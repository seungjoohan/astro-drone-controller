# Astro Flight Lab

A browser-based 3D drone simulator for practicing with an Astro C40 TR or a keyboard, with a centralized autonomous patrol sandbox. Built with TypeScript, Three.js, and Vite. Everything runs locally; no account, drone, or backend is required.

## Run

Use Node.js 22.12+ or a compatible newer release.

```sh
npm install
npm run dev
```

Open the localhost URL printed by Vite (normally http://127.0.0.1:5173). For a production build, run `npm run build`, then `npm run preview`. The scene requires a browser with WebGL 2 and hardware acceleration. Google Fonts are optional; system fonts are used if unavailable.

## Connect your C40

1. Set the C40’s connection switch to **Wired** and connect it using a micro-USB **data** cable.
2. Open the simulator, click the page, then press a controller button. Browsers may not expose a gamepad until you interact with it.
3. Open **Controller setup** to check the detected device, raw axes, and button numbers. The C40 may appear under a generic gamepad name.
4. Release both sticks and choose **Center sticks** if there is drift. Adjust the deadzone and axis inversion as needed.
5. Close setup, start the motors, and push the left stick up to climb.

The standard browser layout is the default, but every axis and action button can be remapped. Calibration is stored per device ID, and settings are stored locally in this browser. The wireless connection uses the C40’s USB transmitter, not generic Bluetooth pairing.

The C40’s [official quick-start guide](https://cx-assets.logi.com/ASTRO/QSG_C40_TR_Controller-Gen1.pdf) documents PC wired and transmitter setup. Recognition is dependent on the operating system, installed drivers, and browser; C40 detection on macOS is **not guaranteed**. The app cannot supply a missing device driver. Try the keyboard if your OS does not expose the controller. The [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API) needs a supported browser and a secure context (localhost or HTTPS). Automated controller checks use simulated browser gamepad input; they do not verify a physical C40’s driver or button layout.

## Controls

| Action | Standard controller layout | Keyboard |
| --- | --- | --- |
| Climb / descend | Left stick up / down | W / S |
| Turn left / right | Left stick left / right | A / D |
| Forward / backward | Right stick up / down | Up / Down arrows |
| Strafe left / right | Right stick left / right | Left / Right arrows |
| Start / stop motors | Bottom face button (0) | Space |
| Change camera | Top face button (3) | C |
| Reset | Button 8 | R |
| Pause / resume | Button 9 | P or Escape |

Button numbering is browser-specific. Inspect the live button readout before relying on these defaults. Controller remapping software can change the reported layout.

## Practice

- **Flight maps:** Use the map selector above the viewport to switch between **Pine Valley** and **Midtown NYC**. Your choice is saved in this browser. Switching maps returns to the landing pad, stops the motors, and resets the flight and course progress, while keeping your controller settings, flight mode, and wind selection.
- **Midtown NYC:** An imagined New York-inspired city with over 200 brick, stone, and glass buildings, stepped skyscrapers up to 238 m, avenues, rooftop details, and a pocket park. Explore between buildings, climb above the skyline, or land gently on a flat roof. Wall impacts and hard touchdowns end the flight. Follow the streets and climb to 10 m for the first city gate. This is a fictional map, not a geographic reconstruction of NYC.
- **Assisted:** Centered sticks brake horizontal movement and hold altitude. Start here, climb to around 6 m, then practice gentle turns and landings.
- **Sport:** Higher speed, more inertia, and faster descent, while retaining altitude hold. This is not an acro/rate flight mode.
- **Free flight:** Explore the training area with chase, first-person, or observer cameras.
- **Gate course:** Cross the highlighted ring, then continue through all six gates. Either crossing direction counts; crossing outside the opening does not.
- **Gentle wind:** Adds a changing crosswind to practice correcting drift.

Flight pauses when an active flight loses window focus, the tab becomes hidden, or the selected controller disconnects. Reconnect or resume with the keyboard. Controller setup and the guide pause active flight. Reset returns to the pad and restores the simulated battery while keeping your selected mode and wind setting.

Descend gently and land before stopping the motors: disarming in the air removes lift and can cause a crash. Hard landings and building collisions require a reset. The battery lasts about eight minutes of motor time. Pine Valley has a 160 m radius and a 90 m altitude ceiling; Midtown NYC has a 320 m radius and a 300 m ceiling. The physics constrains the drone at those boundaries.

## Landings and collisions

- **Soft landing:** Touch down from above at no more than **3 m/s downward** and **2 m/s sideways**. Flat rooftops and the ground both support landings. For roofs, the whole drone must fit inside the roof edges. The green landing message shows your touchdown speeds.
- **Hard landing:** Descending onto the ground or a roof faster than either limit ends the flight. The status distinguishes a hard rooftop landing from a hard ground landing.
- **Building collision:** Hitting a wall, underside, or roof edge ends the flight even at low speed. A distinct collision message appears; press **R** to reset.

In Assisted mode, release the movement stick and wait for horizontal motion to stop, then descend with the left stick or **S**. Once landed, you can stop the motors without falling off the roof. Start the motors again if needed, then push up or hold **W** to take off. These thresholds are simulator settings, not real-aircraft limits.

## Autonomous patrol

Open **Patrol** in the main navigation for a separate, top-down control center using the existing Midtown NYC layout and its **320 m circular boundary**. Manual flight pauses while the control center is open; a controller is not needed for autonomous patrol.

1. Set a **coverage target** and **revisit window**. Defaults are **95% of sampled area revisited within the last 120 simulation seconds**, not just visited once.
2. Use the recommended fleet, or choose **1–8 drones** to compare coverage against fleet size. **Apply and reset** starts a new mission with those settings and clears coverage history.
3. Start patrol. The central planner assigns colored routes across the whole boundary. Use the simulation-speed control to observe several patrol cycles quickly.
4. **Fail** or **Divert** a drone to test detection and automatic redistribution. Once isolated, its work is reassigned across the surviving fleet. Existing aircraft positions, mission time, and coverage history are preserved; no replacement drone is silently created.
5. **Restore** a drone to return it to the fleet and rebalance again. Pause/resume and mission reset are separate controls. Leaving Patrol, switching tabs, losing window focus, or opening a dialog pauses the mission until resumed. Controller setup returns to the Simulator so its input diagnostics stay live.

The coverage map distinguishes fresh, stale, and never-observed samples. Live coverage expires as simulation time advances, including when every drone is offline. The activity log records faults and route revisions. A surviving fleet can eventually sweep the entire area while still being unable to meet the original two-minute freshness target; the control center exposes that capacity shortfall rather than claiming uninterrupted coverage.

For the current map and default settings, the route model recommends **five drones**, with a longest nominal loop of about **115 seconds**. A smaller fleet remains usable, but the planner flags the reduced estimated freshness. Fault detection uses a **three-second heartbeat timeout** or **more than 8 m of route-tracking error sustained for three seconds**. Fault injection simulates a frozen/missing-heartbeat aircraft or an actual off-route drift; the health monitor then triggers redistribution.

### Population and observation gaps

The population layer adds **seeded, nonuniform clusters** to the patrol samples. Set **0–50,000 initial/base people**, a reproducible seed, a crowded-cell threshold, and a crowded-area revisit target in Mission parameters. Defaults are **5,000 people**, seed **42**, **80 people per cell**, and **15 seconds**. Randomizing the seed stages a new scenario; **Apply and reset** applies it. The visible mission remains static by default for historical comparisons. The density overlay can be hidden without changing evaluation.

Enable **Vary total & density during patrol** and apply the settings to vary both during a mission. Every configured interval (default **30 simulated seconds**, range 5–600), density blends toward a newly seeded hotspot layout (default **35% redistribution**, range 5–100%). The total is sampled independently within the immutable base count **±25%** by default (adjustable 0–100%), clamped to 1–50,000 people for a nonempty city; a base count of zero stays empty. This is not a compounding random walk: a changed live total never replaces the base. Setting total variation to zero redistributes a fixed total. Updates happen in discrete epochs, not continuous pedestrian movement. The live panel shows the current total, peak cell population, update count and next change.

Population counts sum exactly to the current live total. Each cell's revisit target interpolates from the ordinary area window at zero population to the crowded-area window at the crowded-cell threshold. A denser cell therefore has a shorter deadline, and increasing the city's population can make the service requirements stricter. Crowded deadlines are capped at the area window. These are **frequent-revisit targets**, not a continuous-visibility requirement. Population changes preserve each location's observation timestamp: redistribution neither resets the mission nor gives a location a free fresh observation. Pausing freezes changes; reset replays the same population sequence from the applied base and seed. Fault recovery does not advance the population sequence independently.

The control center reports population metrics separately from geographic coverage:

- **People within target:** percentage of people whose cell was observed within its own revisit deadline. Unseen people never count as fresh.
- **People in view:** percentage currently inside at least one healthy drone's circular sensor footprint; overlapping cameras do not double-count people.
- **Mean observation age:** population-weighted seconds since the last observation. For unseen cells, the evaluation uses mission time plus their revisit deadline as a conservative scoring age, not a known historical observation.
- **Relative gap cost:** `sum(population * (observationAge / revisitTarget)^2) / totalPopulation`. Lower is better, even below the deadline: a 5-second gap scores better than a 10-second gap, not merely the same pass/fail result. The live display is instantaneous; dynamic learning trials use person-time-weighted averages over the scored interval, so busier periods count more. Static trials retain the historical time-weighted averages.

An empty city shows population percentages and costs as **N/A**, not perfect coverage. The existing **95% / 120-second geographic target remains unchanged**. Missions start with the uniform baseline and its **area-only** fleet estimate. Population-aware routing is an explicit experiment in the Routing laboratory, not an automatic replacement. Meeting the geographic target does not imply that the shorter population deadlines are met.

People are abstract counts at the 40 m sample locations, including rooftop locations, not individually positioned or tracked street pedestrians. Optional density changes do not model walking routes, arrival histories, or building occlusion. Observation history belongs to a location: newly added population can inherit that location's previous scan, not an individual person's observation history. Scores are comparable only under the same population sequence, targets and weighting protocol; adjusting a deadline is not a learned improvement.

### Frozen performance baseline

The [patrol baseline report](docs/patrol-baseline.md) records the pre-learning results and evaluation protocols. Frozen raw measurements and source provenance live in `benchmarks/patrol-baseline-v1/`. Across ten 5,000-person scenarios, five drones achieve 100% sampled geographic freshness but only **53.91% mean population on-time coverage**, with **5.074 mean gap cost**. This is the population-priority gap for future planners to improve, not a population-service guarantee.

Run `npm run benchmark:patrol` to reproduce the healthy, fault-recovery, and spatial-fidelity suites. Fresh outputs go to ignored `test-results/`; the frozen baseline is never overwritten by those commands.

### Patrol learning

**New, separate experiment:** [Headless neural PPO patrol learning](docs/patrol-neural-rl.md) learns movement, speed, and charging decisions without geographic ownership or hand-written destination scores. It trains across fleet sizes 1–8 and persistent/moving/surging population scenarios, then compares frozen policies against both existing controllers on held-out environments. Run `npm run train:patrol:rl -- --smoke` for a short three-seed integration check, or see the guide for full battery-cycle training and checkpoint evaluation. This is a local CPU experiment, not a new browser button or an automatically applied policy; smoke results cannot qualify a fleet. The existing Routing laboratory below remains the heuristic-parameter baseline.

To watch a saved neural policy, prepare a completed run with `node scripts/prepare-patrol-preview.mjs --run test-results/<run> --default-seed 101`, then open `/neural.html` on the local Vite development server. This separate experimental preview compares frozen neural policies with both baselines on the NYC sandbox or saved validation scenarios. Model files stay in ignored `.local/`, served by a development-only endpoint, and are not included in the production build. See the guide's **Local visual preview** section.

The **Routing laboratory** below the patrol map searches **total fleet sizes 1–8 immediately**, alongside bounded population urgency, geographic urgency, travel, commitment, and optional cruise-speed parameters. It is a seeded parameter search over a centralized scheduler, not neural reinforcement learning. Healthy aircraft receive coordinated observation-footprint destinations; movement, sensing, altitude lanes, geofence enforcement, and fault detection remain in the simulator. The adaptive planner maintains its own 20 m geographic observation grid so it can see gaps between the population samples; the independent evaluation audit remains separate at 10 m.

1. Apply the desired mission parameters, then choose **Diverse synthetic environments** or **Current mission only**, an optimizer seed, generations, training-environment count, and compute budget. **Start learning** launches isolated accelerated trials in a dedicated worker. It does not advance or change your displayed mission.
2. **Pause learning**, **Resume learning**, or **Cancel learning** independently of patrol. Leaving the panel or losing focus pauses learning. The budget excludes paused time; it limits elapsed active time, not measured CPU seconds.
3. Compare the eight fleet cards, paired uniform controls, and tradeoff frontier. Training, held-out healthy evaluation, and one-drone-loss results are separate. A smaller gap cost alone is not success if area coverage falls short.
4. Explicitly load a held-out-tested candidate into a **new, paused test mission**. Unmet requirements are marked experimental. No policy is silently promoted and no drones appear in a running mission. Returning to the uniform baseline also resets to a paused mission.
5. Results save locally and can be exported/imported. Imported or restored reports are **read-only**, not proof of trustworthy performance; start a new experiment to retest before applying. Saved reports do not resume the optimizer after a reload.

**Current mission only**, with unlimited endurance, retains the short protocol: **120 seconds of warm-up**, two **240-second training scenarios**, two disjoint **360-second held-out scenarios**, and one separate 360-second fault scenario. Population seeds and optimizer seeds are separate. Every strategy at a given fleet size starts at the same uniform staging positions. The independent **10 m geographic audit grid** checks actual healthy aircraft footprints at 0.5-second intervals. It can conservatively miss observations between samples; it does not model occlusion or independently audit population density.

**Diverse synthetic environments** is the default for new experiments. Choose **3–12 training cases** (default six); half as many held-out cases, rounded up, use a corridor family absent from training. Training uses compact circles and rectangular districts. Deterministic cases vary area dimensions, population count/layout, speed limits, camera radius, battery capacity, initial charge, depot location, recharge rate, reserve, and charging pads. Until population dynamics have been explicitly applied in Mission parameters, diverse learning also defaults to changing total and density; the visible mission remains static. **Apply and reset** captures the dynamics toggle for both profiles: disabled keeps each trial static, enabled lets the diverse suite sample change intervals of **15–90 seconds**, **15–80% redistribution**, and **±10–60% total variation**. Select **Current mission only** to use the exact applied dynamics bounds with held-out population seeds. Form edits alone never affect training or a running mission.

All policies and fleet sizes share each scenario's population sequence; the optimizer cannot control the total, density changes or service targets. Dynamic reports include person-time-weighted service metrics, scored population ranges and update counts; the counts exclude warm-up. Each scored battery trial spans three nominal full-speed discharge/recharge cycles, plus warm-up; actual completed charges are reported, not assumed. Per-case results, worst-case gap cost, safety violations, and the fraction of feasible cases prevent pooled means from hiding failures. One separate malfunction trial tests a loss regardless of service state. Additional final-test seeds are reserved but **not evaluated by training**; this finite suite is not a sealed-test certification or proof of arbitrary-environment robustness.

Strict screening requires the configured geographic target at every evaluation sample on both grids, all currently crowded locations within their deadlines, no never-observed population, and zero battery/reserve violations. These are diagnostic checks, **not approved operational tolerances or a safety certificate**. If none passes, the UI says so instead of relaxing targets or claiming a minimum fleet. Failure results include the pre-fault interval and do not establish a resilient fleet recommendation. Quiet-area age limits, permitted startup/recovery intervals, a sealed final-test campaign, individual pedestrian motion, and occlusion remain future work. See the [implementation and learning plan](docs/patrol-learning-plan.md).

Run `npm run benchmark:patrol:learning` for a reproducible local pilot plus a matched five-drone diagnostic over the ten published regression seeds (600-second warm-up / 1,200-second evaluation). It writes `test-results/patrol-learning-results.json`. These development scenarios are not a sealed test set, and short pilot scores are not directly comparable to the frozen long-run aggregate.

Run `npm run benchmark:patrol:generalization` for the multi-environment pilot and per-case scenario manifest. It writes `test-results/patrol-generalization-results.json`, including a versioned checkpoint, without opening the reserved final-test cases. Legacy v1 and v2 browser reports remain readable and read-only with their original evaluator identities; v3 reports use separate browser storage so neither original run is overwritten. Static frozen baselines are unchanged; dynamic scores require new paired evaluations rather than direct comparison with old static scores.

### Speed and battery rotations

Mission parameters now include **Classic**, **Compact**, **District**, and **Corridor** synthetic environments, with configurable maximum speed, battery enablement, full-speed endurance, recharge time, and charging-pad count. Changes are staged until **Apply and reset**. Classic defaults remain 18 m/s and unlimited endurance for historical regression comparisons. Non-classic boundaries and their service depot appear on the overhead map; the NYC buildings are background context, not physical obstacles in Patrol.

Battery-enabled aircraft transition through **patrol → returning → waiting → charging → patrol**. Returning or docked aircraft do not scan; available aircraft redistribute work. The fleet cost includes charging aircraft. Pads have finite capacity with first-arrival ordering; a faulted aircraft occupying a pad blocks it until restored. Restoring a fault does not refill its battery or teleport it.

Energy is an explicitly synthetic model, in full-pack equivalents per second:

```text
consumptionRate = (0.55 + 0.45 * (speed / maximumSpeed)^2) / fullSpeedEnduranceSeconds
```

Hovering consumes energy, and charging restores a full pack over the configured recharge time. A deterministic guard checks energy for the next leg, return to the depot, and reserve before allowing further patrol. The learner cannot alter capacity, charging rate, reserves, or service targets. It can learn a cruise-speed fraction of 0.5–1 in endurance/diverse trials; this is one policy parameter, **not a learned dynamic speed or launch/charging scheduler**. Return guards and charging order remain deterministic.

Depot travel is continuous in the horizontal plane; altitude lanes are retained and vertical docking/takeoff, acceleration, wind, temperature, battery wear, and real aircraft aerodynamics are omitted. Energy totals include warm-up; coverage/gap averages exclude it. Charging endurance is not a real-drone specification or a guarantee that arbitrary user-configured conditions are serviceable. The return guard prevents additional unsafe patrol legs; it cannot guarantee recovery from faults or initial staging with insufficient return energy. Infeasible coverage and energy violations remain visible rather than being hidden by a reward score.

### Planning model and limits

- The default deterministic lawnmower grid is divided into contiguous closed routes and redistributed centrally when fleet availability changes. Its recommendation searches fleet sizes within this route family; it is an **estimated minimum**, not a proof of the globally optimal multi-drone solution. Adaptive routes instead show measured experiment results; periodic loop estimates are not applicable.
- Coverage uses **40 m-spaced planar samples** and a **32 m sensor radius in Classic**, measured against actual simulated drone positions; synthetic environments can vary the sensor radius. It represents an abstract overhead observation footprint, including rooftop locations—not camera resolution, street visibility, people tracking, or line-of-sight coverage between skyscrapers.
- Patrol aircraft are staged airborne at **260–288 m**, above the map's tallest building, with a distinct fixed altitude lane per aircraft. Classic cruise speed is **18 m/s**; synthetic environments can change it and optionally model battery rotations. They do not use the manual flight physics. Physical takeoff/landing, wind, radio links, and avoidance around a falling aircraft are not modeled in Patrol.
- Route-cycle estimates describe steady patrol, not a guaranteed recovery deadline while aircraft travel to newly assigned routes. Use measured rolling coverage to assess actual performance after a fault.
- The browser is the authoritative control center. This is a local planning/failure simulation, not a distributed control server or real-aircraft autopilot; a control-center outage, mission persistence, and redundant communications are outside this model.

## What is simulated

The flight model uses fixed time steps, acceleration, inertia, assisted braking, yaw-relative movement, wind, ground and rooftop landings, building collision in Midtown NYC, and simulated battery drain. City contacts follow the main building tiers, including their setbacks and exposed roof terraces. Trees, street furniture, small rooftop details, and gates are decorative except for gate scoring. This is a practice sandbox, not an engineering-grade aerodynamic simulation or a substitute for drone-specific training.

**No real aircraft connection is included.** A real drone would require a separately designed adapter for its supported SDK or flight controller, plus arming, limits, and failsafe behavior appropriate to that aircraft. The normalized `FlightControls` interface is the separation point for that future work.

## Development

```sh
npm test
npm run build
```

- `src/input.ts`: Gamepad/keyboard handling, mapping, deadzone, response curve, calibration.
- `src/physics.ts`: Browser-independent flight model.
- `src/scene.ts`: Procedural environment, drone, and cameras.
- `src/city.ts`: Procedural NYC-inspired city rendering.
- `src/maps.ts`: Shared map layouts, building tiers, flight bounds, and gate courses.
- `src/course.ts`: Swept gate crossing detection.
- `src/main.ts`: UI, telemetry, session state, and fixed-step loop.
- `src/patrol.ts`: Browser-independent fleet sizing, patrol routing, health monitoring, and rolling coverage.
- `src/population.ts`: Seeded clustered population and bounded temporal density changes, density-based revisit targets, and population-weighted gap metrics.
- `src/patrol-types.ts`: Shared patrol configuration, telemetry, and route contracts.
- `src/patrol-panel.ts`: Patrol controls, fleet status, activity log, and overhead mission map.
- `src/patrol-policy.ts`: Bounded centralized population-aware destination scheduling.
- `src/patrol-evaluator.ts`, `src/patrol-audit.ts`: Deterministic trial metrics and independent dense geographic audit.
- `src/patrol-search.ts`, `src/patrol-training.worker.ts`: Joint fleet/parameter search and interruptible background execution.
- `src/patrol-learning-panel.ts`, `src/patrol-learning-checkpoint.ts`: Experiment controls and validated, versioned result persistence.
- `src/patrol-environment.ts`, `src/patrol-scenarios.ts`: Validated synthetic hardware/boundaries and deterministic train/held-out/failure scenario families.

Unit tests cover physics, landing speeds and surfaces, input edge cases, gate crossing, patrol fault recovery, and population generation and scoring. Browser tests live in `e2e/` and run with `npm run test:e2e`; they launch installed Google Chrome by default. A test-only fixture isolates physical gamepads so a connected controller cannot steer automated keyboard flights; the controller test supplies a simulated device. To use Playwright's Chromium instead, install it with `npx playwright install chromium`, then run with `PLAYWRIGHT_CHROMIUM=1 npm run test:e2e`.

## Deployment and CI

Live site: [astro-drone-controller.vercel.app](https://astro-drone-controller.vercel.app/).

`.github/workflows/ci.yml` runs unit tests, a production build, and Chromium browser tests for pull requests targeting `main` and every push to `main`. After those checks pass on `main`, it deploys the exact built assets to the existing Vercel project. Merging a pull request triggers a push to `main`; direct pushes also deploy. The workflow can also be run manually from GitHub Actions on `main`. Other branches and pull requests never receive the deployment token or deploy to production.

### One-time setup

In this repository's **Settings → Secrets and variables → Actions**, configure:

| Type | Name | Value |
| --- | --- | --- |
| Repository variable | `VERCEL_ORG_ID` | The ID of the existing `seung-2564's projects` Vercel team. |
| Repository variable | `VERCEL_PROJECT_ID` | The ID of the existing `astro-drone-controller` Vercel project. |
| Repository secret | `VERCEL_TOKEN` | A dedicated Vercel access token authorized to deploy to that project. |

Get the IDs from the existing Vercel team/project settings, or from `.vercel/project.json` after linking locally to that existing project. Do not create a second project. Prefer a project-scoped token and set an expiration; rotate the GitHub secret before it expires. Never commit the token or paste it into an issue, pull request, or workflow file. Missing configuration fails the deployment job with a setup error rather than silently skipping publication.

The deployment job has no source checkout and only uploads the tested `dist` artifact, packaged with [Vercel's static Build Output API](https://vercel.com/docs/build-output-api). It does not change the existing Vercel/GitHub login connections or require Vercel's native Git integration. No environment variables, backend services, or paid add-ons are needed by the app. Keep native Git auto-deployment disabled for this project to avoid bypassing the test gate or deploying twice.

Production workflows are serialized so an in-progress deployment is not canceled by another merge. GitHub may replace an older pending run with a newer one. Before publishing, the workflow verifies that its commit is still the latest `main` commit; rerunning an outdated workflow cannot roll production back. Pull-request checks can be canceled when superseded. To require checks before merging, configure a `main` branch rule requiring **Test and build**; the workflow itself does not change branch protection.

For a failed deployment, open **Actions → CI and production deployment**, fix the reported test/configuration error, then rerun the workflow on `main`. CI allows longer flight waits for software-rendered WebGL without changing simulation behavior or assertions. Browser failure screenshots and first-retry traces are kept for seven days. The browser suite has a ten-minute deadline so failures can upload diagnostics before the job times out. The last successful Vercel production deployment remains available if checks or publication fail.
