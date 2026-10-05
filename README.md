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

The population layer adds **stationary, nonuniform clusters** to the patrol samples. Set **0–50,000 people**, a reproducible seed, a crowded-cell threshold, and a crowded-area revisit target in Mission parameters. Defaults are **5,000 people**, seed **42**, **80 people per cell**, and **15 seconds**. Randomizing the seed stages a new scenario; **Apply and reset** applies it. Resetting the mission reuses the applied population, and fault replanning does not move people or erase observation history. The density overlay can be hidden without changing evaluation.

Population counts sum exactly to the configured total. Each cell's revisit target interpolates from the ordinary area window at zero population to the crowded-area window at the crowded-cell threshold. A denser cell therefore has a shorter deadline, and increasing the city's population can make the service requirements stricter. Crowded deadlines are capped at the area window. These are **frequent-revisit targets**, not a continuous-visibility requirement.

The control center reports population metrics separately from geographic coverage:

- **People within target:** percentage of people whose cell was observed within its own revisit deadline. Unseen people never count as fresh.
- **People in view:** percentage currently inside at least one healthy drone's circular sensor footprint; overlapping cameras do not double-count people.
- **Mean observation age:** population-weighted seconds since the last observation. For unseen cells, the evaluation uses mission time plus their revisit deadline as a conservative scoring age, not a known historical observation.
- **Relative gap cost:** `sum(population * (observationAge / revisitTarget)^2) / totalPopulation`. Lower is better, even below the deadline: a 5-second gap scores better than a 10-second gap, not merely the same pass/fail result. This is an instantaneous evaluation metric, not a trained reward or a mission-average score. A future learner should evaluate it over time alongside coverage and fleet cost rather than optimize one favorable instant.

An empty city shows population percentages and costs as **N/A**, not perfect coverage. The existing **95% / 120-second geographic target remains unchanged**. Routes are still the uniform baseline, and fleet recommendations are **area-only**: neither population-aware routing nor a learning system is enabled yet. Meeting the geographic target does not imply that the shorter population deadlines are met. This layer defines measurable constraints and continuous gap costs for that next step.

People are abstract counts at the 40 m sample locations, including rooftop locations, not individually positioned street pedestrians. Population does not move, and buildings do not occlude observations. Scores are comparable only under the same population scenario and target settings; adjusting a deadline is not a learned improvement.

### Frozen performance baseline

The [patrol baseline report](docs/patrol-baseline.md) records the pre-learning results and evaluation protocols. Frozen raw measurements and source provenance live in `benchmarks/patrol-baseline-v1/`. Across ten 5,000-person scenarios, five drones achieve 100% sampled geographic freshness but only **53.91% mean population on-time coverage**, with **5.074 mean gap cost**. This is the population-priority gap for future planners to improve, not a population-service guarantee.

Run `npm run benchmark:patrol` to reproduce the healthy, fault-recovery, and spatial-fidelity suites. Fresh outputs go to ignored `test-results/`; the frozen baseline is never overwritten by those commands. No learning is enabled yet.

### Planning model and limits

- A deterministic lawnmower grid is divided into contiguous closed routes and redistributed centrally when fleet availability changes. The recommendation searches fleet sizes within this route family; it is an **estimated minimum**, not a proof of the globally optimal multi-drone solution.
- Coverage uses **40 m-spaced planar samples** and a **32 m sensor radius**, measured against actual simulated drone positions. It represents an abstract overhead observation footprint, including rooftop locations—not camera resolution, street visibility, people tracking, or line-of-sight coverage between skyscrapers.
- Patrol aircraft are staged airborne at **260–288 m**, above the map's tallest building, with a distinct fixed altitude lane per aircraft and **18 m/s** cruise speed. They do not use the manual flight physics. Takeoff, landing, endurance, wind, radio links, and physical avoidance around a falling aircraft are not modeled in Patrol.
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
- `src/population.ts`: Seeded clustered population, density-based revisit targets, and population-weighted gap metrics.
- `src/patrol-types.ts`: Shared patrol configuration, telemetry, and route contracts.
- `src/patrol-panel.ts`: Patrol controls, fleet status, activity log, and overhead mission map.

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
