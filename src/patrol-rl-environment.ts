import { PatrolSystem } from './patrol';
import { PatrolCoverageAudit } from './patrol-audit';
import { energyRate, insideEnvironment } from './patrol-environment';
import { EvaluationAccumulator } from './patrol-evaluator';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import { populationForScenario } from './patrol-rl-scenarios';
import { calculatePatrolReward, DEFAULT_RL_REWARD_PROFILE, emptyRewardComponents, rewardMetadata } from './patrol-rl-reward';
import { RL_ACTION_COUNT, RL_CONTROL_SECONDS, RL_DIRECTIONS, RL_DRONE_FEATURES, RL_GRID_SIZE, RL_HOVER_ACTION, RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_RETURN_ACTION, RL_SAMPLE_SECONDS, RL_SPEED_FRACTIONS, RL_STANDBY_ACTION, rlRandom } from './patrol-rl-contract';
import type { ExternalPatrolCommand } from './patrol-external';
import type { EvaluationMetrics, PolicyParameters } from './patrol-learning-types';
import type { RLScenario } from './patrol-rl-scenarios';
import type { PatrolDrone, PatrolSnapshot } from './patrol-types';
import type { RLRewardComponents, RLRewardProfile } from './patrol-rl-reward';

export { patrolReward } from './patrol-rl-reward';

export type RLControllerKind = 'neural' | 'uniform' | 'adaptive';

export interface RLObservation {
  observation: number[];
  masks: boolean[][];
}

export interface RLEnvironmentOptions {
  controller?: RLControllerKind;
  adaptiveParameters?: PolicyParameters;
  warmupSeconds?: number;
  durationSeconds?: number;
  slotSeed?: number;
  rewardProfile?: RLRewardProfile;
}

export interface RLEpisodeResult {
  scenarioId: string;
  split: RLScenario['split'];
  family: RLScenario['family'];
  fault: boolean;
  faultApplied: boolean;
  controller: RLControllerKind;
  fleetSize: number;
  warmupSeconds: number;
  durationSeconds: number;
  qualifyingProtocol: boolean;
  metrics: EvaluationMetrics;
  personSeconds: number;
  personSecondsUnobserved: number;
  unobservedFraction: number | null;
  hotspotPersonSeconds: number;
  hotspotWorstAgeSeconds: number | null;
  forcedReturns: number;
  rejectedCommands: number;
  commandedReturns: number;
  initialReserveDeficitDrones: number[];
  inventoryDroneSeconds: number;
  reward: number;
  rewardProfile: RLRewardProfile;
  rewardComponents: RLRewardComponents;
}

function controllerAvailable(drone: PatrolDrone): boolean {
  return drone.status !== 'offline' && (drone.serviceState === 'patrol' || drone.serviceState === 'standby');
}

function normalizedAge(age: number, window: number): number {
  return age / (age + window);
}

