import './style.css';
import { createIcons, ArrowUpRight, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Battery, Camera, Check, ChevronDown, CircleHelp, Compass, Crosshair, Gamepad2, Gauge, Keyboard, MapPin, Maximize2, Mountain, Pause, Play, Radio, RotateCcw, Settings2, ShieldCheck, SlidersHorizontal, Target, Wind, X } from 'lucide';
import { ControllerInput } from './input';
import { DronePhysics, SAFE_LANDING_HORIZONTAL_SPEED, SAFE_LANDING_VERTICAL_SPEED } from './physics';
import { FlightScene } from './scene';
import { GROUND_HEIGHT } from './world';
import { FLIGHT_MAPS } from './maps';
import type { FlightMap, MapId } from './maps';
import { passesGate } from './course';
import { PatrolPanel } from './patrol-panel';
import type { CameraMode, FlightControls, Vec3 } from './types';

const iconSet = { ArrowUpRight, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Battery, Camera, Check, ChevronDown, CircleHelp, Compass, Crosshair, Gamepad2, Gauge, Keyboard, MapPin, Maximize2, Mountain, Pause, Play, Radio, RotateCcw, Settings2, ShieldCheck, SlidersHorizontal, Target, Wind, X };
const icon = (name: string, extra = '') => `<i data-lucide="${name}" ${extra}></i>`;
const refreshIcons = () => createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.7 } });
const app = document.querySelector<HTMLDivElement>('#app')!;
let currentMap: FlightMap = FLIGHT_MAPS['pine-valley'];
try {
  const savedMap = localStorage.getItem('astro-flight-map');
  if (savedMap === 'nyc') currentMap = FLIGHT_MAPS.nyc;
} catch {}

