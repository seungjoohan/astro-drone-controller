import { createCheckpoint, parseCheckpoint, serializeCheckpoint } from './patrol-learning-checkpoint';
import { DEFAULT_ENVIRONMENT, environmentKey } from './patrol-environment';
import type { PatrolEnvironment } from './patrol-environment';
import type { EvaluationMetrics, LearningCandidate, LearningCheckpoint, LearningProgress, LearningResponse, LearningSettings } from './patrol-learning-types';
import type { PatrolConfig } from './patrol-types';
import './patrol-learning.css';

const STORAGE_KEY = 'astro-patrol-learning-results-v2';
const LEGACY_STORAGE_KEY = 'astro-patrol-learning-results-v1';
const CONFIG_KEYS: (keyof PatrolConfig)[] = ['coverageTarget', 'revisitSeconds', 'populationCount', 'populationSeed', 'crowdedRevisitSeconds', 'crowdedCellPopulation'];

interface LearningPanelCallbacks {
  getConfig(): PatrolConfig;
  getEnvironment(): PatrolEnvironment;
  applyCandidate(candidate: LearningCandidate): void;
}

function initialProgress(): LearningProgress {
  return {
    status: 'idle', generation: 0, evaluations: 0, elapsedSeconds: 0,
    testedFleetSizes: [], candidates: [], frontierIds: [], recommendedId: null,
    message: 'No training started. Your visible mission is unchanged.',
  };
}