export function observationFromSnapshot(snapshot: PatrolSnapshot, slotIds: readonly number[], raster: readonly number[]): number[] {
  const { environment, config } = snapshot;
  const observation: number[] = [];
  for (const cellIndex of raster) {
    const cell = snapshot.cells[cellIndex];
    if (!cell) {
      observation.push(0, 0, 0, 0, 0);
      continue;
    }
    const age = cell.lastVisited === null ? snapshot.time + cell.targetRevisitSeconds : Math.max(0, snapshot.time - cell.lastVisited);
    observation.push(1, cell.population / (cell.population + config.crowdedCellPopulation),
      normalizedAge(age, cell.targetRevisitSeconds), normalizedAge(age, config.revisitSeconds), cell.lastVisited === null ? 0 : 1);
  }
  for (let slot = 0; slot < RL_MAX_DRONES; slot += 1) {
    const drone = snapshot.drones.find(candidate => candidate.id === slotIds[slot]);
    if (!drone) {
      observation.push(...Array<number>(RL_DRONE_FEATURES).fill(0));
      continue;
    }
    const destination = drone.route[drone.routeIndex] ?? drone.position;
    observation.push(1, drone.position.x * 2 / environment.width, drone.position.z * 2 / environment.depth,
      drone.batteryFraction, drone.speed / environment.maxSpeed,
      drone.serviceState === 'patrol' ? 1 : 0, drone.serviceState === 'returning' ? 1 : 0,
      drone.serviceState === 'waiting' ? 1 : 0, drone.serviceState === 'charging' ? 1 : 0,
      drone.serviceState === 'standby' ? 1 : 0, drone.status === 'offline' ? 1 : 0,
      destination.x * 2 / environment.width, destination.z * 2 / environment.depth,
      controllerAvailable(drone) ? 1 : 0);
  }
  observation.push(environment.width / 640, environment.depth / 640, environment.shape === 'circle' ? 1 : 0,
    environment.maxSpeed / 30, environment.sensorRadius / 64, environment.batteryEnabled ? 1 : 0,
    environment.enduranceSeconds / 1800, environment.rechargeSeconds / 1800, environment.reserveFraction,
    environment.chargingPads / 8, environment.depot.x * 2 / environment.width, environment.depot.z * 2 / environment.depth,
    config.coverageTarget / 100, config.revisitSeconds / 3600, config.crowdedRevisitSeconds / config.revisitSeconds,
    config.crowdedCellPopulation / 1000, snapshot.population.totalPeople / 50000, snapshot.drones.length / RL_MAX_DRONES);
  if (observation.length !== RL_OBSERVATION_SIZE || observation.some(value => !Number.isFinite(value))) throw new Error('Invalid RL observation.');
  return observation;
}

export function actionDestination(snapshot: PatrolSnapshot, drone: PatrolDrone, action: number): { x: number; z: number; speedFraction: number } {
  if (action === RL_HOVER_ACTION) return { x: drone.position.x, z: drone.position.z, speedFraction: 1 };
  if (!Number.isInteger(action) || action < 0 || action >= RL_HOVER_ACTION) throw new Error('Not a patrol movement action.');
  const direction = RL_DIRECTIONS[Math.floor(action / RL_SPEED_FRACTIONS.length)];
  const speedFraction = RL_SPEED_FRACTIONS[action % RL_SPEED_FRACTIONS.length];
  const distance = snapshot.environment.maxSpeed * speedFraction * RL_CONTROL_SECONDS;
  return { x: drone.position.x + direction.x * distance, z: drone.position.z + direction.z * distance, speedFraction };
}

export function actionMasks(snapshot: PatrolSnapshot, slotIds: readonly number[]): boolean[][] {
  return Array.from({ length: RL_MAX_DRONES }, (_, slot) => {
    const mask = Array<boolean>(RL_ACTION_COUNT).fill(false);
    const drone = snapshot.drones.find(candidate => candidate.id === slotIds[slot]);
    if (!drone || !controllerAvailable(drone)) {
      mask[RL_HOVER_ACTION] = true;
      return mask;
    }
    const { environment } = snapshot;
    for (let action = 0; action <= RL_HOVER_ACTION; action += 1) {
      const destination = actionDestination(snapshot, drone, action);
      if (!insideEnvironment(destination, environment)) continue;
      const patrolEnergy = RL_CONTROL_SECONDS * energyRate(action === RL_HOVER_ACTION ? 0 : environment.maxSpeed * destination.speedFraction, environment);
      const returnEnergy = Math.hypot(destination.x - environment.depot.x, destination.z - environment.depot.z)
        / environment.maxSpeed * energyRate(environment.maxSpeed, environment);
      mask[action] = !environment.batteryEnabled || drone.batteryFraction >= patrolEnergy + returnEnergy + environment.reserveFraction + 1e-7;
    }
    mask[RL_RETURN_ACTION] = true;
    mask[RL_STANDBY_ACTION] = Math.hypot(drone.position.x - environment.depot.x, drone.position.z - environment.depot.z) <= 1e-8;
    return mask;
  });
}