app.innerHTML = `
  <header class="site-header">
    <a class="brand" href="/" aria-label="Astro Flight Lab home"><svg viewBox="0 0 36 36" aria-hidden="true"><path d="m4 29 14-24 14 24H22l-4-7-4 7Z" fill="currentColor"/><circle cx="18" cy="13" r="2.5" fill="#f8faf5"/></svg><span>astro<span class="brand-divider"></span><span class="brand-sub">flight lab</span></span></a>
    <nav aria-label="Main navigation"><button class="nav-link active" id="sim-nav" aria-pressed="true">Simulator</button><button class="nav-link" id="patrol-nav" aria-label="Patrol control center" aria-pressed="false">Patrol</button><button class="nav-link" data-open="controller">Controller setup</button><button class="nav-link" data-open="guide">Flight guide ${icon('arrow-up-right')}</button></nav>
    <span class="simulation-badge"><span class="status-dot"></span> SIMULATION ONLY</span>
  </header>
  <main class="workspace">
    <section class="page-heading">
      <div><div class="eyebrow">YOUR CONTROLLER. NEW POSSIBILITIES.</div><h1>Meet your new altitude<span>.</span></h1><p>A space to get comfortable, find your flow, and learn to fly.</p></div>
      <button class="connection-button" data-open="controller">${icon('gamepad-2')}<span><strong id="connection-title">Connect your C40</strong><small id="connection-subtitle">Keyboard controls are ready</small></span>${icon('arrow-up-right')}</button>
    </section>
    <div class="flight-layout">
      <section class="flight-main" aria-label="Flight simulator">
        <div class="view-toolbar"><div class="segmented" aria-label="Activity"><button id="free-flight" class="selected" aria-pressed="true">${icon('compass')} Free flight</button><button id="gate-course" aria-pressed="false">${icon('target')} Gate course</button></div><div class="toolbar-right"><div class="map-selector">${icon('map-pin')}<select id="map-select" aria-label="Flight map"><option value="pine-valley">Pine Valley</option><option value="nyc">Midtown NYC</option></select>${icon('chevron-down')}</div><span class="live-label"><span class="status-dot"></span> LIVE SIMULATION</span><button id="fullscreen" class="icon-button" aria-label="Toggle simulator fullscreen" title="Fullscreen">${icon('maximize-2')}</button></div></div>
        <div class="viewport" id="viewport">
          <div class="scene" id="scene" aria-label="Interactive 3D drone training range"></div>
          <div class="scene-vignette"></div>
          <div class="location-label"><div class="location-icon">${icon('map-pin')}</div><div><strong id="location-name">${currentMap.name}</strong><span id="location-description">${currentMap.subtitle}</span></div></div>
          <div class="scene-weather">${icon('wind')}<span id="wind-label">Calm conditions</span></div>
          <div class="heading-tape" aria-hidden="true"><span>NW</span><span>│</span><span>N</span><span>│</span><span>NE</span><i></i></div>
          <div class="flight-state" id="flight-state"><span class="status-dot"></span><span id="flight-state-label">READY FOR TAKEOFF</span></div>
          <div class="reticle" aria-hidden="true"><span></span></div>
          <div class="altitude-ladder" aria-hidden="true"><span>30</span><i></i><span>20</span><i></i><strong id="altitude-hud">0.0 <small>M</small></strong><i></i><span>10</span><i></i><span>0</span></div>
          <div class="launch-hint" id="launch-hint"><span class="hint-symbol">${icon('arrow-up')}</span><div><strong>You’re clear for takeoff.</strong><span>Start your motors, then push the left stick up or hold <kbd>W</kbd>.</span></div></div>
          <div class="landing-feedback" id="landing-feedback" role="status" hidden><span class="contact-icon" id="contact-icon"></span><div><strong id="contact-title"></strong><span id="contact-detail"></span><small id="contact-hint"></small></div></div>
          <div class="pause-overlay" id="pause-overlay" hidden><div class="pause-symbol">${icon('pause')}</div><h2 id="pause-title">Take a breath.</h2><p id="pause-reason">Your flight is paused.</p><button id="resume-button" class="primary-button">${icon('play')} Resume flight</button></div>
          <div class="scene-bottom"><span class="camera-label">${icon('camera')}<span id="camera-label">CHASE CAMERA</span><kbd>C</kbd></span><div class="scene-actions"><button id="pause-button" aria-label="Pause flight" title="Pause · P">${icon('pause')}</button><button id="reset-button" aria-label="Reset flight" title="Reset · R">${icon('rotate-ccw')}</button></div></div>
          <div class="minimap"><canvas id="minimap" width="220" height="180" aria-label="Top-down position map"></canvas><span><span class="map-dot"></span><span id="minimap-label">TRAINING AREA</span></span></div>
        </div>
        <div class="telemetry" aria-label="Live flight telemetry"><div class="metric"><span>${icon('arrow-up')} ALTITUDE</span><strong id="altitude">0.0 <small>m</small></strong><div class="metric-note">Above ground</div></div><div class="metric"><span>${icon('gauge')} GROUND SPEED</span><strong id="speed">0.0 <small>m/s</small></strong><div class="metric-note" id="speed-note">Standing by</div></div><div class="metric"><span>${icon('compass')} HEADING</span><strong id="heading">000<small>° N</small></strong><div class="metric-note">Direction of travel</div></div><div class="metric"><span>${icon('battery')} BATTERY</span><strong id="battery">100<small>%</small></strong><div class="battery-track"><div id="battery-fill"></div></div></div></div>
        <div class="keyboard-bar"><span>${icon('keyboard')} THE BASICS</span><div><kbd>W</kbd><kbd>S</kbd><span>Altitude</span></div><div><kbd>A</kbd><kbd>D</kbd><span>Rotate</span></div><div><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd><span>Move</span></div><button data-open="guide">All controls ${icon('arrow-up-right')}</button></div>
      </section>
      <aside class="sidebar">
        <section class="panel flight-panel"><div class="panel-title"><h2>Flight controls</h2>${icon('sliders-horizontal')}</div><label class="field-label" for="flight-mode">FLIGHT MODE</label><div class="select-wrap"><span class="select-icon">${icon('shield-check')}</span><select id="flight-mode"><option value="assisted">Assisted</option><option value="sport">Sport</option></select>${icon('chevron-down')}</div><p class="field-help" id="mode-description">Auto-leveling and altitude hold.<br>A little help as you find your wings.</p><div class="field-row"><label for="wind-toggle">${icon('wind')} Gentle wind</label><button id="wind-toggle" class="switch" role="switch" aria-checked="false" aria-label="Gentle wind"><span></span></button></div><div class="field-divider"></div><label class="field-label" for="camera-mode">YOUR PERSPECTIVE</label><div class="select-wrap"><span class="select-icon">${icon('camera')}</span><select id="camera-mode"><option value="chase">Chase camera</option><option value="fpv">First-person view</option><option value="orbit">Observer camera</option></select>${icon('chevron-down')}</div><button id="arm-button" class="primary-button arm-button">${icon('play')}<span>Start motors</span><kbd>SPACE</kbd></button><span class="arm-note" id="arm-note">Take your time. You’re in a simulator.</span></section>
        <section class="panel input-panel"><div class="panel-title"><h2>Live inputs</h2><span class="input-source" id="input-source">KEYBOARD</span></div><div class="sticks"><div class="stick-block"><div class="stick-well"><div class="stick-axis horizontal"></div><div class="stick-axis vertical"></div><div class="stick-dot" id="left-stick"></div><span class="stick-mark top">↑</span><span class="stick-mark bottom">↓</span></div><strong>LEFT STICK</strong><span>Altitude · Yaw</span></div><div class="stick-block"><div class="stick-well"><div class="stick-axis horizontal"></div><div class="stick-axis vertical"></div><div class="stick-dot" id="right-stick"></div><span class="stick-mark top">↑</span><span class="stick-mark bottom">↓</span></div><strong>RIGHT STICK</strong><span>Pitch · Roll</span></div></div><button class="text-button mapping-button" data-open="controller">${icon('settings-2')} Controller settings ${icon('arrow-up-right')}</button></section>
        <section class="session-panel"><div class="panel-title"><h2 id="session-title">A little more sky.</h2>${icon('crosshair')}</div><p id="session-description">No checkpoints. No pressure.<br>Just you, your drone, and room to explore.</p><div class="session-details"><div><span id="session-left-label">FLIGHT TIME</span><strong id="flight-time">00:00</strong></div><div><span id="session-right-label">DISTANCE</span><strong id="distance">0 <small>m</small></strong></div></div><div class="course-progress" id="course-progress" hidden><div></div></div></section>
      </aside>
    </div>
    <section id="patrol-center" aria-label="Autonomous patrol control center" hidden></section>
    <footer><span><span class="footer-dot"></span>Built for practice. Ready for possibility.</span><span>ASTRO C40 COMPATIBLE INPUT <span class="footer-slash">/</span> FLIGHT LAB v0.1</span></footer>
  </main>
  <dialog id="controller-dialog" class="settings-dialog"><div class="dialog-header"><div><span class="eyebrow">MAKE IT FEEL LIKE YOURS</span><h2>Controller setup</h2></div><button class="icon-button close-dialog" aria-label="Close controller settings">${icon('x')}</button></div><div class="dialog-body"><div class="setup-tip">${icon('gamepad-2')}<div><strong>Plug in. Press a button. Take flight.</strong><p>Set your C40 to <b>Wired</b> and connect it with a USB data cable. Click this page, then press a controller button to make it visible to the browser.</p></div></div><div class="device-status"><span class="status-dot" id="device-dot"></span><div><strong id="device-name">Waiting for a controller</strong><small id="device-detail">You can fly with your keyboard in the meantime.</small></div></div><p class="compatibility-note">The simulator reads controllers exposed by your browser. C40 recognition depends on your OS and drivers; macOS detection is not guaranteed. Use localhost or HTTPS. The C40 wireless option uses its USB transmitter.</p><div class="settings-section"><div class="section-heading"><h3>Stick response</h3><button class="small-button" id="calibrate">Center sticks</button></div><p class="field-help">Release both sticks before centering. Move them afterward to check the live inputs.</p><div class="range-row"><label for="deadzone">Deadzone <output id="deadzone-value"></output></label><input id="deadzone" type="range" min="0" max="0.4" step="0.01" /></div><div class="range-row"><label for="expo">Response curve <output id="expo-value"></output></label><input id="expo" type="range" min="0" max="1" step="0.05" /></div><div class="range-row"><label for="sensitivity">Sensitivity <output id="sensitivity-value"></output></label><input id="sensitivity" type="range" min="0.2" max="2" step="0.1" /></div></div><div class="settings-section"><h3>Axis mapping</h3><p class="field-help">Standard layout is ready to use. Adjust these if a stick moves the wrong control.</p><div id="axis-mappings" class="axis-mappings"></div><div id="raw-axes" class="raw-axes">Raw axes appear when a controller connects.</div></div><details class="button-details"><summary>Button mapping <span>Advanced</span></summary><div id="button-mappings" class="button-mappings"></div><div id="raw-buttons" class="raw-axes">Pressed button numbers appear here.</div></details><div class="dialog-footer"><button id="restore-settings" class="text-button">${icon('rotate-ccw')} Restore defaults</button><span>Settings save automatically</span></div></div></dialog>
  <dialog id="guide-dialog" class="guide-dialog"><div class="dialog-header"><div><span class="eyebrow">LET’S GET YOU AIRBORNE</span><h2>Your first flight</h2></div><button class="icon-button close-dialog" aria-label="Close flight guide">${icon('x')}</button></div><div class="dialog-body"><ol class="flight-steps"><li><span>01</span><div><h3>Start with assisted mode</h3><p>It keeps the drone level and holds altitude when you release the sticks. Press <kbd>Space</kbd> or the controller’s bottom face button to start your motors.</p></div></li><li><span>02</span><div><h3>Give yourself some room</h3><p>Push your left stick up, or hold <kbd>W</kbd>, to climb. Aim for 6 meters, then release. Down on the left stick or <kbd>S</kbd> descends.</p></div></li><li><span>03</span><div><h3>Find your direction</h3><p>Your left stick turns the drone. Your right stick moves it forward, backward, and sideways relative to its heading. On keyboard, use <kbd>A</kbd> / <kbd>D</kbd> to turn and the arrow keys to move.</p></div></li><li><span>04</span><div><h3>Make a little progress</h3><p>Choose Gate course and fly through the highlighted rings in order. Or stay in Free flight and explore. Return to the pad and descend gently to land.</p></div></li></ol><div class="guide-shortcuts"><div><kbd>C</kbd><span>Change camera</span></div><div><kbd>P</kbd> / <kbd>Esc</kbd><span>Pause</span></div><div><kbd>R</kbd><span>Reset flight</span></div><div><kbd>Space</kbd><span>Toggle motors</span></div></div><p class="guide-note">Both flight modes use centered-stick altitude hold. Sport increases speed and inertia; this is an approachable simulator, not an acrobatic or engineering-grade flight model. Trees and scenery are decorative. The ground is collidable, and the training area and altitude have limits.</p><p class="guide-note">Flight pauses when this window loses focus or a controller disconnects. No real drone connection is included.</p><button id="guide-done" class="primary-button">Got it. Let’s fly ${icon('arrow-up-right')}</button></div></dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`;