function percent(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(1)}%`;
}

function gap(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(2);
}

function matchingConfig(first: PatrolConfig, second: PatrolConfig): boolean {
  return CONFIG_KEYS.every(key => first[key] === second[key]);
}

function testedFeasible(metrics: EvaluationMetrics | null): boolean {
  return metrics !== null && metrics.geographicFeasible && metrics.hotspotFeasible && metrics.neverObservedPeople === 0
    && (metrics.energyViolations ?? 0) === 0 && (metrics.reserveViolations ?? 0) === 0 && (metrics.feasibleScenarioFraction ?? 1) >= 1 - 1e-8;
}

export class PatrolLearningPanel {
  private readonly events = new AbortController();
  private worker: Worker | null = null;
  private progress = initialProgress();
  private settings: LearningSettings | null = null;
  private checkpoint: LearningCheckpoint | null = null;
  private trusted = false;
  private restored = false;
  private pendingPause = false;
  private pendingResume = false;
  private disposed = false;
  private lastSavedSeconds = -Infinity;
  private notice = '';

  constructor(private readonly container: HTMLElement, private readonly callbacks: LearningPanelCallbacks) {
    container.innerHTML = `
      <div class="patrol-learning-heading"><div><div class="eyebrow">LOCAL EXPERIMENT / NO AUTOMATIC PROMOTION</div><h2 id="patrol-learning-title">Routing laboratory<span>.</span></h2><p>Search fleet size and population-aware routing together. Your mission stays in your hands.</p></div><span class="patrol-learning-badge">1–8 AIRCRAFT</span></div>
      <div class="patrol-learning-intro"><strong>Shorter observation gaps. Broader tests.</strong><p>A seeded parameter search runs isolated trials in a background worker. Choose the current mission or a diverse synthetic environment suite. Coverage requirements are never learned away, and training cannot alter the live mission. A strong result on this finite suite is not a universally optimal strategy.</p></div>
      <form id="patrol-learning-form" class="patrol-learning-form">
        <div class="patrol-learning-profile-field"><label for="patrol-learning-profile">Evaluation environments</label><select id="patrol-learning-profile"><option value="diverse" selected>Diverse synthetic environments</option><option value="current">Current mission only</option></select></div>
        <div><label for="patrol-learning-scenarios">Training environments</label><input id="patrol-learning-scenarios" type="number" min="3" max="12" step="1" required value="6"></div>
        <div><label for="patrol-learning-seed">Optimizer seed</label><input id="patrol-learning-seed" type="number" min="1" max="2147483647" step="1" required value="42"></div>
        <div><label for="patrol-learning-generations">Search generations</label><input id="patrol-learning-generations" type="number" min="1" max="20" step="1" required value="2"></div>
        <div><label for="patrol-learning-budget">Compute budget (seconds)</label><input id="patrol-learning-budget" type="number" min="15" max="600" step="1" required value="120"></div>
        <div class="patrol-learning-actions"><button id="patrol-learning-start" class="patrol-primary" type="submit">Start learning</button><button id="patrol-learning-pause" class="patrol-secondary" type="button" disabled>Pause learning</button><button id="patrol-learning-resume" class="patrol-secondary" type="button" disabled>Resume learning</button><button id="patrol-learning-cancel" class="patrol-secondary" type="button" disabled>Cancel learning</button></div>
      </form>
      <p id="patrol-learning-config" class="patrol-learning-config"></p>
      <div class="patrol-learning-monitor"><div><strong id="patrol-learning-status" role="status">Ready for an experiment</strong><span id="patrol-learning-counts"></span></div><div class="patrol-learning-counter-line"><span>Evaluations <strong id="patrol-learning-evaluations">0</strong></span><span>Tested fleets <strong id="patrol-learning-tested-fleets">None</strong></span></div><progress id="patrol-learning-progress" max="120" value="0" aria-label="Learning compute budget used"></progress><p id="patrol-learning-message"></p></div>
      <p id="patrol-learning-recommendation" class="patrol-learning-recommendation"></p>
      <p class="patrol-learning-caption">Training and held-out scores are separate. Area is minimum rolling freshness after warm-up; people is mean on-time coverage; gap is mean relative observation cost (lower is better). Energy, charge and violation totals include warm-up. Generalization summaries include per-environment and worst-case results, not only averages. One-drone-loss results never certify healthy-operation recommendations.</p>
      <div id="patrol-learning-results" class="patrol-learning-results" aria-label="Results for fleet sizes one through eight"></div>
      <div class="patrol-learning-storage"><div><button id="patrol-learning-export" type="button" class="patrol-secondary" disabled>Export results</button><button id="patrol-learning-import" type="button" class="patrol-secondary">Import results</button><input id="patrol-learning-import-file" type="file" accept="application/json,.json" hidden aria-label="Import learning results file"></div><p>Results are saved locally, not an exact optimizer resume point. Imported or restored results are untrusted, read-only records; run a new experiment before applying a strategy.</p></div>
      <p id="patrol-learning-notice" class="patrol-learning-notice" role="status"></p>
      <p class="patrol-learning-limitations">Pilot evaluation only: finite synthetic environments, short seeded scenarios and sampled overhead camera coverage without building occlusion. Battery endurance and charging are simplified simulation constraints, not validated aircraft physics. Strict service checks are screening rules, not real-world safety guarantees. Unmeasured fleets remain incomplete when the budget ends.</p>`;
    this.bindEvents();
    this.restore();
    this.render();
  }

  notifyConfigChanged(): void {
    if (!this.disposed) this.render();
  }

  pause(reason = 'Paused by operator'): void {
    if (!this.worker || this.progress.status !== 'running' || this.pendingPause) return;
    this.pendingPause = true;
    this.notice = `${reason}. Resume learning explicitly when ready.`;
    this.worker.postMessage({ type: 'pause' });
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.events.abort();
  }

  private element<ElementType extends HTMLElement = HTMLElement>(id: string): ElementType {
    return this.container.querySelector<ElementType>(`#${id}`)!;
  }

  private bindEvents(): void {
    const options = { signal: this.events.signal };
    this.element<HTMLFormElement>('patrol-learning-form').addEventListener('submit', event => {
      event.preventDefault();
      this.start();
    }, options);
    this.element('patrol-learning-pause').addEventListener('click', () => this.pause(), options);
    this.element('patrol-learning-resume').addEventListener('click', () => {
      if (!this.worker || this.progress.status !== 'paused' || this.pendingResume) return;
      this.pendingResume = true;
      this.notice = '';
      this.worker.postMessage({ type: 'resume' });
      this.render();
    }, options);
    this.element('patrol-learning-cancel').addEventListener('click', () => this.cancel(), options);
    this.element('patrol-learning-profile').addEventListener('change', () => this.render(), options);
    this.element('patrol-learning-export').addEventListener('click', () => this.export(), options);
    this.element('patrol-learning-import').addEventListener('click', () => this.element<HTMLInputElement>('patrol-learning-import-file').click(), options);
    this.element<HTMLInputElement>('patrol-learning-import-file').addEventListener('change', () => void this.import(), options);
    this.element('patrol-learning-results').addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-learning-apply]');
      if (!button || button.disabled || !this.trusted || this.configIsStale()) return;
      const candidate = this.progress.candidates.find(result => result.id === button.dataset.learningApply);
      if (!candidate?.validation) return;
      this.callbacks.applyCandidate(structuredClone(candidate));
      this.notice = `${candidate.fleetSize}-aircraft ${candidate.strategy.kind} strategy loaded into a new, paused test mission. ${testedFeasible(candidate.validation) ? 'Passed the tested healthy-operation checks; no general guarantee.' : 'EXPERIMENTAL: tested requirements are unmet.'} ${this.settings?.profile === 'diverse' ? 'Suite results do not certify the current environment.' : ''} Start patrol explicitly when ready.`;
      this.render();
    }, options);
    window.addEventListener('blur', () => this.pause('Window lost focus'), options);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause('Browser tab hidden');
    }, options);
  }

  private start(): void {
    if (this.worker || this.disposed || !this.element<HTMLFormElement>('patrol-learning-form').reportValidity()) return;
    this.settings = {
      config: { ...this.callbacks.getConfig() },
      environment: structuredClone(this.callbacks.getEnvironment()),
      profile: this.element<HTMLSelectElement>('patrol-learning-profile').value === 'current' ? 'current' : 'diverse',
      scenarioCount: this.element<HTMLInputElement>('patrol-learning-scenarios').valueAsNumber,
      optimizerSeed: this.element<HTMLInputElement>('patrol-learning-seed').valueAsNumber,
      generations: this.element<HTMLInputElement>('patrol-learning-generations').valueAsNumber,
      budgetSeconds: this.element<HTMLInputElement>('patrol-learning-budget').valueAsNumber,
    };
    this.progress = { ...initialProgress(), status: 'running', message: 'Preparing isolated trials for fleet sizes 1–8…' };
    this.checkpoint = null;
    this.trusted = true;
    this.restored = false;
    this.pendingPause = false;
    this.pendingResume = false;
    this.notice = '';
    this.lastSavedSeconds = -Infinity;
    try {
      const worker = new Worker(new URL('./patrol-training.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<LearningResponse>) => {
        if (this.worker === worker && !this.disposed) this.receive(event.data);
      };
      worker.onerror = event => {
        if (this.worker !== worker || this.disposed) return;
        event.preventDefault();
        this.fail('The learning worker could not continue. Your visible mission is unchanged. Try a new experiment or a smaller budget.');
      };
      worker.onmessageerror = () => {
        if (this.worker === worker && !this.disposed) this.fail('The learning worker returned an unreadable result. Your visible mission is unchanged.');
      };
      worker.postMessage({ type: 'start', settings: this.settings });
    } catch {
      this.fail('This browser could not start the learning worker. Your visible mission is unchanged.');
    }
    this.render();
  }

  private receive(response: LearningResponse): void {
    if (response.type === 'error') {
      this.fail(response.message);
      return;
    }
    if (response.type === 'checkpoint') {
      this.checkpoint = response.checkpoint;
      this.save();
      this.render();
      return;
    }
    this.progress = response.progress;
    if (this.progress.status === 'paused') this.pendingPause = false;
    if (this.progress.status === 'running') this.pendingResume = false;
    const stopped = ['completed', 'cancelled', 'error'].includes(this.progress.status);
    if (stopped) {
      this.worker?.terminate();
      this.worker = null;
      this.pendingPause = false;
      this.pendingResume = false;
    }
    if (this.settings && (stopped || this.progress.status === 'paused' || this.progress.elapsedSeconds - this.lastSavedSeconds >= 2)) {
      this.capture();
    }
    this.render();
  }

  private cancel(): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel' });
    this.worker.terminate();
    this.worker = null;
    this.progress = { ...this.progress, status: 'cancelled', message: 'Learning cancelled. Completed evaluations remain available; the live mission is unchanged.' };
    this.pendingPause = false;
    this.pendingResume = false;
    this.capture();
    this.render();
  }

  private fail(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.progress = { ...this.progress, status: 'error', message };
    this.pendingPause = false;
    this.pendingResume = false;
    this.capture();
    this.render();
  }

  private capture(): void {
    if (!this.settings) return;
    try {
      this.checkpoint = createCheckpoint(this.settings, this.progress);
      this.lastSavedSeconds = this.progress.elapsedSeconds;
      this.save();
    } catch {
      this.notice = 'Results could not be saved. The displayed mission is unchanged.';
    }
  }

  private save(): void {
    if (!this.checkpoint) return;
    try {
      localStorage.setItem(STORAGE_KEY, serializeCheckpoint(this.checkpoint));
    } catch {
      this.notice = 'Browser storage is unavailable or full. Export results to keep a copy.';
    }
  }

  private restore(): void {
    try {
      let storedRecordFound = false;
      for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
        const stored = localStorage.getItem(key);
        if (!stored) continue;
        storedRecordFound = true;
        const checkpoint = parseCheckpoint(stored);
        if (!checkpoint) continue;
        this.loadReadOnly(checkpoint);
        this.notice = `Saved ${checkpoint.version === 1 ? 'legacy ' : ''}results restored as an untrusted, read-only record. Start a new experiment to retest strategies; training has not resumed. The original legacy storage record is never overwritten by new experiments.`;
        return;
      }
      if (storedRecordFound) this.notice = 'Saved results were invalid or incompatible and were not loaded.';
    } catch {
      this.notice = 'Local result storage is unavailable. Learning can still run in this session.';
    }
  }

  private loadReadOnly(checkpoint: LearningCheckpoint): void {
    this.checkpoint = checkpoint;
    this.settings = checkpoint.settings;
    this.progress = checkpoint.progress;
    this.trusted = false;
    this.restored = true;
    this.pendingPause = false;
    this.pendingResume = false;
    this.element<HTMLInputElement>('patrol-learning-seed').value = String(checkpoint.settings.optimizerSeed);
    this.element<HTMLInputElement>('patrol-learning-generations').value = String(checkpoint.settings.generations);
    this.element<HTMLInputElement>('patrol-learning-budget').value = String(checkpoint.settings.budgetSeconds);
    this.element<HTMLSelectElement>('patrol-learning-profile').value = checkpoint.settings.profile ?? 'current';
    this.element<HTMLInputElement>('patrol-learning-scenarios').value = String(checkpoint.settings.scenarioCount ?? 6);
  }

  private export(): void {
    if (this.trusted && this.settings) this.capture();
    if (!this.checkpoint) return;
    try {
      const blob = new Blob([serializeCheckpoint(this.checkpoint)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `astro-patrol-learning-v${this.checkpoint.version}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.notice = 'Results exported. Importing this file will open a read-only record, not resume training.';
    } catch {
      this.notice = 'Results could not be exported. Try again after the current evaluation finishes.';
    }
    this.render();
  }

  private async import(): Promise<void> {
    const input = this.element<HTMLInputElement>('patrol-learning-import-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.worker || this.disposed) return;
    try {
      if (file.size > 2_000_000) throw new Error('File is too large.');
      const checkpoint = parseCheckpoint(await file.text());
      if (this.disposed) return;
      if (this.worker) {
        this.notice = 'Cancel learning before importing results.';
      } else if (!checkpoint) {
        this.notice = 'Import rejected: results are invalid or incompatible. Existing results and the mission are unchanged.';
      } else {
        this.loadReadOnly(checkpoint);
        this.save();
        this.notice = 'Imported results are untrusted and read-only. Start a new experiment before applying any strategy. Your visible mission is unchanged.';
      }
    } catch {
      this.notice = 'Import rejected: choose a compatible JSON results file under 2 MB. Your visible mission is unchanged.';
    }
    if (!this.disposed) this.render();
  }

  private configIsStale(): boolean {
    return this.settings !== null && (!matchingConfig(this.settings.config, this.callbacks.getConfig())
      || environmentKey(this.settings.environment ?? DEFAULT_ENVIRONMENT) !== environmentKey(this.callbacks.getEnvironment()));
  }

  private render(): void {
    if (this.disposed) return;
    const busy = this.worker !== null;
    const stale = this.configIsStale();
    this.element<HTMLButtonElement>('patrol-learning-start').disabled = busy;
    this.element<HTMLButtonElement>('patrol-learning-pause').disabled = !busy || this.progress.status !== 'running' || this.pendingPause;
    this.element<HTMLButtonElement>('patrol-learning-resume').disabled = !busy || this.progress.status !== 'paused' || this.pendingResume;
    this.element<HTMLButtonElement>('patrol-learning-cancel').disabled = !busy;
    this.element<HTMLButtonElement>('patrol-learning-import').disabled = busy;
    this.element<HTMLButtonElement>('patrol-learning-export').disabled = !this.checkpoint;
    for (const id of ['patrol-learning-seed', 'patrol-learning-generations', 'patrol-learning-budget', 'patrol-learning-profile']) {
      this.element<HTMLInputElement | HTMLSelectElement>(id).disabled = busy;
    }
    this.element<HTMLInputElement>('patrol-learning-scenarios').disabled = busy || this.element<HTMLSelectElement>('patrol-learning-profile').value !== 'diverse';
    const config = this.settings?.config ?? this.callbacks.getConfig();
    const environment = this.settings?.environment ?? (this.settings ? DEFAULT_ENVIRONMENT : this.callbacks.getEnvironment());
    const profile = this.settings?.profile ?? (this.settings ? 'current' : this.element<HTMLSelectElement>('patrol-learning-profile').value);
    const scenarioCount = this.settings?.scenarioCount ?? this.element<HTMLInputElement>('patrol-learning-scenarios').valueAsNumber;
    this.element('patrol-learning-config').textContent = `${this.settings ? 'Captured' : 'Next experiment uses applied'} mission: ${config.populationCount.toLocaleString('en-US')} people · population seed ${config.populationSeed} · ${config.coverageTarget}% area / ${config.revisitSeconds} s · crowded ${config.crowdedRevisitSeconds} s at ${config.crowdedCellPopulation} people/cell. ${environment.id} · ${environment.maxSpeed} m/s · ${environment.batteryEnabled ? `${environment.enduranceSeconds} s endurance at max speed / ${environment.rechargeSeconds} s recharge / ${environment.chargingPads} pads` : 'unlimited endurance'}. ${profile === 'diverse' ? `Diverse suite: ${Number.isFinite(scenarioCount) ? scenarioCount : 6} training environments, a finite pilot rather than a universal guarantee. Geometry, population and aircraft constraints vary in isolated trials; the captured mission is unchanged.` : 'Current-mission profile: held-out population seeds, fixed environment.'} ${stale ? 'MISSION CHANGED: these results cannot be applied. Start a new experiment for the new requirements or environment.' : 'Unsaved mission form edits are not used.'}`;
    this.element('patrol-learning-config').classList.toggle('patrol-learning-stale', stale);
    const states = { idle: 'Ready for an experiment', running: 'Running · learning in background', paused: 'Paused · learning', completed: 'Completed · experiment finished', cancelled: 'Cancelled · learning stopped', error: 'Error · learning stopped' };
    this.element('patrol-learning-status').textContent = this.restored ? 'Read-only results · untrusted' : this.pendingPause ? 'Pausing learning…' : this.pendingResume ? 'Resuming learning…' : states[this.progress.status];
    this.element('patrol-learning-counts').textContent = `Generation ${this.progress.generation} · ${this.progress.testedFleetSizes.length}/8 fleet sizes · ${this.progress.elapsedSeconds.toFixed(1)} s compute`;
    this.element('patrol-learning-evaluations').textContent = String(this.progress.evaluations);
    this.element('patrol-learning-tested-fleets').textContent = this.progress.testedFleetSizes.length ? [...this.progress.testedFleetSizes].sort((first, second) => first - second).join(', ') : 'None';
    const meter = this.element<HTMLProgressElement>('patrol-learning-progress');
    meter.max = this.settings?.budgetSeconds ?? 120;
    meter.value = Math.min(meter.max, this.progress.elapsedSeconds);
    this.element('patrol-learning-message').textContent = this.progress.message;
    const recommended = this.progress.candidates.find(candidate => candidate.id === this.progress.recommendedId);
    this.element('patrol-learning-recommendation').textContent = !this.trusted && this.checkpoint
      ? 'Read-only record. Imported scores and recommendation claims are not trusted or eligible for application.'
      : recommended
        ? `Smallest tested feasible fleet: ${recommended.fleetSize} aircraft. Meets the sampled healthy service and energy checks in this finite suite only. This is not a universally optimal fleet, a minimum-fleet proof or a failure-resilience guarantee.`
        : this.progress.candidates.length
          ? 'No tested strategy meets all strict held-out requirements yet. Experimental trials may still reveal useful trade-offs; targets are never relaxed automatically.'
          : 'No fleet recommendation yet. All eight fleet sizes remain eligible for the search.';
    this.element('patrol-learning-notice').textContent = this.notice;
    this.renderResults(stale);
  }

  private renderResults(stale: boolean): void {
    const results = this.element('patrol-learning-results');
    const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.learningApply : undefined;
    const focusedBaseline = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.learningBaseline : undefined;
    const openBaselines = new Set(Array.from(results.querySelectorAll<HTMLDetailsElement>('details.patrol-learning-baseline[open]')).map(details => details.closest<HTMLElement>('[data-learning-fleet]')?.dataset.learningFleet));
    const openCases = new Set(Array.from(results.querySelectorAll<HTMLDetailsElement>('details[data-learning-cases][open]')).map(details => details.dataset.learningCases));
    const cards = Array.from({ length: 8 }, (_unused, index) => {
      const fleetSize = index + 1;
      const fleetCandidates = this.progress.candidates.filter(result => result.fleetSize === fleetSize);
      const candidate = fleetCandidates.find(result => result.strategy.kind === 'adaptive') ?? fleetCandidates[0];
      const baseline = fleetCandidates.find(result => result.strategy.kind === 'uniform' && result.id !== candidate?.id);
      const card = document.createElement('article');
      card.className = 'patrol-learning-result';
      card.dataset.fleetSize = String(fleetSize);
      card.dataset.learningFleet = String(fleetSize);
      const heading = document.createElement('div');
      heading.className = 'patrol-learning-result-heading';
      const title = document.createElement('h3');
      title.textContent = `${fleetSize} aircraft`;
      const badge = document.createElement('span');
      const feasible = testedFeasible(candidate?.validation ?? null);
      badge.textContent = !candidate ? 'INCOMPLETE' : !this.trusted ? 'UNTRUSTED RECORD' : !candidate.validation ? 'TRAINING ONLY' : feasible ? 'TESTED FEASIBLE' : 'EXPERIMENTAL';
      card.dataset.resultState = !candidate ? 'incomplete' : !this.trusted ? 'untrusted' : feasible ? 'feasible' : 'experimental';
      heading.append(title, badge);
      card.append(heading);
      if (!candidate) {
        const empty = document.createElement('p');
        empty.className = 'patrol-learning-empty';
        empty.textContent = 'No completed evaluation. Not a failed or feasible fleet.';
        card.append(empty);
        return card;
      }
      const policy = document.createElement('p');
      policy.className = 'patrol-learning-policy';
      policy.textContent = `${candidate.strategy.kind === 'adaptive' ? `Adaptive population-aware policy · ${Math.round((candidate.strategy.parameters.speedFraction ?? 1) * 100)}% maximum speed` : 'Uniform route baseline'}${this.progress.frontierIds.includes(candidate.id) ? ' · fleet/service frontier' : ''}`;
      card.append(policy, this.metricBlock('Training', candidate.training, `${candidate.id}:training`), this.metricBlock('Held-out validation', candidate.validation, `${candidate.id}:validation`), this.metricBlock('One-drone loss', candidate.failure, `${candidate.id}:failure`));
      card.append(this.candidateAction(candidate, stale));
      if (baseline) {
        const comparison = document.createElement('details');
        comparison.className = 'patrol-learning-baseline';
        comparison.open = openBaselines.has(String(fleetSize));
        const summary = document.createElement('summary');
        summary.dataset.learningBaseline = String(fleetSize);
        summary.textContent = `Uniform paired baseline · validation gap ${baseline.validation ? gap(baseline.validation.gapCost) : 'pending'}`;
        comparison.append(summary, this.metricBlock('Baseline training', baseline.training, `${baseline.id}:training`), this.metricBlock('Baseline held-out validation', baseline.validation, `${baseline.id}:validation`), this.metricBlock('Baseline one-drone loss', baseline.failure, `${baseline.id}:failure`), this.candidateAction(baseline, stale));
        card.append(comparison);
      }
      return card;
    });
    results.replaceChildren(...cards);
    for (const details of results.querySelectorAll<HTMLDetailsElement>('details[data-learning-cases]')) details.open = openCases.has(details.dataset.learningCases);
    if (focused) {
      const buttons = results.querySelectorAll<HTMLButtonElement>('[data-learning-apply]');
      Array.from(buttons).find(button => button.dataset.learningApply === focused)?.focus({ preventScroll: true });
    } else if (focusedBaseline) {
      results.querySelector<HTMLElement>(`[data-learning-baseline="${focusedBaseline}"]`)?.focus({ preventScroll: true });
    }
  }

  private candidateAction(candidate: LearningCandidate, stale: boolean): HTMLButtonElement {
    const feasible = testedFeasible(candidate.validation);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'patrol-secondary';
    action.dataset.learningApply = candidate.id;
    action.dataset.learningKind = candidate.strategy.kind;
    action.textContent = feasible ? 'New test mission' : 'New experimental mission';
    action.setAttribute('aria-label', `Test ${candidate.fleetSize}-aircraft ${candidate.strategy.kind} strategy in a new mission`);
    action.disabled = !this.trusted || !candidate.validation || stale;
    action.title = !this.trusted ? 'Read-only record: run a new experiment first.' : !candidate.validation ? 'Held-out validation must finish first.' : stale ? 'Mission requirements have changed. Run a new experiment.' : 'Resets the live mission using this fleet and strategy, then leaves it paused.';
    return action;
  }

  private metricBlock(label: string, metrics: EvaluationMetrics | null, caseKey: string): HTMLElement {
    const block = document.createElement('div');
    block.className = 'patrol-learning-score';
    const title = document.createElement('strong');
    title.textContent = label;
    block.append(title);
    if (!metrics) {
      const pending = document.createElement('span');
      pending.textContent = 'Not evaluated';
      block.append(pending);
      return block;
    }
    const values = document.createElement('span');
    values.textContent = `Gap ${gap(metrics.gapCost)} · people ${percent(metrics.populationOnTime)} · area min ${percent(metrics.areaMinimum)}`;
    const details = document.createElement('small');
    details.textContent = `${metrics.scenarios} scenarios · dense audit min ${percent(metrics.auditAreaMinimum)} · hotspot on-time ${percent(metrics.hotspotOnTime)} · area check ${metrics.geographicFeasible ? 'pass' : 'unmet'} · hotspot check ${metrics.hotspotFeasible ? 'pass' : 'unmet'} · never observed ${metrics.neverObservedPeople.toLocaleString('en-US')} people`;
    block.append(values, details);
    if (metrics.feasibleScenarioFraction !== undefined || metrics.worstCaseGapCost !== undefined) {
      const tail = document.createElement('small');
      tail.dataset.generalizationSummary = caseKey;
      tail.textContent = `Feasible scenarios ${percent(metrics.feasibleScenarioFraction === undefined ? null : metrics.feasibleScenarioFraction * 100)} · worst-case gap ${gap(metrics.worstCaseGapCost ?? null)} · energy violations ${metrics.energyViolations ?? 0} · reserve violations ${metrics.reserveViolations ?? 0} · ${metrics.completedCharges ?? 0} charges · ${(metrics.energyUsed ?? 0).toFixed(2)} full-pack equivalents used`;
      block.append(tail);
    }
    if (metrics.scenarioResults?.length) {
      const cases = document.createElement('details');
      cases.className = 'patrol-learning-cases';
      cases.dataset.learningCases = caseKey;
      const summary = document.createElement('summary');
      summary.textContent = `Inspect ${metrics.scenarioResults.length} environment cases`;
      cases.append(summary);
      for (const scenario of metrics.scenarioResults) {
        const entry = document.createElement('div');
        entry.className = 'patrol-learning-case';
        entry.dataset.generalizationCase = scenario.id;
        const environment = scenario.environment;
        const result = scenario.metrics;
        entry.textContent = `${scenario.family} · ${environment.width} × ${environment.depth} m ${environment.shape} · ${scenario.populationCount.toLocaleString('en-US')} people / seed ${scenario.populationSeed} · ${environment.maxSpeed} m/s · ${environment.sensorRadius} m sensor radius · ${environment.batteryEnabled ? `${environment.enduranceSeconds} s endurance at max speed / ${environment.rechargeSeconds} s recharge / ${environment.chargingPads} pads / ${Math.round(environment.initialChargeFraction * 100)}% initial charge / ${Math.round(environment.reserveFraction * 100)}% reserve` : 'unlimited endurance'} — gap ${gap(result.gapCost)} · people ${percent(result.populationOnTime)} · dense min ${percent(result.auditAreaMinimum)} · hotspots ${percent(result.hotspotOnTime)} · ${testedFeasible(result) ? 'sampled checks pass' : 'requirements unmet'} · energy/reserve violations ${result.energyViolations ?? 0}/${result.reserveViolations ?? 0}.`;
        cases.append(entry);
      }
      block.append(cases);
    }
    return block;
  }
}
