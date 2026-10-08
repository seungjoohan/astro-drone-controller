import './patrol-neural-preview.css';
import { validateEnvironment } from './patrol-environment';
import { FrozenPatrolPolicy } from './patrol-rl-inference';
import { createNYCPreviewScenario, PatrolPreviewSession } from './patrol-rl-playback';
import type { RLScenario } from './patrol-rl-scenarios';
import type { PatrolSnapshot } from './patrol-types';

interface PreviewModel {
  seed: number;
  path: string;
  episodes: number;
  sha256: string;
}

interface PreviewManifest {
  version: 1;
  defaultSeed: number;
  models: PreviewModel[];
  scenarios: RLScenario[];
  runLabel: string;
}

type Controller = 'neural' | 'uniform' | 'adaptive';

function element<ElementType extends HTMLElement>(id: string): ElementType {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing preview element: ${id}`);
  return found as ElementType;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function parseManifest(value: unknown): PreviewManifest {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 8
    || !Array.isArray(value.scenarios) || value.scenarios.length > 8 || typeof value.runLabel !== 'string' || value.runLabel.length > 120) throw new Error('Invalid local preview manifest.');
  const models = value.models.map(model => {
    if (!object(model) || !bounded(model.seed, 1, 2147483647) || !Number.isInteger(model.seed)
      || !bounded(model.episodes, 1, 1000000) || !Number.isInteger(model.episodes)
      || typeof model.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(model.sha256)
      || model.path !== `/__patrol_preview/policy-${model.seed}.json`) throw new Error('Invalid model entry in preview manifest.');
    return model as unknown as PreviewModel;
  });
  if (new Set(models.map(model => model.seed)).size !== models.length || !models.some(model => model.seed === value.defaultSeed)) throw new Error('Invalid default preview policy.');
  const scenarios = value.scenarios.map(scenario => {
    if (!object(scenario) || typeof scenario.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(scenario.id)
      || scenario.id === 'preview-nyc' || scenario.split !== 'validation' || !['persistent', 'moving', 'surge', 'diffuse'].includes(String(scenario.family))
      || !bounded(scenario.seed, 1, 2147483647) || !Number.isInteger(scenario.seed)
      || !validateEnvironment(scenario.environment) || !object(scenario.config)
      || !bounded(scenario.warmupSeconds, 0, 3600) || !bounded(scenario.durationSeconds, 1, 20000)) throw new Error('Invalid held-out preview scenario.');
    const config = scenario.config;
    if (!bounded(config.coverageTarget, 1, 100) || !bounded(config.revisitSeconds, 1, 3600)
      || !bounded(config.fleetSize, 1, 8) || !Number.isInteger(config.fleetSize)
      || !bounded(config.populationCount, 0, 50000) || !Number.isInteger(config.populationCount)
      || !bounded(config.populationSeed, 1, 2147483647) || !Number.isInteger(config.populationSeed)
      || !bounded(config.crowdedRevisitSeconds, 1, 3600) || !bounded(config.crowdedCellPopulation, 1, 50000)) throw new Error('Invalid population settings in preview manifest.');
    if (scenario.fault !== undefined && (!object(scenario.fault) || !bounded(scenario.fault.atSeconds, 0, 23600)
      || !['malfunction', 'deviation'].includes(String(scenario.fault.kind))
      || scenario.fault.droneId !== undefined && (!bounded(scenario.fault.droneId, 1, 8) || !Number.isInteger(scenario.fault.droneId)))) throw new Error('Invalid preview fault.');
    return scenario as unknown as RLScenario;
  });
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) throw new Error('Duplicate preview scenario.');
  return { version: 1, defaultSeed: value.defaultSeed as number, models, scenarios, runLabel: value.runLabel };
}

const canvas = element<HTMLCanvasElement>('preview-map');
const context = canvas.getContext('2d');
const policySelect = element<HTMLSelectElement>('preview-policy');
const scenarioSelect = element<HTMLSelectElement>('preview-scenario');
const controllerSelect = element<HTMLSelectElement>('preview-controller');
const fleetSelect = element<HTMLSelectElement>('preview-fleet');
const speedSelect = element<HTMLSelectElement>('preview-speed');
const startButton = element<HTMLButtonElement>('preview-start');
const resetButton = element<HTMLButtonElement>('preview-reset');
const applyButton = element<HTMLButtonElement>('preview-apply');
const retryButton = element<HTMLButtonElement>('preview-retry');
const controls = [policySelect, scenarioSelect, controllerSelect, fleetSelect, speedSelect, startButton, resetButton, applyButton];
const policies = new Map<number, { policy: FrozenPatrolPolicy; sha256: string }>();
const lifetime = new AbortController();
let request: AbortController | null = null;
let manifest: PreviewManifest | null = null;
let session: PatrolPreviewSession | null = null;
let appliedScenario: RLScenario | null = null;
let appliedController: Controller = 'neural';
let appliedSeed = 101;
let running = false;
let busy = true;
let disposed = false;
let lastFrame = 0;
let accumulated = 0;
let animationFrame = 0;
let droneRows: HTMLElement[] = [];

function write(id: string, value: string): void {
  element(id).textContent = value;
}

function updateControls(): void {
  for (const control of controls) control.disabled = busy || !manifest;
  startButton.disabled = busy || !session || session.done;
  resetButton.disabled = busy || !session;
  startButton.textContent = running ? 'Pause patrol' : 'Start patrol';
}

function showError(error: unknown): void {
  const target = element('preview-error');
  target.textContent = error instanceof Error ? error.message : 'Unable to load this local preview.';
  target.hidden = false;
  write('preview-status', 'Unavailable');
}

function pause(reason = 'Paused'): void {
  running = false;
  accumulated = 0;
  lastFrame = 0;
  if (session) write('preview-status', session.done ? 'Complete' : reason);
  updateControls();
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function timeLabel(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function draw(snapshot: PatrolSnapshot): void {
  if (!context) return;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (width <= 42 || height <= 42) return;
  const environment = snapshot.environment;
  const scale = Math.min((width - 42) / environment.width, (height - 42) / environment.depth);
  const horizontal = (position: number) => width / 2 + position * scale;
  const vertical = (position: number) => height / 2 + position * scale;
  const boundary = () => {
    context.beginPath();
    if (environment.shape === 'circle') context.arc(width / 2, height / 2, environment.width / 2 * scale, 0, Math.PI * 2);
    else context.rect(horizontal(-environment.width / 2), vertical(-environment.depth / 2), environment.width * scale, environment.depth * scale);
  };
  context.save();
  boundary();
  context.fillStyle = '#e0e7d9';
  context.fill();
  context.clip();
  for (let column = -320; column < 320; column += 40) {
    for (let row = -320; row < 320; row += 40) {
      const shade = (column / 40 + row / 40 + 18) % 3;
      context.fillStyle = ['#ccd7c6', '#d4ddce', '#c5d2c1'][shade];
      context.fillRect(horizontal(column + 5), vertical(row + 5), 29 * scale, 28 * scale);
      context.strokeStyle = '#f4f7ef';
      context.lineWidth = 0.8;
      context.strokeRect(horizontal(column + 7), vertical(row + 7), 25 * scale, 24 * scale);
      context.strokeStyle = '#f4f7ef';
      context.beginPath();
      context.moveTo(horizontal(column), vertical(row));
      context.lineTo(horizontal(column + 40), vertical(row));
      context.moveTo(horizontal(column), vertical(row));
      context.lineTo(horizontal(column), vertical(row + 40));
      context.stroke();
    }
  }
  for (const cell of snapshot.cells) {
    if (!cell.population) continue;
    const crowded = cell.population >= snapshot.config.crowdedCellPopulation;
    const radius = Math.min(15, 2 + Math.sqrt(cell.population) * 0.75) * scale;
    context.beginPath();
    context.arc(horizontal(cell.position.x), vertical(cell.position.z), Math.max(1.5, radius), 0, Math.PI * 2);
    context.fillStyle = '#9863ae80';
    context.fill();
    if (crowded) {
      context.strokeStyle = '#87569e';
      context.lineWidth = 1.4;
      context.stroke();
    }
  }
  for (const drone of snapshot.drones) {
    if (drone.status === 'offline') continue;
    if (drone.status === 'patrolling' && drone.fault === null && drone.serviceState === 'patrol') {
      context.beginPath();
      context.arc(horizontal(drone.position.x), vertical(drone.position.z), environment.sensorRadius * scale, 0, Math.PI * 2);
      context.fillStyle = `${drone.color}20`;
      context.fill();
      context.strokeStyle = drone.color;
      context.lineWidth = 1;
      context.setLineDash([4, 4]);
      context.stroke();
      context.setLineDash([]);
    }
    const destination = drone.route[drone.routeIndex];
    if (destination) {
      context.beginPath();
      context.moveTo(horizontal(drone.position.x), vertical(drone.position.z));
      context.lineTo(horizontal(destination.x), vertical(destination.z));
      context.strokeStyle = drone.color;
      context.lineWidth = 1.5;
      context.globalAlpha = 0.65;
      context.stroke();
      context.globalAlpha = 1;
    }
  }
  context.restore();
  boundary();
  context.strokeStyle = '#8fa889';
  context.lineWidth = 1.4;
  context.setLineDash([6, 6]);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = '#354e3d';
  context.save();
  context.translate(horizontal(environment.depot.x), vertical(environment.depot.z));
  context.rotate(Math.PI / 4);
  context.fillRect(-5, -5, 10, 10);
  context.restore();
  for (const drone of snapshot.drones) {
    const centerX = horizontal(drone.position.x);
    const centerY = vertical(drone.position.z);
    context.beginPath();
    context.arc(centerX, centerY, 11, 0, Math.PI * 2);
    context.fillStyle = drone.status === 'offline' ? '#9caaa0' : drone.color;
    context.fill();
    context.strokeStyle = '#fff';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = '#fff';
    context.font = '600 11px -apple-system, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(drone.id), centerX, centerY + 0.5);
  }
}

function render(): void {
  if (!session) return;
  const snapshot = session.snapshot();
  write('preview-time', timeLabel(snapshot.time));
  write('preview-on-time', percentage(snapshot.population.onTimeCoverage));
  write('preview-in-view', percentage(snapshot.population.inViewCoverage));
  write('preview-gap', snapshot.population.normalizedGapCost?.toFixed(3) ?? '—');
  write('preview-area', percentage(snapshot.coverage));
  write('preview-audit', percentage(session.auditCoverage));
  write('preview-decisions', String(session.decisions));
  canvas.dataset.controller = appliedController;
  canvas.dataset.time = String(snapshot.time);
  canvas.dataset.droneCount = String(snapshot.drones.length);
  const liveStage = appliedScenario && snapshot.time < appliedScenario.warmupSeconds ? `Warm-up (${appliedScenario.warmupSeconds}s); metrics are instantaneous, not benchmark averages.` : 'Metrics are instantaneous; on-time means revisited within each location’s deadline.';
  write('preview-context', `${appliedScenario?.id === 'preview-nyc' ? 'NYC sandbox: new 640 m scenario, not a benchmark result.' : 'Held-out validation replay: same scenario and deterministic decisions as the evaluation.'} ${liveStage} ${snapshot.population.totalPeople.toLocaleString()} people. Area target ${snapshot.config.coverageTarget}% / ${snapshot.config.revisitSeconds}s; crowded deadline ${snapshot.config.crowdedRevisitSeconds}s.`);
  if (droneRows.length !== snapshot.drones.length) {
    droneRows = snapshot.drones.map(() => {
      const row = document.createElement('div');
      row.className = 'drone-row';
      for (const name of ['drone-number', 'drone-state', 'drone-battery', 'battery-track']) {
        const part = document.createElement('span');
        part.className = name;
        if (name === 'battery-track') part.append(document.createElement('span'));
        row.append(part);
      }
      return row;
    });
    element('preview-drones').replaceChildren(...droneRows);
  }
  snapshot.drones.forEach((drone, index) => {
    const row = droneRows[index];
    const [number, state, battery, track] = Array.from(row.children) as HTMLElement[];
    number.textContent = String(drone.id);
    number.style.backgroundColor = drone.color;
    state.textContent = drone.status !== 'patrolling' ? drone.status : `${drone.serviceState} · ${drone.speed.toFixed(1)} m/s`;
    battery.textContent = `${Math.round(drone.batteryFraction * 100)}%`;
    (track.firstElementChild as HTMLElement).style.width = `${drone.batteryFraction * 100}%`;
    row.dataset.warning = String(drone.batteryFraction <= snapshot.environment.reserveFraction);
    row.dataset.position = `${drone.position.x.toFixed(2)},${drone.position.z.toFixed(2)}`;
  });
  draw(snapshot);
}

async function fetchJSON(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Local preview artifact unavailable (${response.status}). Run the local preview preparation command, then retry.`);
  return response.json();
}