function element<ElementType extends HTMLElement = HTMLElement>(id: string): ElementType {
  return document.getElementById(id) as ElementType;
}

const physics = new DronePhysics();
physics.setMap(currentMap);
const input = new ControllerInput();
const patrolPanel = new PatrolPanel(element('patrol-center'));
let patrolVisible = false;
let scene: FlightScene | null = null;
let renderingError = false;
try {
  scene = new FlightScene(element('scene'), currentMap);
} catch (error) {
  renderingError = true;
  element('scene').innerHTML = '<div class="webgl-error"><h2>We need a little graphics power.</h2><p>Enable hardware acceleration and reopen this page in a browser with WebGL 2 support.</p></div>';
  console.error('Could not initialize the simulator', error);
  element<HTMLButtonElement>('arm-button').disabled = true;
}

let cameraMode: CameraMode = 'chase';
let paused = false;
let course = false;
let activeGate = 0;
let laps = 0;
let previousTime = performance.now();
let accumulator = 0;
let uiElapsed = 0;
let toastTimeout = 0;
let lastDevice = '';
let lastArmed = false;
let lastCrashed = false;
let lastSurface = physics.state.surface;
let lastLandingCount = 0;
let windowActive = document.hasFocus();
let previousPosition: Vec3 = { ...physics.state.position };
const fixedStep = 1 / 120;
const mapContext = element<HTMLCanvasElement>('minimap').getContext('2d');

