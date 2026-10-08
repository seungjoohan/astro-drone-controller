import { PatrolSystem } from './patrol';
import { PatrolCoverageAudit } from './patrol-audit';
import { DEFAULT_ENVIRONMENT, insideEnvironment, validateEnvironment } from './patrol-environment';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import { RL_ACTION_COUNT, RL_CONTROL_SECONDS, RL_GRID_SIZE, RL_MAX_DRONES, RL_RETURN_ACTION, RL_SAMPLE_SECONDS, RL_STANDBY_ACTION, rlRandom } from './patrol-rl-contract';
import { actionDestination, actionMasks, observationFromSnapshot } from './patrol-rl-environment';
import { populationForScenario } from './patrol-rl-scenarios';
import { POPULATION_DEFAULTS, POPULATION_LIMITS } from './population';
import type { ExternalPatrolCommand } from './patrol-external';
import type { RLControllerKind } from './patrol-rl-environment';
import type { RLScenario } from './patrol-rl-scenarios';
import type { PatrolSnapshot } from './patrol-types';

export interface PatrolPreviewPolicy {
  act(observation: number[], masks: boolean[][]): number[];
}

function validateScenario(scenario: RLScenario): void {
  const bounded = (value: number, minimum: number, maximum: number) => Number.isFinite(value) && value >= minimum && value <= maximum;
  const config = scenario?.config;
  if (!scenario || !config || !validateEnvironment(scenario.environment)
    || typeof scenario.id !== 'string' || !scenario.id.length
    || !['train', 'validation', 'final'].includes(scenario.split)
    || !['persistent', 'moving', 'surge', 'diffuse'].includes(scenario.family)
    || !Number.isSafeInteger(scenario.seed) || !bounded(scenario.seed, 1, POPULATION_LIMITS.maxSeed)
    || !bounded(scenario.warmupSeconds, 0, 3600) || !bounded(scenario.durationSeconds, Number.MIN_VALUE, 20000)
    || !bounded(config.coverageTarget, 0, 100) || !bounded(config.revisitSeconds, 1, 3600)
    || !Number.isInteger(config.populationCount) || !bounded(config.populationCount, 0, POPULATION_LIMITS.maxPopulation)
    || !Number.isInteger(config.populationSeed) || !bounded(config.populationSeed, 1, POPULATION_LIMITS.maxSeed)
    || !bounded(config.crowdedRevisitSeconds, POPULATION_LIMITS.minCrowdedRevisitSeconds, POPULATION_LIMITS.maxCrowdedSeconds)
    || !Number.isInteger(config.crowdedCellPopulation) || !bounded(config.crowdedCellPopulation, POPULATION_LIMITS.minCrowdedCellPopulation, POPULATION_LIMITS.maxCrowdedCellPopulation)) {
    throw new Error('Invalid patrol preview scenario.');
  }
  const fault = scenario.fault;
  if (fault && (!bounded(fault.atSeconds, 0, scenario.warmupSeconds + scenario.durationSeconds)
    || !['malfunction', 'deviation'].includes(fault.kind)
    || fault.droneId !== undefined && (!Number.isInteger(fault.droneId) || fault.droneId < 1))) {
    throw new Error('Invalid patrol preview fault.');
  }
}

export function createNYCPreviewScenario(): RLScenario {
  return {
    id: 'preview-nyc', split: 'validation', family: 'moving', seed: 42,
    config: { ...POPULATION_DEFAULTS, coverageTarget: 95, revisitSeconds: 120, fleetSize: RL_MAX_DRONES },
    environment: { ...DEFAULT_ENVIRONMENT, batteryEnabled: true, depot: { ...DEFAULT_ENVIRONMENT.depot } },
    warmupSeconds: 120,
    durationSeconds: 1800,
  };
}

export class PatrolPreviewSession {
  private readonly scenario: RLScenario;
  private readonly system: PatrolSystem;
  private readonly audit: PatrolCoverageAudit;
  private readonly slotIds: number[];
  private readonly raster: number[];
  private readonly end: number;
  private latest: PatrolSnapshot;
  private bufferedSeconds = 0;
  private nextDecisionTime = 0;
  private nextPopulationTime = RL_CONTROL_SECONDS;
  private decisionCount = 0;
  private faultInjected = false;

