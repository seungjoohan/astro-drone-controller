import { CITY_BLOCK_SIZE, CITY_PARK, FLIGHT_MAPS } from './maps';
import { PATROL_DEFAULTS, PATROL_LIMITS, PatrolSystem, recommendFleet } from './patrol';
import type { PatrolConfig, PatrolDrone, PatrolSnapshot } from './patrol-types';
import './patrol.css';

function elapsedTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function duration(seconds: number): string {
  return Number.isFinite(seconds) ? `${Math.ceil(seconds)} s` : 'Unserved';
}

function populationPercent(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(1)}%`;
}

export class PatrolPanel {
  private readonly system = new PatrolSystem(PATROL_DEFAULTS);
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly events = new AbortController();
  private active = false;
  private running = false;
  private started = false;
  private speed = 1;
  private renderElapsed = 0;
  private pauseReason = '';
  private cardCount = -1;
  private lastEventId = -1;
  private width = 1;
  private height = 1;
  private disposed = false;
  private populationLayer = true;

  constructor(private readonly container: HTMLElement) {
    container.innerHTML = `
      <div class="patrol-heading">
        <div><div class="eyebrow">AUTONOMOUS OPERATIONS / MIDTOWN NYC</div><h1>Patrol control<span>.</span></h1><p>A coordinated fleet. A shared mission. Coverage that adapts.</p></div>
        <div class="patrol-heading-actions"><button id="patrol-reset" class="patrol-secondary" type="button">Reset patrol</button><button id="patrol-start" class="patrol-primary" type="button">Start patrol</button></div>
      </div>
      <div class="patrol-metrics">
        <div class="patrol-metric patrol-coverage-metric"><span>FRESH AREA COVERAGE</span><strong id="patrol-coverage">0.0%</strong><div class="patrol-coverage-track"><i id="patrol-coverage-fill"></i><b id="patrol-target-tick"></b></div><small id="patrol-coverage-caption"></small></div>
        <div class="patrol-metric"><span>HEALTHY AIRCRAFT</span><strong id="patrol-active-count">0 / 0</strong><small id="patrol-fleet-caption"></small></div>
        <div class="patrol-metric"><span>PREDICTED REVISIT</span><strong id="patrol-revisit">—</strong><small>Longest assigned route · estimate</small></div>
        <div class="patrol-metric"><span>MISSION CLOCK</span><strong id="patrol-time">00:00</strong><small id="patrol-clock-caption">Paused · simulated time</small></div>
      </div>
      <section class="patrol-population-panel" aria-labelledby="patrol-population-title">
        <div class="patrol-population-heading"><div><div class="eyebrow">POPULATION / SEPARATE SERVICE METRICS</div><h2 id="patrol-population-title">People & observation gaps</h2></div><p>Frequent revisits, not continuous coverage.<br>Shorter unobserved gaps are always better.</p></div>
        <div class="patrol-population-metrics">
          <div class="patrol-metric"><span>PEOPLE REVISITED ON TIME</span><strong id="patrol-people-fresh">0.0%</strong><small>Share within their cell’s revisit target</small></div>
          <div class="patrol-metric"><span>PEOPLE IN VIEW NOW</span><strong id="patrol-people-visible">0.0%</strong><small>Inside a healthy camera footprint</small></div>
          <div class="patrol-metric"><span>MEAN OBSERVATION AGE</span><strong id="patrol-population-age">—</strong><small>Population weighted · lower is better</small></div>
          <div class="patrol-metric"><span>RELATIVE GAP COST</span><strong id="patrol-population-cost">—</strong><small>Instantaneous weighted (age / target)²</small></div>
        </div>
        <p id="patrol-population-summary" class="patrol-population-summary"></p><p id="patrol-population-targets" class="patrol-population-note"></p><p class="patrol-population-note">Unseen people count as overdue; their age is mission time plus their revisit target. Routes remain the uniform baseline: population-aware routing and learning are not enabled.</p>
      </section>
      <div class="patrol-layout">
        <section class="patrol-map-panel" aria-labelledby="patrol-map-title">
          <div class="patrol-map-toolbar"><div><span class="patrol-live-dot"></span><h2 id="patrol-map-title">Live operations map</h2><span class="patrol-view-tag">2D OVERHEAD</span></div><span class="patrol-revision-label">PLAN <strong id="patrol-revision">1</strong></span></div>
          <div class="patrol-population-map-tools"><label for="patrol-population-layer"><input id="patrol-population-layer" type="checkbox" checked> Population density</label><span><i class="patrol-key-population"></i>Larger violet circles = more people · ring = crowded</span></div>
          <div class="patrol-map-wrap"><canvas id="patrol-map" aria-label="Midtown NYC patrol map showing area coverage cells, population density circles, assigned routes, sensor footprints and aircraft"></canvas><div class="patrol-map-location"><strong>Midtown NYC</strong><span>320 m radius · simulated airspace</span></div><div class="patrol-map-north" aria-hidden="true">N<span>↑</span></div><div class="patrol-map-state"><span class="patrol-state-dot"></span><strong id="patrol-status" role="status">Ready to start</strong></div><div id="patrol-map-scale" class="patrol-map-scale" aria-hidden="true"><span></span>100 m</div></div>
          <div class="patrol-map-legend"><span><i class="patrol-key-fresh"></i>Fresh · fleet color</span><span><i class="patrol-key-stale"></i>Stale</span><span><i class="patrol-key-unseen"></i>Never scanned</span><span><i class="patrol-key-route"></i>Assigned route</span><span><i class="patrol-key-command"></i>Current command</span><span><i class="patrol-key-scan"></i>Sensor footprint</span></div>
          <div class="patrol-map-summary"><span id="patrol-cell-summary"></span><span id="patrol-oldest"></span></div>
        </section>
        <aside class="patrol-controls" aria-label="Patrol mission controls">
          <section class="patrol-card"><div class="patrol-card-title"><h2>Mission parameters</h2><span>01</span></div>
            <form id="patrol-config-form">
              <label for="patrol-target">Coverage target (%)</label><div class="patrol-number-wrap"><input id="patrol-target" type="number" min="70" max="100" step="1" required value="${PATROL_DEFAULTS.coverageTarget}"><span>% area</span></div>
              <label for="patrol-window">Revisit window (seconds)</label><div class="patrol-number-wrap"><input id="patrol-window" type="number" min="30" max="300" step="1" required value="${PATROL_DEFAULTS.revisitSeconds}"><span>sec</span></div>
              <label for="patrol-fleet">Fleet size</label><div class="patrol-number-wrap"><input id="patrol-fleet" type="number" min="1" max="${PATROL_LIMITS.maxDrones}" step="1" required value="${PATROL_DEFAULTS.fleetSize}"><span>aircraft</span></div>
              <div class="patrol-recommendation"><strong id="patrol-recommended"></strong><p id="patrol-recommendation-note"></p><button id="patrol-use-recommended" type="button">Use recommended fleet <span aria-hidden="true">↗</span></button></div>
              <fieldset class="patrol-population-fields"><legend>City population</legend><div class="patrol-field-grid">
                <div><label for="patrol-population">Total people</label><div class="patrol-number-wrap"><input id="patrol-population" type="number" min="0" max="50000" step="1" required value="${PATROL_DEFAULTS.populationCount}"></div></div>
                <div><label for="patrol-population-seed">Population seed</label><div class="patrol-number-wrap"><input id="patrol-population-seed" type="number" min="1" max="2147483647" step="1" required value="${PATROL_DEFAULTS.populationSeed}"></div></div>
                <div><label for="patrol-crowded-window">Crowded revisit (sec)</label><div class="patrol-number-wrap"><input id="patrol-crowded-window" type="number" min="1" max="300" step="1" required value="${PATROL_DEFAULTS.crowdedRevisitSeconds}"></div></div>
                <div><label for="patrol-crowded-threshold">Crowded: people / cell</label><div class="patrol-number-wrap"><input id="patrol-crowded-threshold" type="number" min="1" max="1000" step="1" required value="${PATROL_DEFAULTS.crowdedCellPopulation}"></div></div>
              </div><button id="patrol-randomize-population" type="button" class="patrol-secondary">Randomize population seed</button><p class="patrol-form-note">Seeded, stationary clusters. Revisit targets shorten gradually as cell population rises, reaching the crowded window at the threshold. Applying clamps that window to the area window.</p></fieldset>
              <button id="patrol-apply" type="submit" class="patrol-secondary">Apply and reset</button><p class="patrol-form-note" id="patrol-config-note">Use Apply and reset to change mission parameters.</p>
            </form>
          </section>
          <section class="patrol-card patrol-health-card"><div class="patrol-card-title"><h2>Mission health</h2><span>02</span></div><div id="patrol-health" class="patrol-health-message"></div><dl><div><dt>Estimated fresh area coverage</dt><dd id="patrol-estimate"></dd></div><div><dt>Area ever scanned</dt><dd id="patrol-ever-covered"></dd></div><div><dt>Fault detection delay</dt><dd>${PATROL_LIMITS.detectionSeconds} s</dd></div></dl><label for="patrol-speed">Simulation speed</label><select id="patrol-speed"><option value="1">1× real time</option><option value="4">4× accelerated</option><option value="8">8× accelerated</option><option value="16">16× accelerated</option></select></section>
        </aside>
      </div>
      <div class="patrol-bottom-layout">
        <section class="patrol-fleet-panel" aria-labelledby="patrol-fleet-title"><div class="patrol-section-heading"><div><div class="eyebrow">FLEET TELEMETRY</div><h2 id="patrol-fleet-title">Aircraft & recovery</h2></div><span>INJECT A TEST FAULT</span></div><p class="patrol-section-note">Fail or divert an aircraft to test detection and redistribution. Restore it to rejoin the plan.</p><div id="patrol-fleet-cards" class="patrol-fleet-cards"></div></section>
        <section class="patrol-log-panel" aria-labelledby="patrol-log-title"><div class="patrol-section-heading"><div><div class="eyebrow">MISSION HISTORY</div><h2 id="patrol-log-title">Event log</h2></div><span>SIMULATED TIME</span></div><ol id="patrol-log" role="log" aria-label="Patrol event log" aria-live="polite" aria-relevant="additions"></ol></section>
      </div>
      <div class="patrol-method-note"><strong>Simulation only</strong><p>Overhead footprint sampling across a ${PATROL_LIMITS.cellSize} m grid, with a ${PATROL_LIMITS.sensorRadius} m sensor radius. Population is an abstract, stationary count per cell, not simulated pedestrians. Buildings do not occlude scans. Aircraft stage instantly in altitude lanes from 260–288 m; this view does not simulate launch, onboard cameras or hardware connections. Fleet recommendations consider the area target only, not population revisit targets. No learned or population-aware routing is enabled.</p></div>`;
    this.canvas = this.element<HTMLCanvasElement>('patrol-map');
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('This browser could not create the patrol operations map.');
    this.context = context;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas.parentElement!);
    this.bindEvents();
    this.updateRecommendation();
    this.refresh();
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (!active) this.pause('Switched to manual flight');
    this.active = active;
    this.container.hidden = !active;
    if (active) this.resize();
  }

  tick(deltaSeconds: number): void {
    if (this.disposed || !this.active) return;
    if (document.hidden) {
      this.pause('Browser tab hidden');
      return;
    }
    const delta = Number.isFinite(deltaSeconds) ? Math.min(Math.max(deltaSeconds, 0), 0.25) : 0;
    if (this.running) this.system.step(delta * this.speed);
    this.renderElapsed += delta;
    if (this.renderElapsed >= 0.1) {
      this.renderElapsed = 0;
      this.refresh();
    }
  }

  pause(reason = 'Paused by operator'): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.pauseReason = reason;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.running = false;
    this.disposed = true;
    this.events.abort();
    this.observer.disconnect();
    this.container.replaceChildren();
  }

  private element<ElementType extends HTMLElement = HTMLElement>(id: string): ElementType {
    return this.container.querySelector<ElementType>(`#${id}`)!;
  }

  private text(id: string, value: string): void {
    this.element(id).textContent = value;
  }

  private bindEvents(): void {
    const options = { signal: this.events.signal };
    this.element('patrol-start').addEventListener('click', () => {
      if (this.running) this.pause();
      else if (this.active && !document.hidden) {
        this.running = true;
        this.started = true;
        this.pauseReason = '';
        this.refresh();
      }
    }, options);
    this.element('patrol-reset').addEventListener('click', () => this.reset(), options);
    this.element<HTMLFormElement>('patrol-config-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.element<HTMLFormElement>('patrol-config-form').reportValidity()) return;
      this.reset(this.pendingConfig());
      this.text('patrol-config-note', 'Parameters applied. Start patrol when ready.');
    }, options);
    for (const id of ['patrol-target', 'patrol-window', 'patrol-fleet', 'patrol-population', 'patrol-population-seed', 'patrol-crowded-window', 'patrol-crowded-threshold']) {
      this.element(id).addEventListener('input', () => {
        this.updateRecommendation();
        this.text('patrol-config-note', 'Unsaved parameters · Apply and reset to use them.');
      }, options);
    }
    this.element('patrol-use-recommended').addEventListener('click', () => {
      const recommendation = recommendFleet(this.pendingConfig());
      this.element<HTMLInputElement>('patrol-fleet').value = String(recommendation.count);
      this.text('patrol-config-note', 'Recommended fleet selected. Apply and reset to use it.');
      this.updateRecommendation();
    }, options);
    this.element('patrol-randomize-population').addEventListener('click', () => {
      const seedInput = this.element<HTMLInputElement>('patrol-population-seed');
      const currentSeed = Number(seedInput.value);
      const nextSeed = Math.floor(Math.random() * 2147483647) + 1;
      seedInput.value = String(nextSeed === currentSeed ? nextSeed % 2147483647 + 1 : nextSeed);
      this.text('patrol-config-note', 'New population seed staged. Apply and reset to use it.');
    }, options);
    this.element<HTMLInputElement>('patrol-population-layer').addEventListener('change', (event) => {
      this.populationLayer = (event.target as HTMLInputElement).checked;
      this.drawMap(this.system.snapshot());
    }, options);
    this.element<HTMLSelectElement>('patrol-speed').addEventListener('change', (event) => {
      this.speed = Number((event.target as HTMLSelectElement).value);
      this.refresh();
    }, options);
    this.element('patrol-fleet-cards').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-patrol-action]');
      if (!button || button.disabled) return;
      const id = Number(button.closest<HTMLElement>('[data-drone-id]')?.dataset.droneId);
      const action = button.dataset.patrolAction;
      if (action === 'restore') this.system.restoreDrone(id);
      else this.system.injectFault(id, action === 'fail' ? 'malfunction' : 'deviation');
      this.refresh();
    }, options);
    window.addEventListener('blur', () => this.pause('Window lost focus'), options);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause('Browser tab hidden');
    }, options);
  }

  private pendingConfig(): PatrolConfig {
    const numberValue = (id: string, fallback: number, minimum: number, maximum: number): number => {
      const value = this.element<HTMLInputElement>(id).valueAsNumber;
      return Math.min(maximum, Math.max(minimum, Math.round(Number.isFinite(value) ? value : fallback)));
    };
    return {
      coverageTarget: Math.min(100, Math.max(70, Number(this.element<HTMLInputElement>('patrol-target').value) || PATROL_DEFAULTS.coverageTarget)),
      revisitSeconds: Math.min(300, Math.max(30, Number(this.element<HTMLInputElement>('patrol-window').value) || PATROL_DEFAULTS.revisitSeconds)),
      fleetSize: Math.min(PATROL_LIMITS.maxDrones, Math.max(1, Number(this.element<HTMLInputElement>('patrol-fleet').value) || PATROL_DEFAULTS.fleetSize)),
      populationCount: numberValue('patrol-population', PATROL_DEFAULTS.populationCount, 0, 50000),
      populationSeed: numberValue('patrol-population-seed', PATROL_DEFAULTS.populationSeed, 1, 2147483647),
      crowdedRevisitSeconds: numberValue('patrol-crowded-window', PATROL_DEFAULTS.crowdedRevisitSeconds, 1, 300),
      crowdedCellPopulation: numberValue('patrol-crowded-threshold', PATROL_DEFAULTS.crowdedCellPopulation, 1, 1000),
    };
  }

  private reset(config?: PatrolConfig): void {
    this.running = false;
    this.started = false;
    this.pauseReason = '';
    this.system.reset(config ?? this.system.snapshot().config);
    const applied = this.system.snapshot().config;
    const fields: [string, keyof PatrolConfig][] = [
      ['patrol-target', 'coverageTarget'], ['patrol-window', 'revisitSeconds'], ['patrol-fleet', 'fleetSize'],
      ['patrol-population', 'populationCount'], ['patrol-population-seed', 'populationSeed'],
      ['patrol-crowded-window', 'crowdedRevisitSeconds'], ['patrol-crowded-threshold', 'crowdedCellPopulation'],
    ];
    for (const [id, key] of fields) {
      this.element<HTMLInputElement>(id).value = String(applied[key]);
    }
    this.updateRecommendation();
    this.text('patrol-config-note', 'Mission reset using applied parameters. Start patrol when ready.');
    this.lastEventId = -1;
    this.element('patrol-log').replaceChildren();
    this.refresh();
  }

  private updateRecommendation(): void {
    const recommendation = recommendFleet(this.pendingConfig());
    this.text('patrol-recommended', recommendation.achievable ? `Area-only minimum: ${recommendation.count} aircraft` : `Area target exceeds ${PATROL_LIMITS.maxDrones}-aircraft estimate`);
    this.text('patrol-recommendation-note', recommendation.achievable
      ? `Estimate within this route family: ${recommendation.estimatedCoverage.toFixed(1)}% fresh area. Population targets are not included and may be unmet.`
      : `Best modeled area coverage: ${recommendation.estimatedCoverage.toFixed(1)}%. Increase the area revisit window or lower its target. Population targets are not included.`);
  }

  private refresh(): void {
    if (this.disposed) return;
    const snapshot = this.system.snapshot();
    const pending = snapshot.drones.some((drone) => drone.status === 'unresponsive' || drone.status === 'deviating');
    const insufficient = snapshot.activeCount < snapshot.recommendedFleet.count || snapshot.estimatedCoverage + 0.01 < snapshot.config.coverageTarget;
    const population = snapshot.population;
    const populationGaps = population.totalPeople > population.onTimePeople;
    const status = !this.started ? 'Ready to start' : !this.running
      ? insufficient ? 'Paused · degraded fleet' : 'Patrol paused'
      : snapshot.activeCount === 0 ? 'Degraded · no healthy drones' : pending ? 'Anomaly detected · checking health'
        : insufficient ? 'Degraded · area target at risk' : snapshot.coverage >= snapshot.config.coverageTarget
          ? populationGaps ? 'Area target met · population gaps' : 'Patrol active · area target met' : 'Patrol active · building coverage';
    this.text('patrol-start', this.running ? 'Pause patrol' : this.started ? 'Resume patrol' : 'Start patrol');
    this.text('patrol-status', status);
    this.container.classList.toggle('patrol-running', this.running);
    this.container.classList.toggle('patrol-degraded', insufficient || pending || this.started && populationGaps);
    this.text('patrol-coverage', `${snapshot.coverage.toFixed(1)}%`);
    this.text('patrol-coverage-caption', `${snapshot.config.coverageTarget}% target · rolling ${snapshot.config.revisitSeconds} s`);
    this.element('patrol-coverage-fill').style.width = `${snapshot.coverage}%`;
    this.element('patrol-target-tick').style.left = `${snapshot.config.coverageTarget}%`;
    this.text('patrol-active-count', `${snapshot.activeCount} / ${snapshot.drones.length}`);
    this.text('patrol-fleet-caption', `${snapshot.recommendedFleet.count} estimated minimum · area target only`);
    this.text('patrol-revisit', duration(snapshot.predictedRevisitSeconds));
    this.text('patrol-time', elapsedTime(snapshot.time));
    this.text('patrol-clock-caption', this.running ? `${this.speed}× speed · simulated time` : this.pauseReason || 'Paused · simulated time');
    this.text('patrol-revision', String(snapshot.revision));
    this.text('patrol-estimate', `${snapshot.estimatedCoverage.toFixed(1)}%`);
    this.text('patrol-ever-covered', `${snapshot.everCovered.toFixed(1)}%`);
    const fresh = snapshot.cells.filter((cell) => cell.lastVisited !== null && snapshot.time - cell.lastVisited <= snapshot.config.revisitSeconds).length;
    const never = snapshot.cells.filter((cell) => cell.lastVisited === null).length;
    this.text('patrol-cell-summary', `${fresh} fresh · ${snapshot.cells.length - fresh - never} stale · ${never} never scanned`);
    this.text('patrol-oldest', snapshot.maxAge === null ? 'Awaiting first scan' : `Oldest scan ${Math.floor(snapshot.maxAge)} s ago`);
    this.text('patrol-people-fresh', populationPercent(population.onTimeCoverage));
    this.text('patrol-people-visible', populationPercent(population.inViewCoverage));
    this.text('patrol-population-age', population.meanAgeSeconds === null ? 'N/A' : `${population.meanAgeSeconds.toFixed(1)} s`);
    this.text('patrol-population-cost', population.normalizedGapCost === null ? 'N/A' : population.normalizedGapCost.toFixed(2));
    this.text('patrol-population-summary', `${population.totalPeople.toLocaleString('en-US')} people · seed ${snapshot.config.populationSeed} · ${population.unseenPeople.toLocaleString('en-US')} never observed · ${population.hotspotOnTimeCells} / ${population.hotspotCells} crowded cells on time`);
    this.text('patrol-population-targets', `Crowded: ≥${snapshot.config.crowdedCellPopulation} people per cell → revisit within ${snapshot.config.crowdedRevisitSeconds} s. Quieter cells scale gradually up to ${snapshot.config.revisitSeconds} s for empty cells. ${population.totalPeople === 0 ? 'No population: people-based metrics are not applicable.' : 'These service metrics are separate from the geographic coverage target.'}`);
    const areaHealth = snapshot.activeCount === 0
      ? 'No healthy aircraft remain. Restore an aircraft to rebuild the patrol plan.'
      : pending ? `An aircraft is off plan. The monitor waits ${PATROL_LIMITS.detectionSeconds} simulated seconds after a missing heartbeat or sustained route deviation before excluding it and redistributing work. Resume if paused.`
        : insufficient ? 'Estimated healthy fleet capacity is below the area target. Remaining aircraft continue scanning; restore aircraft or revise the mission parameters.'
          : snapshot.coverage >= snapshot.config.coverageTarget ? 'Fresh area coverage meets its target. Aircraft keep revisiting their assigned areas.'
            : 'The fleet is building fresh area coverage. Previously scanned cells can become stale.';
    const populationHealth = populationGaps
      ? ` Population revisit targets are currently unmet for ${(population.totalPeople - population.onTimePeople).toLocaleString('en-US')} people. Uniform routes do not prioritize crowded cells.`
      : population.totalPeople > 0 ? ' Population revisit targets are currently met; shorter gaps remain preferable.' : ' No population configured.';
    this.text('patrol-health', areaHealth + populationHealth);
    this.updateFleet(snapshot.drones);
    const newest = snapshot.events[snapshot.events.length - 1]?.id ?? -1;
    if (newest !== this.lastEventId || !this.element('patrol-log').childElementCount) {
      const log = this.element<HTMLOListElement>('patrol-log');
      log.replaceChildren();
      for (const event of snapshot.events.slice(-8).reverse()) {
        const entry = document.createElement('li');
        const timestamp = document.createElement('time');
        timestamp.textContent = elapsedTime(event.time);
        const message = document.createElement('span');
        message.textContent = event.message;
        entry.append(timestamp, message);
        log.append(entry);
      }
      if (!snapshot.events.length) {
        const entry = document.createElement('li');
        entry.textContent = 'Mission prepared. Start patrol to begin scanning.';
        log.append(entry);
      }
      this.lastEventId = newest;
    }
    this.drawMap(snapshot);
  }

  private updateFleet(drones: PatrolDrone[]): void {
    const cards = this.element('patrol-fleet-cards');
    if (this.cardCount !== drones.length) {
      cards.innerHTML = drones.map((drone) => `<article class="patrol-drone-card" data-drone-id="${drone.id}" style="--drone-color:${drone.color}"><div class="patrol-drone-heading"><span class="patrol-drone-symbol" aria-hidden="true">✣</span><div><h3>Drone ${String(drone.id).padStart(2, '0')}</h3><span class="patrol-drone-lane"></span></div><span class="patrol-drone-status"></span></div><div class="patrol-drone-assignment"></div><div class="patrol-drone-actions"><button type="button" data-patrol-action="fail" aria-label="Fail drone ${drone.id}">Fail drone ${drone.id}</button><button type="button" data-patrol-action="divert" aria-label="Divert drone ${drone.id}">Divert drone ${drone.id}</button><button type="button" data-patrol-action="restore" aria-label="Restore drone ${drone.id}">Restore drone ${drone.id}</button></div></article>`).join('');
      this.cardCount = drones.length;
    }
    for (const drone of drones) {
      const card = cards.querySelector<HTMLElement>(`[data-drone-id="${drone.id}"]`)!;
      card.dataset.status = drone.status;
      card.querySelector<HTMLElement>('.patrol-drone-status')!.textContent = drone.status.charAt(0).toUpperCase() + drone.status.slice(1);
      card.querySelector<HTMLElement>('.patrol-drone-lane')!.textContent = `${drone.position.y.toFixed(0)} m altitude lane`;
      card.querySelector<HTMLElement>('.patrol-drone-assignment')!.textContent = drone.status === 'offline' ? 'Excluded from plan · awaiting restoration' : `${drone.assignedCellIds.length} assigned cells · ${duration(drone.cycleSeconds)} route cycle`;
      for (const button of card.querySelectorAll<HTMLButtonElement>('[data-patrol-action]')) {
        button.disabled = button.dataset.patrolAction === 'restore' ? drone.status === 'patrolling' : drone.status !== 'patrolling';
      }
    }
  }

  private resize(): void {
    if (this.disposed) return;
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawMap(this.system.snapshot());
  }

  private drawMap(snapshot: PatrolSnapshot): void {
    const context = this.context;
    const map = FLIGHT_MAPS.nyc;
    const scale = Math.min(this.width - 48, this.height - 102) / (map.radius * 2);
    if (scale <= 0) return;
    const centerX = this.width / 2;
    const centerY = this.height / 2 + 7;
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = '#edf1e9';
    context.fillRect(0, 0, this.width, this.height);
    context.save();
    context.translate(centerX, centerY);
    context.scale(scale, scale);
    context.beginPath();
    context.arc(0, 0, map.radius, 0, Math.PI * 2);
    context.fillStyle = '#dfe9e1';
    context.fill();
    context.save();
    context.clip();
    context.fillStyle = '#f1f1e8';
    context.fillRect(-283, -283, 566, 566);
    context.strokeStyle = '#d5dbcf';
    context.lineWidth = 16;
    for (let street = -4; street <= 4; street += 1) {
      context.beginPath();
      context.moveTo(street * CITY_BLOCK_SIZE, -277);
      context.lineTo(street * CITY_BLOCK_SIZE, 277);
      context.moveTo(-277, street * CITY_BLOCK_SIZE);
      context.lineTo(277, street * CITY_BLOCK_SIZE);
      context.stroke();
    }
    context.fillStyle = '#b8cba4';
    context.fillRect(CITY_PARK.x - CITY_PARK.width / 2, CITY_PARK.z - CITY_PARK.depth / 2, CITY_PARK.width, CITY_PARK.depth);
    const dronesById = new Map(snapshot.drones.map((drone) => [drone.id, drone]));
    for (const cell of snapshot.cells) {
      const owner = cell.assignedDroneId === null ? undefined : dronesById.get(cell.assignedDroneId);
      const fresh = cell.lastVisited !== null && snapshot.time - cell.lastVisited <= snapshot.config.revisitSeconds;
      const stale = cell.lastVisited !== null && !fresh;
      context.fillStyle = stale ? '#cb9256' : owner?.color ?? '#9b9e94';
      context.globalAlpha = fresh ? 0.31 : stale ? 0.33 : 0.075;
      context.fillRect(cell.position.x - PATROL_LIMITS.cellSize / 2 + 1, cell.position.z - PATROL_LIMITS.cellSize / 2 + 1, PATROL_LIMITS.cellSize - 2, PATROL_LIMITS.cellSize - 2);
      if (!fresh) {
        context.globalAlpha = stale ? 0.55 : 0.35;
        context.beginPath();
        context.arc(cell.position.x, cell.position.z, 1.1 / scale, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.globalAlpha = 1;
    for (const building of map.buildings) {
      const base = building.tiers[0];
      context.fillStyle = building.style === 'glass' ? '#819a9680' : '#9a9b8980';
      context.fillRect(building.x - base.width / 2, building.z - base.depth / 2, base.width, base.depth);
      context.lineWidth = 0.6 / scale;
      context.strokeStyle = building.style === 'landmark' ? '#68745e' : '#ffffff8c';
      context.strokeRect(building.x - base.width / 2, building.z - base.depth / 2, base.width, base.depth);
    }
    if (this.populationLayer) {
      const maximumPopulation = Math.max(1, ...snapshot.cells.map((cell) => cell.population));
      context.save();
      context.fillStyle = '#8846ab';
      context.strokeStyle = '#6c3287';
      context.lineWidth = 1 / scale;
      for (const cell of snapshot.cells) {
        if (cell.population === 0) continue;
        const intensity = Math.sqrt(cell.population / maximumPopulation);
        const radius = PATROL_LIMITS.cellSize * (0.045 + intensity * 0.31);
        context.beginPath();
        context.arc(cell.position.x, cell.position.z, radius, 0, Math.PI * 2);
        context.globalAlpha = 0.24 + intensity * 0.3;
        context.fill();
        if (cell.population >= snapshot.config.crowdedCellPopulation) {
          context.globalAlpha = 0.85;
          context.stroke();
        }
      }
      context.restore();
    }
    for (const drone of snapshot.drones) {
      if (drone.status === 'offline' || !drone.route.length) continue;
      context.beginPath();
      drone.route.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.z) : context.lineTo(point.x, point.z));
      context.closePath();
      context.strokeStyle = drone.color;
      context.lineWidth = 1.1 / scale;
      context.globalAlpha = drone.status === 'patrolling' ? 0.54 : 0.3;
      context.stroke();
      const command = drone.route[drone.routeIndex];
      if (command) {
        context.beginPath();
        context.moveTo(drone.position.x, drone.position.z);
        context.lineTo(command.x, command.z);
        context.lineWidth = 1.6 / scale;
        context.globalAlpha = 0.85;
        context.setLineDash([4 / scale, 3 / scale]);
        context.stroke();
        context.setLineDash([]);
      }
      if (drone.status === 'patrolling') {
        context.beginPath();
        context.arc(drone.position.x, drone.position.z, PATROL_LIMITS.sensorRadius, 0, Math.PI * 2);
        context.fillStyle = drone.color;
        context.globalAlpha = 0.11;
        context.fill();
        context.globalAlpha = 0.55;
        context.lineWidth = 1 / scale;
        context.setLineDash([3 / scale, 3 / scale]);
        context.stroke();
        context.setLineDash([]);
      }
    }
    context.globalAlpha = 1;
    context.restore();
    context.beginPath();
    context.arc(0, 0, map.radius, 0, Math.PI * 2);
    context.strokeStyle = '#8ba186';
    context.lineWidth = 1 / scale;
    context.setLineDash([4 / scale, 5 / scale]);
    context.stroke();
    context.setLineDash([]);
    context.restore();
    for (const drone of snapshot.drones) {
      const horizontal = centerX + drone.position.x * scale;
      const depth = centerY + drone.position.z * scale;
      context.save();
      context.translate(horizontal, depth);
      context.fillStyle = drone.status === 'offline' ? '#93968c' : drone.color;
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.shadowColor = '#253a3233';
      context.shadowBlur = 6;
      context.beginPath();
      context.arc(0, 0, 9, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.shadowBlur = 0;
      context.fillStyle = '#ffffff';
      context.font = '600 9px "DM Sans", sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(drone.id), 0, 0.5);
      if (drone.status !== 'patrolling' && drone.status !== 'offline') {
        context.fillStyle = '#ba7749';
        context.beginPath();
        context.arc(8, -8, 4, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    }
    this.element<HTMLElement>('patrol-map-scale').style.setProperty('--scale-width', `${100 * scale}px`);
  }
}