function toast(message: string) {
  element('toast').textContent = message;
  element('toast').classList.add('visible');
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => element('toast').classList.remove('visible'), 3600);
}

function setPaused(value: boolean, reason = 'Your flight is paused.') {
  paused = value;
  input.clear();
  accumulator = 0;
  element('pause-overlay').hidden = !value;
  element('pause-reason').textContent = reason;
  element('pause-button').setAttribute('aria-label', value ? 'Resume flight' : 'Pause flight');
  element('pause-button').innerHTML = icon(value ? 'play' : 'pause');
  updateFlightStatus();
  updateTelemetry({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  refreshIcons();
}

function updateFlightStatus() {
  const state = physics.state;
  const landed = !state.crashed && state.surface !== null && state.landingCount > 0;
  const crashLabel = physics.crashReason === 'building' ? 'Building collision' : physics.crashReason === 'rooftop' ? 'Hard rooftop landing' : 'Hard landing';
  const status = renderingError ? 'GRAPHICS UNAVAILABLE'
    : state.crashed ? `${crashLabel.toUpperCase()} · RESET TO RETRY`
    : paused ? 'FLIGHT PAUSED'
    : landed ? `SOFT LANDING · ${state.surface!.toUpperCase()}`
    : state.surface === null ? state.armed ? `IN FLIGHT · ${physics.mode.toUpperCase()}` : 'MOTORS OFF · DESCENDING'
    : state.armed ? 'MOTORS ON · READY TO FLY'
    : state.battery <= 0 ? 'BATTERY EMPTY · RESET TO RECHARGE' : 'READY FOR TAKEOFF';
  element('flight-state-label').textContent = status;
  element('flight-state').classList.toggle('is-armed', state.armed);
  element('flight-state').classList.toggle('is-crashed', state.crashed);
  element('flight-state').classList.toggle('is-landed', landed);
  element('launch-hint').hidden = state.armed || state.crashed || landed || paused || renderingError || state.time > 1;
  element('arm-button').innerHTML = `${icon(state.crashed ? 'rotate-ccw' : state.armed ? 'pause' : 'play')}<span>${state.crashed ? 'Reset flight' : state.armed ? 'Stop motors' : 'Start motors'}</span><kbd>${state.crashed ? 'R' : 'SPACE'}</kbd>`;
  element('arm-button').classList.toggle('armed', state.armed);
  element('arm-note').textContent = state.crashed ? 'A fresh start is one click away.' : landed ? state.armed ? 'Safely landed. Push up to fly again.' : 'Safely landed. Start motors to fly again.' : state.armed ? 'Land gently before stopping your motors.' : 'Take your time. You’re in a simulator.';
  element('landing-feedback').hidden = (!state.crashed && !landed) || paused || renderingError;
  element('landing-feedback').classList.toggle('contact-crash', state.crashed);
  element('contact-icon').innerHTML = icon(state.crashed ? 'x' : 'shield-check');
  element('contact-title').textContent = state.crashed ? crashLabel : state.surface === 'rooftop' ? 'Soft rooftop landing' : 'Soft landing';
  element('contact-detail').textContent = state.crashed
    ? physics.crashReason === 'building' ? 'Wall, edge, or underside impact.' : 'Touchdown was too fast to land safely.'
    : physics.lastLanding ? `${physics.lastLanding.verticalSpeed.toFixed(1)} m/s down · ${physics.lastLanding.horizontalSpeed.toFixed(1)} m/s sideways` : '';
  element('contact-hint').textContent = state.crashed ? 'Press R to reset your flight.' : state.armed ? 'Push the left stick up or hold W to take off.' : 'Start your motors to take off again.';
  refreshIcons();
}

function resetFlight() {
  physics.reset();
  input.clear();
  activeGate = 0;
  laps = 0;
  lastLandingCount = 0;
  lastSurface = physics.state.surface;
  lastArmed = false;
  lastCrashed = false;
  previousPosition = { ...physics.state.position };
  scene?.resetCamera();
  setPaused(false);
  updateFlightStatus();
  toast('Back at the landing pad. Ready when you are.');
}

function toggleArm() {
  if (renderingError) return;
  if (physics.state.crashed) return resetFlight();
  if (paused) setPaused(false);
  if (physics.state.armed) {
    physics.disarm();
    toast('Motors stopped.');
  } else {
    physics.arm();
    if (physics.state.armed) toast('Motors on. Left stick up or hold W to climb.');
    else toast('Battery empty. Reset your flight to recharge.');
  }
  updateFlightStatus();
}

function changeCamera(next?: CameraMode) {
  const modes: CameraMode[] = ['chase', 'fpv', 'orbit'];
  cameraMode = next ?? modes[(modes.indexOf(cameraMode) + 1) % modes.length];
  element<HTMLSelectElement>('camera-mode').value = cameraMode;
  element('camera-label').textContent = { chase: 'CHASE CAMERA', fpv: 'FIRST-PERSON VIEW', orbit: 'OBSERVER CAMERA' }[cameraMode];
  scene?.resetCamera();
}

function updateMapLabels() {
  element<HTMLSelectElement>('map-select').value = currentMap.id;
  element('location-name').textContent = currentMap.name;
  element('location-description').textContent = currentMap.subtitle;
  element('minimap-label').textContent = currentMap.id === 'nyc' ? 'CITY GRID' : 'TRAINING AREA';
  element('minimap').setAttribute('aria-label', `${currentMap.name} position map`);
  element('scene').setAttribute('aria-label', `Interactive 3D ${currentMap.name} flight map`);
  element('viewport').classList.toggle('city-map', currentMap.id === 'nyc');
  const ascentGuide = document.querySelector<HTMLElement>('.flight-steps li:nth-child(2) p')!;
  ascentGuide.innerHTML = `Push your left stick up, or hold <kbd>W</kbd>, to climb. Aim for ${currentMap.id === 'nyc' ? '10' : '6'} meters for the first gate, then release. Down on the left stick or <kbd>S</kbd> descends.`;
  const simulationGuide = document.querySelector<HTMLElement>('.guide-note')!;
  simulationGuide.textContent = `Both modes use centered-stick altitude hold. For a soft landing, descend at no more than ${SAFE_LANDING_VERTICAL_SPEED} m/s with sideways speed no more than ${SAFE_LANDING_HORIZONTAL_SPEED} m/s. In Assisted mode, release the movement stick, let the drone stop, then descend. ${currentMap.id === 'nyc' ? 'Midtown NYC is an imagined city inspired by New York. Land from above on a flat roof with the entire drone clear of the edges. Walls, edges, undersides, and fast touchdowns cause a crash. Small rooftop details are decorative.' : 'Trees and scenery are decorative; fast ground touchdowns cause a crash.'} You can stop the motors while landed and take off again. This map has a ${currentMap.radius} m flight radius and ${currentMap.maxAltitude} m altitude ceiling. Changing maps resets the flight.`;
  updateSessionDescription();
}

function changeMap(mapId: MapId) {
  if (mapId === currentMap.id || !Object.hasOwn(FLIGHT_MAPS, mapId)) return;
  input.clear();
  scene?.dispose();
  scene = null;
  element('scene').replaceChildren();
  currentMap = FLIGHT_MAPS[mapId];
  physics.setMap(currentMap);
  renderingError = false;
  try {
    scene = new FlightScene(element('scene'), currentMap);
  } catch (error) {
    renderingError = true;
    element('scene').innerHTML = '<div class="webgl-error"><h2>This map couldn’t load.</h2><p>Try switching maps or reload with hardware acceleration enabled.</p></div>';
    console.error('Could not load flight map', error);
  }
  element<HTMLButtonElement>('arm-button').disabled = renderingError;
  resetFlight();
  updateMapLabels();
  try { localStorage.setItem('astro-flight-map', currentMap.id); } catch {}
  toast(renderingError ? 'Map graphics unavailable. Try switching maps or reload.' : `${currentMap.name} ready. Flight reset at the landing pad.`);
}

function updateSessionDescription() {
  const isCity = currentMap.id === 'nyc';
  element('session-title').textContent = course ? isCity ? 'Thread the skyline.' : 'Find your line.' : isCity ? 'A different kind of sky.' : 'A little more sky.';
  element('session-description').innerHTML = course
    ? isCity ? 'Climb to 10 m for gate 1. Follow the avenues between gates. Buildings are solid.' : 'Climb to 6 m and fly through the highlighted gate. Six gates. Your own pace.'
    : isCity ? 'Explore a 238 m skyline. Land gently on flat roofs; keep clear of walls and edges.' : 'No checkpoints. No pressure.<br>Just you, your drone, and room to explore.';
}

function setCourse(enabled: boolean) {
  course = enabled;
  activeGate = 0;
  laps = 0;
  previousPosition = { ...physics.state.position };
  for (const [id, selected] of [['free-flight', !enabled], ['gate-course', enabled]] as const) {
    element(id).classList.toggle('selected', selected);
    element(id).setAttribute('aria-pressed', String(selected));
  }
  updateSessionDescription();
  element('session-right-label').textContent = enabled ? 'GATES CLEARED' : 'DISTANCE';
  element('course-progress').hidden = !enabled;
  if (enabled) toast('Gate course ready. Start with the highlighted ring straight ahead.');
}

function showDialog(name: string) {
  if (patrolVisible && name === 'controller') setPatrolView(false);
  if (patrolVisible) patrolPanel.pause('Patrol paused while a dialog is open.');
  if ((physics.state.armed || physics.state.surface === null) && !physics.state.crashed && !paused) setPaused(true, 'Resume when you’re ready to fly again.');
  input.clear();
  element<HTMLDialogElement>(`${name}-dialog`).showModal();
}

function setPatrolView(active: boolean) {
  input.setEnabled(!active);
  if (active && (physics.state.armed || physics.state.surface === null) && !paused) setPaused(true, 'Manual flight is paused while the patrol control center is open.');
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
  patrolVisible = active;
  document.querySelector<HTMLElement>('.workspace > .page-heading')!.hidden = active;
  document.querySelector<HTMLElement>('.flight-layout')!.hidden = active;
  element('patrol-center').hidden = !active;
  element('patrol-nav').classList.toggle('active', active);
  element('patrol-nav').setAttribute('aria-pressed', String(active));
  element('sim-nav').classList.toggle('active', !active);
  element('sim-nav').setAttribute('aria-pressed', String(!active));
  patrolPanel.setActive(active);
  previousTime = performance.now();
  accumulator = 0;
}

document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => showDialog(button.dataset.open!)));
document.querySelectorAll<HTMLButtonElement>('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog')?.close()));
document.querySelectorAll<HTMLDialogElement>('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => input.clear());
});
element('sim-nav').addEventListener('click', () => { setPatrolView(false); element('viewport').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
element('patrol-nav').addEventListener('click', () => setPatrolView(true));
element('guide-done').addEventListener('click', () => element<HTMLDialogElement>('guide-dialog').close());
element('arm-button').addEventListener('click', toggleArm);
element('reset-button').addEventListener('click', resetFlight);
element('pause-button').addEventListener('click', () => setPaused(!paused));
element('resume-button').addEventListener('click', () => setPaused(false));
element('free-flight').addEventListener('click', () => setCourse(false));
element('gate-course').addEventListener('click', () => setCourse(true));
element('map-select').addEventListener('change', event => changeMap((event.target as HTMLSelectElement).value as MapId));
element('camera-mode').addEventListener('change', event => changeCamera((event.target as HTMLSelectElement).value as CameraMode));
element('flight-mode').addEventListener('change', event => {
  physics.mode = (event.target as HTMLSelectElement).value === 'sport' ? 'sport' : 'assisted';
  element('mode-description').innerHTML = physics.mode === 'sport' ? 'More speed, more momentum.<br>Altitude hold stays on. Land gently.' : 'Auto-leveling and altitude hold.<br>A little help as you find your wings.';
});
element('wind-toggle').addEventListener('click', () => {
  physics.wind = !physics.wind;
  element('wind-toggle').setAttribute('aria-checked', String(physics.wind));
  element('wind-label').textContent = physics.wind ? 'Gentle crosswind' : 'Calm conditions';
});
element('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await element('viewport').requestFullscreen();
  } catch { toast('Fullscreen isn’t available in this browser.'); }
});
window.addEventListener('focus', () => { windowActive = true; });
window.addEventListener('blur', () => {
  windowActive = false;
  if (patrolVisible) patrolPanel.pause('The window lost focus. Resume patrol when ready.');
  if ((physics.state.armed || physics.state.surface === null) && !physics.state.crashed && !paused) setPaused(true, 'The window lost focus. Your drone is waiting here.');
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (patrolVisible) patrolPanel.pause('The tab is hidden. Resume patrol when ready.');
  if ((physics.state.armed || physics.state.surface === null) && !physics.state.crashed && !paused) setPaused(true, 'You switched tabs. Resume whenever you’re ready.');
});