async function fetchPolicy(model: PreviewModel, signal: AbortSignal): Promise<FrozenPatrolPolicy> {
  const response = await fetch(model.path, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Local preview artifact unavailable (${response.status}). Run the local preview preparation command, then retry.`);
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== model.sha256) throw new Error('Local policy checksum mismatch. Prepare the preview artifacts again; no controller was started.');
  return FrozenPatrolPolicy.fromArtifact(JSON.parse(new TextDecoder().decode(bytes)));
}

async function applyPreview(): Promise<void> {
  if (!manifest || disposed) return;
  request?.abort();
  const currentRequest = new AbortController();
  request = currentRequest;
  pause();
  busy = true;
  session = null;
  updateControls();
  element('preview-error').hidden = true;
  write('preview-status', 'Loading');
  try {
    const seed = Number(policySelect.value);
    const model = manifest.models.find(entry => entry.seed === seed);
    const scenario = scenarioSelect.value === 'preview-nyc' ? createNYCPreviewScenario() : manifest.scenarios.find(entry => entry.id === scenarioSelect.value);
    const controller = controllerSelect.value;
    const fleet = Number(fleetSelect.value);
    if (!model || !scenario || !['neural', 'uniform', 'adaptive'].includes(controller) || !Number.isInteger(fleet) || fleet < 1 || fleet > 8) throw new Error('Invalid preview selection.');
    let policy: FrozenPatrolPolicy | undefined;
    if (controller === 'neural') {
      const cached = policies.get(seed);
      policy = cached?.sha256 === model.sha256 ? cached.policy : undefined;
      if (!policy) {
        policy = await fetchPolicy(model, currentRequest.signal);
        if (policy.seed !== model.seed || policy.completedEpisodes !== model.episodes) throw new Error('Policy does not match its training manifest.');
        policies.set(seed, { policy, sha256: model.sha256 });
      }
    }
    if (currentRequest.signal.aborted || disposed) return;
    session = new PatrolPreviewSession(scenario, fleet, controller as Controller, policy);
    appliedScenario = scenario;
    appliedController = controller as Controller;
    appliedSeed = seed;
    write('preview-map-title', scenario.id === 'preview-nyc' ? 'NYC · new sandbox' : `Held-out · ${scenario.family} population`);
    write('preview-applied', `${controller === 'neural' ? `Neural PPO / seed ${seed}` : `${controller === 'uniform' ? 'Uniform' : 'Adaptive'} baseline`} · ${fleet} drones · ${scenario.environment.width} × ${scenario.environment.depth} m`);
    write('preview-environment', `${scenario.environment.maxSpeed} m/s max · ${scenario.environment.sensorRadius} m camera · ${scenario.environment.enduranceSeconds}s endurance · ${scenario.environment.chargingPads} charging pads`);
    write('preview-staged', 'Settings applied. Ready to start a new mission.');
    write('preview-status', 'Ready');
    render();
  } catch (error) {
    if (!currentRequest.signal.aborted && !disposed) {
      showError(error);
      write('preview-applied', 'No active preview — nothing is running.');
      write('preview-time', '00:00');
      for (const metric of ['on-time', 'in-view', 'gap', 'area', 'audit']) write(`preview-${metric}`, '—');
      write('preview-decisions', '0');
      write('preview-context', 'Select a valid trained policy or explicitly choose a baseline, then apply the preview.');
      element('preview-drones').replaceChildren();
      droneRows = [];
      delete canvas.dataset.controller;
      delete canvas.dataset.time;
      delete canvas.dataset.droneCount;
      if (context) {
        context.resetTransform();
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  } finally {
    if (request === currentRequest && !disposed) {
      busy = false;
      updateControls();
    }
  }
}

async function initialize(): Promise<void> {
  if (!import.meta.env.DEV) {
    showError(new Error('Neural patrol preview is available only on the local Vite development server.'));
    return;
  }
  busy = true;
  updateControls();
  retryButton.hidden = true;
  element('preview-error').hidden = true;
  request?.abort();
  const currentRequest = new AbortController();
  request = currentRequest;
  try {
    manifest = parseManifest(await fetchJSON('/__patrol_preview/manifest.json', currentRequest.signal));
    if (disposed || currentRequest.signal.aborted) return;
    policySelect.replaceChildren(...manifest.models.map(model => new Option(`Seed ${model.seed} · ${model.episodes} episodes`, String(model.seed))));
    policySelect.value = String(manifest.defaultSeed);
    scenarioSelect.replaceChildren(new Option('NYC · new sandbox (not benchmarked)', 'preview-nyc'), ...manifest.scenarios.map((scenario, index) => new Option(`Held-out ${index + 1} · ${scenario.family}`, scenario.id)));
    const episodes = new Set(manifest.models.map(model => model.episodes));
    const trainingSummary = episodes.size === 1 ? `${manifest.models[0].episodes} episodes × ${manifest.models.length} seeds` : `${manifest.models.length} trained seeds`;
    write('preview-training', `${trainingSummary}. Frozen deterministic playback; weights do not change here. Run: ${manifest.runLabel}.`);
    await applyPreview();
  } catch (error) {
    if (!currentRequest.signal.aborted && !disposed) {
      manifest = null;
      showError(error);
      retryButton.hidden = false;
      busy = false;
      updateControls();
    }
  }
}

startButton.addEventListener('click', () => {
  if (!session || busy || session.done) return;
  if (running) pause();
  else {
    running = true;
    lastFrame = 0;
    write('preview-status', 'Running');
    updateControls();
  }
}, { signal: lifetime.signal });
resetButton.addEventListener('click', () => {
  if (!session || !appliedScenario) return;
  pause('Ready');
  session = new PatrolPreviewSession(appliedScenario, session.snapshot().drones.length, appliedController, appliedController === 'neural' ? policies.get(appliedSeed)?.policy : undefined);
  render();
  updateControls();
}, { signal: lifetime.signal });
applyButton.addEventListener('click', () => { void applyPreview(); }, { signal: lifetime.signal });
retryButton.addEventListener('click', () => { void initialize(); }, { signal: lifetime.signal });
for (const control of [policySelect, scenarioSelect, controllerSelect, fleetSelect]) {
  control.addEventListener('change', () => write('preview-staged', 'Unapplied changes. Apply preview resets the mission; current settings stay active.'), { signal: lifetime.signal });
}
window.addEventListener('blur', () => { if (running) pause('Paused · focus lost'); }, { signal: lifetime.signal });
document.addEventListener('visibilitychange', () => { if (document.hidden && running) pause('Paused · hidden'); }, { signal: lifetime.signal });
const resizeObserver = new ResizeObserver(() => render());
resizeObserver.observe(canvas);

function frame(timestamp: number): void {
  if (disposed) return;
  if (running && session && !document.hidden) {
    const elapsed = lastFrame ? Math.min(0.25, (timestamp - lastFrame) / 1000) : 0;
    lastFrame = timestamp;
    accumulated += elapsed * Number(speedSelect.value);
    if (accumulated >= 0.5) {
      const seconds = Math.floor(accumulated / 0.5) * 0.5;
      accumulated -= seconds;
      try {
        session.advance(seconds);
        render();
        if (session.done) pause('Complete');
      } catch (error) {
        pause();
        session = null;
        showError(error);
        updateControls();
      }
    }
  }
  animationFrame = requestAnimationFrame(frame);
}

function dispose(): void {
  disposed = true;
  running = false;
  request?.abort();
  lifetime.abort();
  resizeObserver.disconnect();
  cancelAnimationFrame(animationFrame);
  session = null;
  policies.clear();
}

window.addEventListener('pagehide', dispose, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
if (import.meta.hot) import.meta.hot.dispose(dispose);
animationFrame = requestAnimationFrame(frame);
void initialize();