  constructor(scenario: RLScenario, readonly fleetSize: number, readonly controller: RLControllerKind, private readonly policy?: PatrolPreviewPolicy) {
    validateScenario(scenario);
    if (!Number.isInteger(fleetSize) || fleetSize < 1 || fleetSize > RL_MAX_DRONES) throw new Error('Patrol preview fleet size must be 1–8.');
    if (!['neural', 'uniform', 'adaptive'].includes(controller)) throw new Error('Invalid patrol preview controller.');
    if (controller === 'neural' ? typeof policy?.act !== 'function' : policy !== undefined) throw new Error('Only neural patrol previews require a policy.');
    this.scenario = structuredClone(scenario);
    this.end = scenario.warmupSeconds + scenario.durationSeconds;
    this.system = new PatrolSystem({ ...this.scenario.config, fleetSize, populationDynamics: undefined },
      controller === 'adaptive' ? { kind: 'adaptive', parameters: DEFAULT_POLICY_PARAMETERS } : { kind: 'uniform' }, this.scenario.environment);
    if (controller === 'neural') this.system.enableExternalControl();
    this.latest = this.system.snapshot();
    this.system.applyPopulationCounts(populationForScenario(this.scenario, this.latest.cells.map(cell => cell.position), 0));
    this.latest = this.system.snapshot();
    this.slotIds = this.latest.drones.map(drone => drone.id);
    const random = rlRandom(this.scenario.seed);
    for (let index = this.slotIds.length - 1; index > 0; index -= 1) {
      const selected = Math.floor(random() * (index + 1));
      [this.slotIds[index], this.slotIds[selected]] = [this.slotIds[selected], this.slotIds[index]];
    }
    this.audit = new PatrolCoverageAudit(10, this.scenario.environment);
    this.audit.observe(this.latest);
    this.raster = Array.from({ length: RL_GRID_SIZE ** 2 }, (_, index) => {
      const position = {
        x: ((index % RL_GRID_SIZE + 0.5) / RL_GRID_SIZE - 0.5) * this.scenario.environment.width,
        z: ((Math.floor(index / RL_GRID_SIZE) + 0.5) / RL_GRID_SIZE - 0.5) * this.scenario.environment.depth,
      };
      if (!insideEnvironment(position, this.scenario.environment)) return -1;
      let nearest = -1;
      let nearestDistance = Infinity;
      this.latest.cells.forEach((cell, cellIndex) => {
        const distance = Math.hypot(cell.position.x - position.x, cell.position.z - position.z);
        if (distance < nearestDistance) {
          nearest = cellIndex;
          nearestDistance = distance;
        }
      });
      return nearest;
    });
  }

  get done(): boolean { return this.latest.time >= this.end - 1e-8; }

  get decisions(): number { return this.decisionCount; }

  get auditCoverage(): number { return this.audit.measure(this.latest.time, this.latest.config.revisitSeconds).coverage; }

  snapshot(): PatrolSnapshot { return this.system.snapshot(); }

  advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Preview elapsed time must be finite and nonnegative.');
    if (this.done || seconds === 0) return;
    this.bufferedSeconds = Math.min(this.end - this.latest.time, this.bufferedSeconds + seconds);
    while (!this.done) {
      const fault = this.scenario.fault;
      let sampleSeconds = Math.min(RL_SAMPLE_SECONDS, this.end - this.latest.time, this.nextPopulationTime - this.latest.time);
      if (fault && !this.faultInjected && fault.atSeconds > this.latest.time + 1e-8) sampleSeconds = Math.min(sampleSeconds, fault.atSeconds - this.latest.time);
      if (this.latest.time < this.scenario.warmupSeconds - 1e-8) sampleSeconds = Math.min(sampleSeconds, this.scenario.warmupSeconds - this.latest.time);
      if (this.bufferedSeconds < sampleSeconds - 1e-8) break;
      if (this.latest.time >= this.nextDecisionTime - 1e-8) {
        if (this.controller === 'neural') this.command();
        this.nextDecisionTime += RL_CONTROL_SECONDS;
      }
      if (fault && !this.faultInjected && this.latest.time >= fault.atSeconds - 1e-8) {
        this.system.injectFault(Math.min(this.fleetSize, fault.droneId ?? 1), fault.kind);
        this.faultInjected = true;
      }
      this.system.step(sampleSeconds);
      this.latest = this.system.snapshot();
      this.audit.observe(this.latest);
      this.bufferedSeconds = Math.max(0, this.bufferedSeconds - sampleSeconds);
      if (this.latest.time >= this.nextPopulationTime - 1e-8) {
        this.system.applyPopulationCounts(populationForScenario(this.scenario, this.latest.cells.map(cell => cell.position), this.nextPopulationTime));
        this.nextPopulationTime += RL_CONTROL_SECONDS;
        this.latest = this.system.snapshot();
      }
    }
  }

  private command(): void {
    const masks = actionMasks(this.latest, this.slotIds);
    const actions = this.policy!.act(observationFromSnapshot(this.latest, this.slotIds, this.raster), masks.map(mask => [...mask]));
    if (!Array.isArray(actions) || actions.length !== RL_MAX_DRONES
      || Array.from(actions).some((action, slot) => !Number.isInteger(action) || action < 0 || action >= RL_ACTION_COUNT || !masks[slot][action])) {
      throw new Error('Invalid or masked patrol preview action.');
    }
    const commands: ExternalPatrolCommand[] = [];
    for (let slot = 0; slot < this.slotIds.length; slot += 1) {
      const drone = this.latest.drones.find(candidate => candidate.id === this.slotIds[slot])!;
      if (drone.status !== 'patrolling' || !['patrol', 'standby'].includes(drone.serviceState)) continue;
      const action = actions[slot];
      if (action === RL_RETURN_ACTION || action === RL_STANDBY_ACTION) {
        commands.push({ droneId: drone.id, mode: action === RL_RETURN_ACTION ? 'return' : 'standby' });
      } else {
        const { x, z, speedFraction } = actionDestination(this.latest, drone, action);
        commands.push({ droneId: drone.id, mode: 'patrol', destination: { x, z }, speedFraction });
      }
    }
    this.system.applyExternalCommands(commands);
    this.decisionCount += 1;
  }
}