function renderSettings() {
  for (const key of ['deadzone', 'expo', 'sensitivity'] as const) {
    element<HTMLInputElement>(key).value = String(input.config[key]);
    element(`${key}-value`).textContent = key === 'sensitivity' ? `${input.config[key].toFixed(1)}×` : `${Math.round(input.config[key] * 100)}%`;
  }
  const labels: Record<keyof FlightControls, string> = { throttle: 'Altitude', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };
  element('axis-mappings').innerHTML = Object.entries(labels).map(([key, label]) => {
    const mapping = input.config.axes[key as keyof FlightControls];
    return `<div class="mapping-row"><label for="axis-${key}">${label}</label><select id="axis-${key}" data-axis="${key}" aria-label="${label} axis">${Array.from({ length: 32 }, (_, index) => `<option value="${index}" ${index === mapping.index ? 'selected' : ''}>Axis ${index}</option>`).join('')}</select><label class="invert-label"><input type="checkbox" data-invert="${key}" ${mapping.inverted ? 'checked' : ''}/> Invert</label></div>`;
  }).join('');
  element('button-mappings').innerHTML = Object.entries(input.config.buttons).map(([action, index]) => `<label>${{ arm: 'Toggle motors', reset: 'Reset flight', camera: 'Change camera', pause: 'Pause' }[action]}<input type="number" min="0" max="63" value="${index}" data-button="${action}" aria-label="${action} button number" /></label>`).join('');
}

