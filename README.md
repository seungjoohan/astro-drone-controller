# Astro Flight Lab

A browser-based 3D drone simulator for practicing with an Astro C40 TR or a keyboard. Built with TypeScript, Three.js, and Vite. Everything runs locally; no account, drone, or backend is required.

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

Unit tests cover physics, landing speeds and surfaces, input edge cases, and gate crossing. Browser tests live in `e2e/` and run with `npm run test:e2e`; they launch installed Google Chrome by default. A test-only fixture isolates physical gamepads so a connected controller cannot steer automated keyboard flights; the controller test supplies a simulated device. To use Playwright’s Chromium instead, install it with `npx playwright install chromium`, then run with `PLAYWRIGHT_CHROMIUM=1 npm run test:e2e`.