export class RLPatrolEnvironment {
  readonly controller: RLControllerKind;
  readonly rewardProfile: RLRewardProfile;
  readonly slotIds: number[];
  readonly warmupSeconds: number;
  readonly durationSeconds: number;
  readonly qualifyingProtocol: boolean;
  private readonly system: PatrolSystem;
  private readonly audit: PatrolCoverageAudit;
  private readonly accumulator = new EvaluationAccumulator(true);
  private readonly raster: number[];
  private readonly end: number;
  private latest: PatrolSnapshot;
  private nextPopulationTime = RL_CONTROL_SECONDS;
  private faultInjected = false;
  private faultApplied = false;
  private personSeconds = 0;
  private personSecondsUnobserved = 0;
  private hotspotPersonSeconds = 0;
  private hotspotWorstAgeSeconds: number | null = null;
  private commandedReturns = 0;
  private distanceMeters = 0;
  private rewardTotal = 0;
  private readonly rewardComponents = emptyRewardComponents();
  private readonly initialReserveDeficitDrones: number[];

  constructor(readonly scenario: RLScenario, readonly fleetSize: number, options: RLEnvironmentOptions = {}) {
    if (!Number.isInteger(fleetSize) || fleetSize < 1 || fleetSize > RL_MAX_DRONES) throw new Error('RL fleet size must be 1–8.');
    this.rewardProfile = rewardMetadata(options.rewardProfile ?? DEFAULT_RL_REWARD_PROFILE).profile;
    this.controller = options.controller ?? 'neural';
    this.warmupSeconds = options.warmupSeconds ?? scenario.warmupSeconds;
    this.durationSeconds = options.durationSeconds ?? scenario.durationSeconds;
    if (!Number.isFinite(this.warmupSeconds) || this.warmupSeconds < 0 || this.warmupSeconds > 3600
      || !Number.isFinite(this.durationSeconds) || this.durationSeconds <= 0 || this.durationSeconds > 20000) throw new Error('Invalid RL episode duration.');
    this.end = this.warmupSeconds + this.durationSeconds;
    this.qualifyingProtocol = this.warmupSeconds >= scenario.warmupSeconds && this.durationSeconds >= scenario.durationSeconds;
    this.system = new PatrolSystem({ ...scenario.config, fleetSize, populationDynamics: undefined },
      this.controller === 'adaptive' ? { kind: 'adaptive', parameters: options.adaptiveParameters ?? DEFAULT_POLICY_PARAMETERS } : { kind: 'uniform' }, scenario.environment);
    if (this.controller === 'neural') this.system.enableExternalControl();
    this.latest = this.system.snapshot();
    this.initialReserveDeficitDrones = this.latest.drones.filter(drone => scenario.environment.batteryEnabled
      && drone.batteryFraction < Math.hypot(drone.position.x - scenario.environment.depot.x, drone.position.z - scenario.environment.depot.z)
        / scenario.environment.maxSpeed * energyRate(scenario.environment.maxSpeed, scenario.environment) + scenario.environment.reserveFraction).map(drone => drone.id);
    this.system.applyPopulationCounts(populationForScenario(scenario, this.latest.cells.map(cell => cell.position), 0));
    this.latest = this.system.snapshot();
    this.slotIds = this.latest.drones.map(drone => drone.id);
    const random = rlRandom(options.slotSeed ?? scenario.seed);
    for (let index = this.slotIds.length - 1; index > 0; index -= 1) {
      const selected = Math.floor(random() * (index + 1));
      [this.slotIds[index], this.slotIds[selected]] = [this.slotIds[selected], this.slotIds[index]];
    }
    this.audit = new PatrolCoverageAudit(10, scenario.environment);
    this.audit.observe(this.latest);
    this.raster = Array.from({ length: RL_GRID_SIZE ** 2 }, (_, index) => {
      const position = { x: ((index % RL_GRID_SIZE + 0.5) / RL_GRID_SIZE - 0.5) * scenario.environment.width,
        z: ((Math.floor(index / RL_GRID_SIZE) + 0.5) / RL_GRID_SIZE - 0.5) * scenario.environment.depth };
      if (!insideEnvironment(position, scenario.environment)) return -1;
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

  observation(): RLObservation {
    return { observation: observationFromSnapshot(this.latest, this.slotIds, this.raster), masks: actionMasks(this.latest, this.slotIds) };
  }

  snapshot(): PatrolSnapshot { return this.system.snapshot(); }

  step(actions?: readonly number[]): { reward: number; terminated: boolean; truncated: boolean } {
    if (this.done) throw new Error('Cannot step a completed RL episode.');
    if (this.controller === 'neural') this.command(actions);
    else if (actions !== undefined) throw new Error('Baseline episodes do not accept neural actions.');
    const stop = Math.min(this.end, this.latest.time + RL_CONTROL_SECONDS);
    let reward = 0;
    while (this.latest.time < stop - 1e-8) {
      const fault = this.scenario.fault;
      if (fault && !this.faultInjected && this.latest.time >= fault.atSeconds - 1e-8) {
        const requested = fault.droneId ?? 1;
        const droneId = Math.min(this.fleetSize, requested);
        this.system.injectFault(droneId, fault.kind);
        this.faultApplied = this.system.snapshot().drones.some(drone => drone.id === droneId && drone.fault === fault.kind);
        this.faultInjected = true;
      }
      let seconds = Math.min(RL_SAMPLE_SECONDS, stop - this.latest.time, this.nextPopulationTime - this.latest.time);
      if (fault && !this.faultInjected) seconds = Math.min(seconds, fault.atSeconds - this.latest.time);
      if (this.latest.time < this.warmupSeconds) seconds = Math.min(seconds, this.warmupSeconds - this.latest.time);
      const previous = this.latest;
      this.system.step(seconds);
      this.latest = this.system.snapshot();
      this.audit.observe(this.latest);
      const audit = this.audit.measure(this.latest.time, this.latest.config.revisitSeconds);
      const rewardAudit = this.rewardProfile === 'legacy-v1' ? { coverage: audit.coverage, meanAgeCost: 0, overlapFraction: 0 }
        : this.audit.measureReward(this.latest.time, this.latest.config.revisitSeconds);
      const outcome = calculatePatrolReward(this.latest, rewardAudit, previous, this.rewardProfile);
      reward += outcome.reward;
      for (const component of Object.keys(this.rewardComponents) as Array<keyof RLRewardComponents>) {
        this.rewardComponents[component] += outcome.components[component];
      }
      if (previous.time >= this.warmupSeconds - 1e-8) {
        this.accumulator.add(this.latest, seconds, audit.coverage);
        this.personSeconds += this.latest.population.totalPeople * seconds;
        this.personSecondsUnobserved += (this.latest.population.totalPeople - this.latest.population.inViewPeople) * seconds;
        for (const cell of this.latest.cells) {
          if (cell.population < this.latest.config.crowdedCellPopulation) continue;
          this.hotspotPersonSeconds += cell.population * seconds;
          const age = cell.lastVisited === null ? this.latest.time + cell.targetRevisitSeconds : Math.max(0, this.latest.time - cell.lastVisited);
          this.hotspotWorstAgeSeconds = Math.max(this.hotspotWorstAgeSeconds ?? 0, age);
        }
        this.distanceMeters += this.latest.drones.reduce((total, drone, index) => total
          + Math.hypot(drone.position.x - previous.drones[index].position.x, drone.position.z - previous.drones[index].position.z), 0);
      }
      if (this.latest.time >= this.nextPopulationTime - 1e-8) {
        this.system.applyPopulationCounts(populationForScenario(this.scenario, this.latest.cells.map(cell => cell.position), this.nextPopulationTime));
        this.nextPopulationTime += RL_CONTROL_SECONDS;
        this.latest = this.system.snapshot();
      }
    }
    this.rewardTotal += reward;
    return { reward, terminated: false, truncated: this.done };
  }

  result(): RLEpisodeResult {
    if (!this.done) throw new Error('Incomplete RL episodes cannot be scored.');
    return {
      scenarioId: this.scenario.id, split: this.scenario.split, family: this.scenario.family,
      fault: !!this.scenario.fault, faultApplied: this.faultApplied, controller: this.controller, fleetSize: this.fleetSize,
      warmupSeconds: this.warmupSeconds, durationSeconds: this.durationSeconds, qualifyingProtocol: this.qualifyingProtocol,
      metrics: { ...this.accumulator.metrics(1, this.distanceMeters), energyViolations: this.latest.energy.strandedDrones,
        reserveViolations: this.latest.energy.reserveViolations, energyUsed: this.latest.energy.energyUsed,
        completedCharges: this.latest.energy.completedCharges },
      personSeconds: this.personSeconds, personSecondsUnobserved: this.personSecondsUnobserved,
      unobservedFraction: this.personSeconds ? this.personSecondsUnobserved / this.personSeconds : null,
      hotspotPersonSeconds: this.hotspotPersonSeconds, hotspotWorstAgeSeconds: this.hotspotWorstAgeSeconds,
      forcedReturns: this.latest.externalControl?.forcedReturns ?? 0,
      rejectedCommands: this.latest.externalControl?.rejectedCommands ?? 0,
      commandedReturns: this.commandedReturns, initialReserveDeficitDrones: [...this.initialReserveDeficitDrones],
      inventoryDroneSeconds: this.fleetSize * this.end, reward: this.rewardTotal,
      rewardProfile: this.rewardProfile, rewardComponents: { ...this.rewardComponents },
    };
  }

  private command(actions: readonly number[] | undefined): void {
    const masks = actionMasks(this.latest, this.slotIds);
    if (!Array.isArray(actions) || actions.length !== RL_MAX_DRONES || Array.from(actions).some((action, slot) => !Number.isInteger(action) || action < 0 || action >= RL_ACTION_COUNT || !masks[slot][action])) throw new Error('Invalid or masked RL action.');
    const commands: ExternalPatrolCommand[] = [];
    for (let slot = 0; slot < this.slotIds.length; slot += 1) {
      const drone = this.latest.drones.find(candidate => candidate.id === this.slotIds[slot])!;
      if (drone.status !== 'patrolling' || !controllerAvailable(drone)) continue;
      const action = actions[slot];
      if (action === RL_RETURN_ACTION || action === RL_STANDBY_ACTION) {
        commands.push({ droneId: drone.id, mode: action === RL_RETURN_ACTION ? 'return' : 'standby' });
      } else {
        const { x, z, speedFraction } = actionDestination(this.latest, drone, action);
        commands.push({ droneId: drone.id, mode: 'patrol', destination: { x, z }, speedFraction });
      }
    }
    this.system.applyExternalCommands(commands);
    this.commandedReturns += commands.filter(command => command.mode === 'return').length;
  }
}

export function selectValidatedRLFleet(results: readonly RLEpisodeResult[], scenarioIds: readonly string[]): number | null {
  if (!scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length) return null;
  for (let fleetSize = 1; fleetSize <= RL_MAX_DRONES; fleetSize += 1) {
    const selected = results.filter(result => result.controller === 'neural' && result.fleetSize === fleetSize && !result.fault && result.split === 'validation');
    if (selected.length !== scenarioIds.length || selected.some(result => !scenarioIds.includes(result.scenarioId)) || new Set(selected.map(result => result.scenarioId)).size !== scenarioIds.length) continue;
    if (selected.every(result => result.qualifyingProtocol && result.metrics.geographicFeasible && result.metrics.hotspotFeasible
      && result.metrics.neverObservedPeople === 0 && result.metrics.energyViolations === 0 && result.metrics.reserveViolations === 0
      && result.rejectedCommands === 0 && result.forcedReturns === 0)) return fleetSize;
  }
  return null;
}