for (const key of ['deadzone', 'expo', 'sensitivity'] as const) {
  element(key).addEventListener('input', event => {
    input.setConfig({ ...input.config, [key]: Number((event.target as HTMLInputElement).value) });
    element(`${key}-value`).textContent = key === 'sensitivity' ? `${input.config[key].toFixed(1)}×` : `${Math.round(input.config[key] * 100)}%`;
  });
}
element('axis-mappings').addEventListener('change', event => {
  const target = event.target as HTMLInputElement;
  const key = (target.dataset.axis ?? target.dataset.invert) as keyof FlightControls;
  if (!key) return;
  input.setConfig({ ...input.config, axes: { ...input.config.axes, [key]: { ...input.config.axes[key], ...(target.dataset.axis ? { index: Number(target.value) } : { inverted: target.checked }) } } });
});
element('button-mappings').addEventListener('change', event => {
  const target = event.target as HTMLInputElement;
  const action = target.dataset.button;
  if (action) { input.setConfig({ ...input.config, buttons: { ...input.config.buttons, [action]: Number(target.value) } }); renderSettings(); }
});
element('calibrate').addEventListener('click', () => toast(input.calibrate() ? 'Stick centers saved. Move each stick to test your mapping.' : 'Connect a controller and press a button first.'));
element('restore-settings').addEventListener('click', () => { input.resetConfig(); renderSettings(); toast('Controller defaults restored.'); });

function updateMap() {
  if (!mapContext) return;
  const state = physics.state;
  mapContext.clearRect(0, 0, 220, 180);
  mapContext.strokeStyle = 'rgba(255,255,255,0.09)';
  mapContext.lineWidth = 1;
  for (let offset = 10; offset < 220; offset += 25) { mapContext.beginPath(); mapContext.moveTo(offset, 0); mapContext.lineTo(offset, 180); mapContext.stroke(); }
  for (let offset = 10; offset < 180; offset += 25) { mapContext.beginPath(); mapContext.moveTo(0, offset); mapContext.lineTo(220, offset); mapContext.stroke(); }
  const mapScale = 76 / currentMap.radius;
  const project = (position: Vec3) => ({ x: 110 + position.x * mapScale, y: 90 + position.z * mapScale });
  if (currentMap.buildings.length) {
    mapContext.save();
    mapContext.beginPath();
    mapContext.arc(110, 90, 76, 0, Math.PI * 2);
    mapContext.clip();
    for (const building of currentMap.buildings) {
      const footprint = building.tiers[0];
      const point = project({ x: building.x, y: 0, z: building.z });
      mapContext.fillStyle = building.style === 'glass' || building.style === 'landmark' ? 'rgba(169,195,206,.55)' : 'rgba(196,202,185,.3)';
      mapContext.fillRect(point.x - footprint.width * mapScale / 2, point.y - footprint.depth * mapScale / 2, footprint.width * mapScale, footprint.depth * mapScale);
    }
    mapContext.restore();
  }
  mapContext.strokeStyle = 'rgba(231,239,212,.4)';
  mapContext.setLineDash([3, 5]);
  mapContext.beginPath();
  mapContext.ellipse(110, 90, 76, 76, 0, 0, Math.PI * 2);
  mapContext.stroke();
  mapContext.setLineDash([]);
  currentMap.gates.forEach((gate, index) => { const point = project(gate.position); mapContext.beginPath(); mapContext.arc(point.x, point.y, index === activeGate && course ? 4 : 2, 0, Math.PI * 2); mapContext.fillStyle = index === activeGate && course ? '#eebe70' : 'rgba(233,242,216,.6)'; mapContext.fill(); });
  mapContext.fillStyle = '#e1e9d7';
  mapContext.font = '10px monospace';
  mapContext.fillText('H', 106, 105);
  const point = project(state.position);
  mapContext.save();
  mapContext.translate(point.x, point.y);
  mapContext.rotate(state.yaw);
  mapContext.beginPath(); mapContext.moveTo(0, -7); mapContext.lineTo(5, 5); mapContext.lineTo(0, 2); mapContext.lineTo(-5, 5); mapContext.closePath();
  mapContext.fillStyle = '#dbf3aa'; mapContext.fill();
  mapContext.restore();
  mapContext.fillStyle = '#fff'; mapContext.font = '9px monospace'; mapContext.fillText('N ↑', 12, 18);
}

function updateTelemetry(controls: FlightControls) {
  const state = physics.state;
  const altitude = Math.max(0, state.position.y - GROUND_HEIGHT);
  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  const heading = ((state.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const direction = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
  element('altitude').innerHTML = `${altitude.toFixed(1)} <small>m</small>`;
  element('altitude-hud').innerHTML = `${altitude.toFixed(1)} <small>M</small>`;
  element('speed').innerHTML = `${speed.toFixed(1)} <small>m/s</small>`;
  element('speed-note').textContent = paused ? 'Paused' : state.crashed ? physics.crashReason === 'building' ? 'Building collision' : 'Hard landing' : state.surface !== null && state.landingCount > 0 ? state.surface === 'rooftop' ? 'Landed on rooftop' : 'Landed on ground' : state.armed ? speed > 0.3 ? 'In motion' : state.surface === null ? 'Holding position' : 'Ready to climb' : 'Standing by';
  if (!paused && !state.crashed && state.surface === null && state.velocity.y < -0.05) element('speed-note').textContent = `Descending ${(-state.velocity.y).toFixed(1)} m/s`;
  if (state.armed && !paused && state.surface === null) element('flight-state-label').textContent = `IN FLIGHT · ${physics.mode.toUpperCase()}`;
  element('heading').innerHTML = `${String(Math.round(heading) % 360).padStart(3, '0')}<small>° ${direction}</small>`;
  element('battery').innerHTML = `${Math.max(0, Math.round(state.battery))}<small>%</small>`;
  element('battery-fill').style.width = `${Math.max(0, state.battery)}%`;
  element('flight-time').textContent = `${String(Math.floor(state.time / 60)).padStart(2, '0')}:${String(Math.floor(state.time % 60)).padStart(2, '0')}`;
  element('distance').innerHTML = course ? `${laps * currentMap.gates.length + activeGate} <small>/ ${(laps + 1) * currentMap.gates.length}</small>` : `${Math.round(state.distance)} <small>m</small>`;
  element('course-progress').firstElementChild!.setAttribute('style', `width:${activeGate / currentMap.gates.length * 100}%`);
  const ladderBase = Math.floor(altitude / 10) * 10;
  document.querySelectorAll<HTMLElement>('.altitude-ladder > span').forEach((label, index) => { label.textContent = String(Math.max(0, ladderBase + (2 - index) * 10)); });
  element('left-stick').style.transform = `translate(${controls.yaw * 23}px, ${-controls.throttle * 23}px)`;
  element('right-stick').style.transform = `translate(${controls.roll * 23}px, ${-controls.pitch * 23}px)`;
  const compass = document.querySelector('.heading-tape')!;
  const adjacent = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const sector = Math.round(heading / 45) % 8;
  compass.children[0].textContent = adjacent[(sector + 7) % 8];
  compass.children[2].textContent = direction;
  compass.children[4].textContent = adjacent[(sector + 1) % 8];
  updateMap();
}

function animate(now: number) {
  const delta = Math.min((now - previousTime) / 1000, 0.1);
  previousTime = now;
  if (patrolVisible) {
    if (windowActive && !document.hidden && !document.querySelector('dialog[open]')) patrolPanel.tick(delta);
    requestAnimationFrame(animate);
    return;
  }
  const frame = input.poll();
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));
  if (frame.disconnected && (physics.state.armed || physics.state.surface === null) && !physics.state.crashed) { setPaused(true, 'Controller disconnected. Reconnect it, or resume with your keyboard.'); toast('Controller disconnected. Flight paused.'); }
  if (!dialogOpen && windowActive && !document.hidden) for (const action of frame.actions) {
    if (action === 'arm') toggleArm();
    if (action === 'reset') resetFlight();
    if (action === 'camera') changeCamera();
    if (action === 'pause') setPaused(!paused);
  }
  const device = frame.gamepad?.id ?? '';
  if (device !== lastDevice) {
    if (device) toast('Controller connected. Check your sticks in Live inputs.');
    lastDevice = device;
  }
  if (!paused && !dialogOpen && !renderingError && windowActive && !document.hidden) {
    accumulator += delta;
    while (accumulator >= fixedStep) {
      previousPosition = { ...physics.state.position };
      physics.step(frame.controls, fixedStep);
      if (course && physics.state.armed && passesGate(previousPosition, physics.state.position, currentMap.gates[activeGate])) {
        activeGate += 1;
        if (activeGate === currentMap.gates.length) { laps += 1; activeGate = 0; toast(`Lap ${laps} complete. Nicely flown! Keep going or explore.`); }
        else toast(`Gate ${activeGate} cleared. On to gate ${activeGate + 1}.`);
      }
      accumulator -= fixedStep;
    }
  } else accumulator = 0;
  if (physics.state.armed !== lastArmed || physics.state.crashed !== lastCrashed || physics.state.surface !== lastSurface || physics.state.landingCount !== lastLandingCount) {
    if (physics.state.crashed && !lastCrashed) toast(physics.crashReason === 'building' ? 'Building collision. Press R to return to the landing pad.' : physics.crashReason === 'rooftop' ? 'Hard rooftop landing. Slow your descent and sideways speed. Press R to reset.' : 'Hard landing. Press R for a fresh start.');
    if (physics.state.landingCount > lastLandingCount) toast(physics.lastLanding?.surface === 'rooftop' ? 'Soft rooftop landing. Nicely done — you can take off again.' : 'Soft landing. Ready to take off again.');
    lastArmed = physics.state.armed;
    lastCrashed = physics.state.crashed;
    lastSurface = physics.state.surface;
    lastLandingCount = physics.state.landingCount;
    updateFlightStatus();
  }
  scene?.render(physics.state, paused || dialogOpen ? 0 : delta, cameraMode, course ? activeGate : -1);
  uiElapsed += delta;
  if (uiElapsed > 0.08) {
    uiElapsed = 0;
    updateTelemetry(frame.controls);
    element('input-source').textContent = frame.source.toUpperCase();
    element('connection-title').textContent = device ? 'Controller connected' : 'Connect your C40';
    element('connection-subtitle').textContent = device ? 'Live input is ready' : 'Keyboard controls are ready';
    element('device-name').textContent = device || 'Waiting for a controller';
    element('device-detail').textContent = frame.gamepad ? `${frame.gamepad.mapping === 'standard' ? 'Standard mapping' : 'Custom mapping — check each axis'} · ${frame.gamepad.axes.length} axes · ${frame.gamepad.buttons.length} buttons` : frame.supported ? 'Click this page, then press a controller button.' : 'Gamepad API unavailable. Try a supported browser on localhost or HTTPS.';
    element('device-dot').classList.toggle('connected', Boolean(device));
    if (dialogOpen) {
      element('raw-axes').textContent = frame.rawAxes.length ? frame.rawAxes.map((value, index) => `A${index}: ${value.toFixed(2)}`).join('   ') : 'Raw axes appear when a controller connects.';
      element('raw-buttons').textContent = frame.rawButtons.some(value => value > 0.1) ? `Pressed: ${frame.rawButtons.map((value, index) => value > 0.1 ? `${index} (${value.toFixed(2)})` : '').filter(Boolean).join(', ')}` : 'Press a controller button to see its number.';
    }
  }
  requestAnimationFrame(animate);
}

renderSettings();
updateMapLabels();
updateFlightStatus();
updateTelemetry({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
requestAnimationFrame(animate);
window.addEventListener('beforeunload', () => { input.dispose(); scene?.dispose(); patrolPanel.dispose(); });
