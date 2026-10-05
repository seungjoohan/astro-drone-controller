import { FLIGHT_MAPS } from './maps';
import { evaluatePopulation, populateCells, POPULATION_DEFAULTS, POPULATION_LIMITS } from './population';
import { assignPolicyRegions, PopulationPolicy, validateStrategy } from './patrol-policy';
import { DEFAULT_ENVIRONMENT, energyRate, insideEnvironment, validateEnvironment } from './patrol-environment';
import type { PatrolEnergyMetrics, PatrolEnvironment } from './patrol-environment';
import type { PatrolStrategy } from './patrol-learning-types';
import type { FleetRecommendation, PatrolCell, PatrolConfig, PatrolDrone, PatrolEvent, PatrolFault, PatrolSnapshot } from './patrol-types';
import type { Vec3 } from './types';

export const PATROL_LIMITS = Object.freeze({ maxDrones: 8, speed: 18, sensorRadius: 32, cellSize: 40, detectionSeconds: 3 });

const POSITION_EPSILON = 1e-8;
const MAX_STEP_SECONDS = 3600;
const HEALTH_INTERVAL = 0.1;
const DEVIATION_TOLERANCE = 8;
const COLORS = ['#416b28', '#985c23', '#246f8a', '#a14f7a', '#70549c', '#75651d', '#23745b', '#a14643'];
const MAP_RADIUS = FLIGHT_MAPS.nyc.radius;
const ENERGY_INTERVAL = 0.25;

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function horizontalDistance(start: Vec3, end: Vec3): number {
  return Math.hypot(end.x - start.x, end.z - start.z);
}

function distanceToSegment(position: Vec3, start: Vec3, end: Vec3): number {
  const horizontal = end.x - start.x;
  const depth = end.z - start.z;
  const lengthSquared = horizontal * horizontal + depth * depth;
  const projection = lengthSquared ? Math.max(0, Math.min(1, ((position.x - start.x) * horizontal + (position.z - start.z) * depth) / lengthSquared)) : 0;
  return Math.hypot(position.x - start.x - projection * horizontal, position.z - start.z - projection * depth);
}

function createCells(revisitSeconds = 120, environment: PatrolEnvironment = DEFAULT_ENVIRONMENT): PatrolCell[] {
  const cells: PatrolCell[] = [];
  let rowIndex = 0;
  for (let depth = -environment.depth / 2 + PATROL_LIMITS.cellSize / 2; depth < environment.depth / 2; depth += PATROL_LIMITS.cellSize) {
    const row: Vec3[] = [];
    for (let horizontal = -environment.width / 2 + PATROL_LIMITS.cellSize / 2; horizontal < environment.width / 2; horizontal += PATROL_LIMITS.cellSize) {
      if (insideEnvironment({ x: horizontal, z: depth }, environment)) row.push({ x: horizontal, y: 0, z: depth });
    }
    if (rowIndex % 2) row.reverse();
    for (const position of row) cells.push({ id: cells.length, position, lastVisited: null, assignedDroneId: null, population: 0, targetRevisitSeconds: revisitSeconds });
    rowIndex += 1;
  }
  return cells;
}

const CELL_POSITIONS = createCells().map(cell => cell.position);

function partition<Cell>(cells: Cell[], count: number): Cell[][] {
  return Array.from({ length: count }, (_, routeIndex) => cells.slice(
    Math.floor(routeIndex * cells.length / count),
    Math.floor((routeIndex + 1) * cells.length / count),
  ));
}

function routeSchedule(route: Vec3[], speed: number = PATROL_LIMITS.speed): { arrivals: number[]; cycle: number } {
  const arrivals: number[] = [];
  let cycle = 0;
  for (let index = 0; index < route.length; index += 1) {
    arrivals.push(cycle);
    cycle += horizontalDistance(route[index], route[(index + 1) % route.length]) / speed;
  }
  return { arrivals, cycle };
}

function minimumFreshCells(route: Vec3[], revisitSeconds: number, speed: number): number {
  const { arrivals, cycle } = routeSchedule(route, speed);
  if (cycle <= revisitSeconds + POSITION_EPSILON) return route.length;
  const doubled = [...arrivals, ...arrivals.map(arrival => arrival + cycle)];
  let firstFresh = 0;
  let minimum = route.length;
  for (let nextArrival = arrivals.length; nextArrival < doubled.length; nextArrival += 1) {
    while (firstFresh < nextArrival && doubled[firstFresh] < doubled[nextArrival] - revisitSeconds - POSITION_EPSILON) firstFresh += 1;
    minimum = Math.min(minimum, nextArrival - firstFresh);
  }
  return minimum;
}

function estimateCoverage(routes: Vec3[][], revisitSeconds: number, speed: number = PATROL_LIMITS.speed, cellCount = CELL_POSITIONS.length): number {
  return 100 * routes.reduce((total, route) => total + minimumFreshCells(route, revisitSeconds, speed), 0) / cellCount;
}

export function recommendFleet(config: Pick<PatrolConfig, 'coverageTarget' | 'revisitSeconds'>, environment: PatrolEnvironment = DEFAULT_ENVIRONMENT): FleetRecommendation {
  const coverageTarget = bounded(config.coverageTarget, 95, 0, 100);
  const revisitSeconds = bounded(config.revisitSeconds, 120, 1, 3600);
  const positions = environment === DEFAULT_ENVIRONMENT ? CELL_POSITIONS : createCells(revisitSeconds, environment).map(cell => cell.position);
  let estimatedCoverage = 0;
  for (let count = 1; count <= PATROL_LIMITS.maxDrones; count += 1) {
    const routes = partition(positions, count);
    estimatedCoverage = estimateCoverage(routes, revisitSeconds, environment.maxSpeed, positions.length);
    if (estimatedCoverage + POSITION_EPSILON >= coverageTarget) return { count, achievable: !environment.batteryEnabled, estimatedCoverage, revisitSeconds: Math.max(...routes.map(route => routeSchedule(route, environment.maxSpeed).cycle)) };
  }
  return { count: PATROL_LIMITS.maxDrones, achievable: false, estimatedCoverage, revisitSeconds: Math.max(...partition(positions, PATROL_LIMITS.maxDrones).map(route => routeSchedule(route, environment.maxSpeed).cycle)) };
}

export const PATROL_DEFAULTS: Readonly<PatrolConfig> = Object.freeze({
  ...POPULATION_DEFAULTS,
  coverageTarget: 95,
  revisitSeconds: 120,
  fleetSize: recommendFleet({ coverageTarget: 95, revisitSeconds: 120 }).count,
});

export class PatrolSystem {
  private config: PatrolConfig = { ...PATROL_DEFAULTS };
  private strategy: PatrolStrategy;
  private environment: PatrolEnvironment;
  private energy: PatrolEnergyMetrics = { energyUsed: 0, reserveViolations: 0, strandedDrones: 0, completedCharges: 0, chargingSeconds: 0, waitingSeconds: 0 };
  private policy = new PopulationPolicy(CELL_POSITIONS, MAP_RADIUS, PATROL_LIMITS.sensorRadius, PATROL_LIMITS.cellSize);
  private nextDecisionTime = 1;
  private commitmentUntil = new Map<number, number>();
  private time = 0;
  private drones: PatrolDrone[] = [];
  private cells: PatrolCell[] = [];
  private revision = 0;
  private events: PatrolEvent[] = [];
  private eventId = 0;
  private lastHeartbeat = new Map<number, number>();
  private deviationSince = new Map<number, number>();
  private plannedLegs = new Map<number, { start: Vec3; end: Vec3 }>();
  private deviationTargets = new Map<number, Vec3>();
  private recommendation: FleetRecommendation = recommendFleet(PATROL_DEFAULTS);
  private waitingSince = new Map<number, number>();
  private reserveBreaches = new Set<number>();
  private stranded = new Set<number>();
  private serviceChanged = false;

  constructor(config: Partial<PatrolConfig> = {}, strategy: PatrolStrategy = { kind: 'uniform' }, environment: PatrolEnvironment = DEFAULT_ENVIRONMENT) {
    const validated = validateStrategy(strategy);
    if (!validated) throw new Error('Invalid patrol strategy.');
    this.strategy = validated;
    const validatedEnvironment = validateEnvironment(environment);
    if (!validatedEnvironment) throw new Error('Invalid patrol environment.');
    this.environment = validatedEnvironment;
    this.reset(config);
  }

  setStrategy(strategy: PatrolStrategy): void {
    const validated = validateStrategy(strategy);
    if (!validated) throw new Error('Invalid patrol strategy.');
    this.strategy = validated;
    this.commitmentUntil.clear();
    this.nextDecisionTime = Math.floor(this.time) + 1;
    this.replan();
  }

  reset(overrides: Partial<PatrolConfig> = {}, environment: PatrolEnvironment = this.environment): void {
    const validatedEnvironment = validateEnvironment(environment);
    if (!validatedEnvironment) throw new Error('Invalid patrol environment.');
    this.environment = validatedEnvironment;
    const revisitSeconds = bounded(overrides.revisitSeconds, this.config.revisitSeconds, 1, 3600);
    this.config = {
      coverageTarget: bounded(overrides.coverageTarget, this.config.coverageTarget, 0, 100),
      revisitSeconds,
      fleetSize: Math.round(bounded(overrides.fleetSize, this.config.fleetSize, 1, PATROL_LIMITS.maxDrones)),
      populationCount: Math.round(bounded(overrides.populationCount, this.config.populationCount, 0, POPULATION_LIMITS.maxPopulation)),
      populationSeed: Math.round(bounded(overrides.populationSeed, this.config.populationSeed, 1, POPULATION_LIMITS.maxSeed)),
      crowdedRevisitSeconds: Math.min(revisitSeconds, bounded(overrides.crowdedRevisitSeconds, this.config.crowdedRevisitSeconds, 1, POPULATION_LIMITS.maxCrowdedSeconds)),
      crowdedCellPopulation: Math.round(bounded(overrides.crowdedCellPopulation, this.config.crowdedCellPopulation, 1, POPULATION_LIMITS.maxCrowdedCellPopulation)),
    };
    this.recommendation = recommendFleet(this.config, this.environment);
    this.time = 0;
    this.cells = createCells(revisitSeconds, this.environment);
    this.policy = new PopulationPolicy(this.cells.map(cell => cell.position), this.environment.width / 2, this.environment.sensorRadius, PATROL_LIMITS.cellSize, this.environment);
    populateCells(this.cells, this.config);
    this.revision = 0;
    this.events = [];
    this.eventId = 0;
    this.lastHeartbeat.clear();
    this.deviationSince.clear();
    this.plannedLegs.clear();
    this.deviationTargets.clear();
    this.commitmentUntil.clear();
    this.nextDecisionTime = 1;
    this.energy = { energyUsed: 0, reserveViolations: 0, strandedDrones: 0, completedCharges: 0, chargingSeconds: 0, waitingSeconds: 0 };
    this.waitingSince.clear();
    this.reserveBreaches.clear();
    this.stranded.clear();
    this.serviceChanged = false;
    this.drones = Array.from({ length: this.config.fleetSize }, (_, index) => ({
      id: index + 1,
      color: COLORS[index],
      status: 'patrolling',
      fault: null,
      serviceState: 'patrol',
      batteryFraction: this.environment.batteryEnabled ? Math.min(1, this.environment.initialChargeFraction + 0.1 * index / Math.max(1, this.config.fleetSize - 1)) : 1,
      speed: 0,
      chargeCycles: 0,
      position: { x: 0, y: 260 + index * 4, z: 0 },
      route: [],
      assignedCellIds: [],
      routeIndex: 0,
      cycleSeconds: 0,
    }));
    this.replanUniform();
    for (const drone of this.drones) {
      drone.position = { ...drone.route[0] };
      drone.routeIndex = drone.route.length > 1 ? 1 : 0;
      this.lastHeartbeat.set(drone.id, 0);
      this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[drone.routeIndex] } });
    }
    if (this.strategy.kind === 'adaptive') this.updateAdaptiveCommands(true);
  }

  step(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    let remaining = Math.min(dtSeconds, MAX_STEP_SECONDS);
    while (remaining > POSITION_EPSILON) {
      let interval = remaining;
      if (this.environment.batteryEnabled) {
        this.assignChargingPads();
        interval = Math.min(interval, (Math.floor((this.time + POSITION_EPSILON) / ENERGY_INTERVAL) + 1) * ENERGY_INTERVAL - this.time);
      }
      if (this.strategy.kind === 'adaptive') interval = Math.min(interval, Math.max(0, this.nextDecisionTime - this.time));
      const pending = this.drones.some(drone => drone.status === 'unresponsive' || drone.status === 'deviating');
      if (pending) interval = Math.min(interval, (Math.floor((this.time + POSITION_EPSILON) / HEALTH_INTERVAL) + 1) * HEALTH_INTERVAL - this.time);
      for (const drone of this.drones) {
        if (drone.status === 'unresponsive') interval = Math.min(interval, Math.max(0, (this.lastHeartbeat.get(drone.id) ?? this.time) + PATROL_LIMITS.detectionSeconds - this.time));
      }
      if (interval > POSITION_EPSILON) {
        for (const drone of this.drones) {
          drone.speed = 0;
          if (drone.status === 'patrolling') {
            if (this.environment.batteryEnabled) this.advanceService(drone, interval);
            else this.advanceDrone(drone, interval);
          } else if (drone.status === 'deviating') this.advanceDeviation(drone, interval);
          else if (drone.status === 'unresponsive' && (drone.serviceState === 'patrol' || drone.serviceState === 'returning')) this.consumeEnergy(drone, interval, 0);
        }
        this.time += interval;
        remaining -= interval;
      }
      let confirmed = false;
      for (const drone of this.drones) {
        if (drone.status === 'offline') continue;
        if (drone.status !== 'unresponsive') this.lastHeartbeat.set(drone.id, this.time);
        if (!pending || Math.abs(this.time / HEALTH_INTERVAL - Math.round(this.time / HEALTH_INTERVAL)) <= POSITION_EPSILON) {
          const leg = this.plannedLegs.get(drone.id);
          const trackingError = leg ? distanceToSegment(drone.position, leg.start, leg.end) : 0;
          if (trackingError > DEVIATION_TOLERANCE + POSITION_EPSILON) {
            if (!this.deviationSince.has(drone.id)) this.deviationSince.set(drone.id, this.time);
          } else this.deviationSince.delete(drone.id);
        }
        const heartbeatAge = this.time - (this.lastHeartbeat.get(drone.id) ?? this.time);
        const deviationAge = this.time - (this.deviationSince.get(drone.id) ?? this.time);
        if (heartbeatAge < PATROL_LIMITS.detectionSeconds - POSITION_EPSILON && deviationAge < PATROL_LIMITS.detectionSeconds - POSITION_EPSILON) continue;
        drone.status = 'offline';
        drone.fault = heartbeatAge >= PATROL_LIMITS.detectionSeconds - POSITION_EPSILON ? 'malfunction' : 'deviation';
        this.deviationSince.delete(drone.id);
        this.deviationTargets.delete(drone.id);
        this.log(`Drone ${drone.id} ${drone.fault === 'deviation' ? 'route deviation' : 'malfunction'} confirmed; removed from patrol.`);
        confirmed = true;
      }
      if (confirmed || this.serviceChanged) {
        this.serviceChanged = false;
        this.replan();
      }
      if (this.strategy.kind === 'adaptive' && this.time >= this.nextDecisionTime - POSITION_EPSILON) {
        this.updateAdaptiveCommands(false);
        this.nextDecisionTime = Math.floor(this.time + POSITION_EPSILON) + 1;
      }
    }
  }

  snapshot(): PatrolSnapshot {
    const active = this.drones.filter(drone => drone.status === 'patrolling' && drone.serviceState === 'patrol');
    const covered = this.cells.filter(cell => cell.lastVisited !== null && this.time - cell.lastVisited <= this.config.revisitSeconds + POSITION_EPSILON);
    const visited = this.cells.filter(cell => cell.lastVisited !== null);
    const fullyAssigned = this.cells.every(cell => active.some(drone => drone.id === cell.assignedDroneId));
    return {
      config: { ...this.config },
      environment: { ...this.environment, depot: { ...this.environment.depot } },
      energy: { ...this.energy },
      strategy: this.strategy.kind === 'uniform' ? { kind: 'uniform' } : { kind: 'adaptive', parameters: { ...this.strategy.parameters } },
      time: this.time,
      drones: this.drones.map(drone => ({ ...drone, position: { ...drone.position }, route: drone.route.map(position => ({ ...position })), assignedCellIds: [...drone.assignedCellIds] })),
      cells: this.cells.map(cell => ({ ...cell, position: { ...cell.position } })),
      population: evaluatePopulation(this.cells, this.time, this.config, this.drones.filter(drone => drone.serviceState === 'patrol'), this.environment.sensorRadius),
      coverage: 100 * covered.length / this.cells.length,
      everCovered: 100 * visited.length / this.cells.length,
      uncoveredCells: this.cells.length - covered.length,
      maxAge: visited.length ? Math.max(0, ...visited.map(cell => this.time - cell.lastVisited!)) : null,
      recommendedFleet: { ...this.recommendation },
      estimatedCoverage: this.strategy.kind === 'adaptive' || this.environment.batteryEnabled ? null : estimateCoverage(active.map(drone => drone.route), this.config.revisitSeconds, this.patrolSpeed(), this.cells.length),
      predictedRevisitSeconds: this.strategy.kind === 'adaptive' || this.environment.batteryEnabled ? null : active.length && fullyAssigned ? Math.max(...active.map(drone => drone.cycleSeconds)) : Infinity,
      activeCount: active.length,
      revision: this.revision,
      events: this.events.map(event => ({ ...event })),
    };
  }

  injectFault(id: number, kind: PatrolFault): void {
    const drone = this.drones.find(candidate => candidate.id === id);
    if (!drone || drone.status !== 'patrolling' || (kind !== 'malfunction' && kind !== 'deviation')) return;
    if (kind === 'deviation' && drone.serviceState !== 'patrol' && drone.serviceState !== 'returning') return;
    drone.fault = kind;
    drone.status = kind === 'malfunction' ? 'unresponsive' : 'deviating';
    this.lastHeartbeat.set(id, this.time);
    if (kind === 'deviation') {
      const waypoint = drone.route[drone.routeIndex] ?? drone.position;
      const distance = Math.max(horizontalDistance(drone.position, waypoint), 1);
      const direction = horizontalDistance(drone.position, waypoint) <= POSITION_EPSILON
        ? { x: 1, z: 0 }
        : { x: -(waypoint.z - drone.position.z) / distance, z: (waypoint.x - drone.position.x) / distance };
      let target = { x: drone.position.x + direction.x * 80, y: drone.position.y, z: drone.position.z + direction.z * 80 };
      if (!insideEnvironment(target, this.environment)) target = { x: drone.position.x - direction.x * 80, y: drone.position.y, z: drone.position.z - direction.z * 80 };
      if (!insideEnvironment(target, this.environment)) {
        if (this.environment.shape === 'circle') {
          const radius = Math.hypot(target.x, target.z);
          target.x *= this.environment.width / 2 / radius;
          target.z *= this.environment.width / 2 / radius;
        } else {
          target.x = Math.max(-this.environment.width / 2, Math.min(this.environment.width / 2, target.x));
          target.z = Math.max(-this.environment.depth / 2, Math.min(this.environment.depth / 2, target.z));
        }
      }
      this.deviationTargets.set(id, target);
    }
    this.log(`Drone ${id} ${kind === 'malfunction' ? 'lost contact' : 'left its planned route'}; checking for ${PATROL_LIMITS.detectionSeconds} seconds.`);
  }

  restoreDrone(id: number): void {
    const drone = this.drones.find(candidate => candidate.id === id);
    if (!drone || drone.status === 'patrolling') return;
    drone.status = 'patrolling';
    drone.fault = null;
    if (this.environment.batteryEnabled && drone.batteryFraction <= POSITION_EPSILON && (drone.serviceState === 'patrol' || drone.serviceState === 'returning')) {
      drone.status = 'offline';
      this.log(`Drone ${id} cannot resume flight without sufficient battery.`);
      return;
    }
    this.lastHeartbeat.set(id, this.time);
    this.deviationSince.delete(id);
    this.deviationTargets.delete(id);
    this.log(`Drone ${id} restored at its current position.`);
    this.replan();
  }

  private replan(): void {
    if (this.strategy.kind === 'uniform') this.replanUniform();
    else {
      this.updateAdaptiveCommands(true);
      this.revision += 1;
      const count = this.drones.filter(drone => drone.status === 'patrolling' && drone.serviceState === 'patrol').length;
      this.log(count ? `Replanned all ${count} healthy drones with population-aware destinations.` : 'No healthy drones remain; all cells are unassigned.');
    }
  }

  private updateAdaptiveCommands(force: boolean): void {
    if (this.strategy.kind !== 'adaptive') return;
    const participants = this.drones.filter(drone => drone.status !== 'offline' && drone.serviceState === 'patrol');
    const active = participants.filter(drone => drone.status === 'patrolling');
    const commands = this.policy.choose(
      this.cells.map(cell => ({ id: cell.id, position: { ...cell.position }, lastVisited: cell.lastVisited, population: cell.population, targetRevisitSeconds: cell.targetRevisitSeconds })),
      participants.map(drone => {
        const destination = drone.route[drone.routeIndex];
        const inTransit = !!destination && horizontalDistance(drone.position, destination) > POSITION_EPSILON;
        const committed = drone.status !== 'patrolling' || !force && (inTransit || this.time < (this.commitmentUntil.get(drone.id) ?? 0) - POSITION_EPSILON);
        return { id: drone.id, position: { ...drone.position }, destination: destination ? { ...destination } : null, committed };
      }),
      this.time,
      this.config.revisitSeconds,
      this.patrolSpeed(),
      { ...this.strategy.parameters },
    );
    if (commands.size !== participants.length || [...commands.keys()].some(id => !participants.some(drone => drone.id === id))) throw new Error('Planner commanded an unavailable aircraft.');
    for (const drone of participants) {
      const destination = commands.get(drone.id);
      if (!destination || !Number.isFinite(destination.x) || !Number.isFinite(destination.z) || destination.y !== drone.position.y || !insideEnvironment(destination, this.environment)) throw new Error('Planner produced an invalid destination.');
    }
    for (const drone of this.drones) {
      drone.assignedCellIds = [];
      drone.cycleSeconds = 0;
      if (drone.status === 'offline' && drone.serviceState === 'patrol') {
        drone.route = [];
        drone.routeIndex = 0;
        this.plannedLegs.delete(drone.id);
      }
    }
    for (const drone of active) {
      const destination = commands.get(drone.id)!;
      const current = drone.route[drone.routeIndex];
      if (force || !current || horizontalDistance(current, destination) > POSITION_EPSILON) {
        drone.route = [{ ...destination }];
        drone.routeIndex = 0;
        this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...destination } });
        this.commitmentUntil.set(drone.id, this.time + this.strategy.parameters.commitmentSeconds);
      }
    }
    const owners = assignPolicyRegions(this.cells.length, participants.map(drone => drone.id));
    for (const cell of this.cells) {
      const owner = participants.find(drone => drone.id === owners.get(cell.id));
      cell.assignedDroneId = owner?.id ?? null;
      owner?.assignedCellIds.push(cell.id);
    }
  }

  private replanUniform(): void {
    const active = this.drones.filter(drone => drone.status === 'patrolling' && drone.serviceState === 'patrol');
    for (const cell of this.cells) cell.assignedDroneId = null;
    for (const drone of this.drones) {
      drone.assignedCellIds = [];
      drone.cycleSeconds = 0;
      if ((drone.status === 'patrolling' || drone.status === 'offline') && drone.serviceState === 'patrol') {
        drone.route = [];
        drone.routeIndex = 0;
        this.plannedLegs.delete(drone.id);
      }
    }
    const groups = partition(this.cells, active.length);
    active.forEach((drone, index) => {
      drone.assignedCellIds = groups[index].map(cell => cell.id);
      drone.route = groups[index].map(cell => ({ ...cell.position, y: drone.position.y }));
      for (const cell of groups[index]) cell.assignedDroneId = drone.id;
      drone.cycleSeconds = routeSchedule(drone.route, this.patrolSpeed()).cycle;
      let nearestDistance = Infinity;
      drone.route.forEach((position, routeIndex) => {
        const distance = horizontalDistance(drone.position, position);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          drone.routeIndex = routeIndex;
        }
      });
      if (nearestDistance <= POSITION_EPSILON && drone.route.length > 1) drone.routeIndex = (drone.routeIndex + 1) % drone.route.length;
      this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[drone.routeIndex] } });
    });
    this.revision += 1;
    this.log(active.length ? `Replanned all ${active.length} healthy drones; ${this.cells.length} cells assigned.` : 'No healthy drones remain; all cells are unassigned.');
  }

  private advanceDrone(drone: PatrolDrone, seconds: number): void {
    let remaining = seconds;
    let cursor = this.time;
    while (remaining > POSITION_EPSILON) {
      const target = drone.route[drone.routeIndex];
      if (!target) return;
      const distance = horizontalDistance(drone.position, target);
      if (this.environment.batteryEnabled) {
        const moveEnergy = distance / this.patrolSpeed() * energyRate(this.patrolSpeed(), this.environment);
        const hoverEnergy = distance <= POSITION_EPSILON && drone.route.length === 1 ? remaining * energyRate(0, this.environment) : 0;
        const returnEnergy = this.returnEnergy(target);
        if (drone.batteryFraction < moveEnergy + hoverEnergy + returnEnergy + this.environment.reserveFraction + POSITION_EPSILON) {
          this.beginReturn(drone);
          this.advanceReturn(drone, remaining, cursor);
          return;
        }
      }
      if (distance <= POSITION_EPSILON) {
        if (drone.route.length === 1) {
          this.observe(drone.position, drone.position, cursor, remaining);
          this.consumeEnergy(drone, remaining, 0);
          drone.speed = 0;
          return;
        }
        drone.routeIndex = (drone.routeIndex + 1) % drone.route.length;
        this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[drone.routeIndex] } });
        continue;
      }
      const travelSeconds = Math.min(remaining, distance / this.patrolSpeed());
      const ratio = Math.min(1, this.patrolSpeed() * travelSeconds / distance);
      const nextPosition = { x: drone.position.x + (target.x - drone.position.x) * ratio, y: drone.position.y, z: drone.position.z + (target.z - drone.position.z) * ratio };
      this.observe(drone.position, nextPosition, cursor, travelSeconds);
      drone.position = nextPosition;
      drone.speed = this.patrolSpeed();
      this.consumeEnergy(drone, travelSeconds, drone.speed);
      remaining -= travelSeconds;
      cursor += travelSeconds;
      if (ratio >= 1 - POSITION_EPSILON) {
        drone.routeIndex = (drone.routeIndex + 1) % drone.route.length;
        this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[drone.routeIndex] } });
      }
    }
  }

  private advanceDeviation(drone: PatrolDrone, seconds: number): void {
    const target = this.deviationTargets.get(drone.id);
    if (!target) return;
    const distance = horizontalDistance(drone.position, target);
    const speed = Math.min(12, this.environment.maxSpeed);
    const availableSeconds = this.environment.batteryEnabled ? drone.batteryFraction / energyRate(speed, this.environment) : Infinity;
    const travelSeconds = Math.min(seconds, distance / speed, availableSeconds);
    const ratio = distance ? Math.min(1, travelSeconds * speed / distance) : 0;
    drone.position.x += (target.x - drone.position.x) * ratio;
    drone.position.z += (target.z - drone.position.z) * ratio;
    drone.speed = ratio && travelSeconds >= seconds - POSITION_EPSILON ? speed : 0;
    this.consumeEnergy(drone, travelSeconds, speed);
    if (drone.status !== 'offline') this.consumeEnergy(drone, seconds - travelSeconds, 0);
  }

  private observe(start: Vec3, end: Vec3, time: number, seconds: number): void {
    if (this.strategy.kind === 'adaptive') this.policy.observeSegment(start, end, time, seconds);
    const length = horizontalDistance(start, end);
    const directionX = length ? (end.x - start.x) / length : 0;
    const directionZ = length ? (end.z - start.z) / length : 0;
    for (const cell of this.cells) {
      const offsetX = cell.position.x - start.x;
      const offsetZ = cell.position.z - start.z;
      const projection = offsetX * directionX + offsetZ * directionZ;
      const perpendicularSquared = Math.max(0, offsetX * offsetX + offsetZ * offsetZ - projection * projection);
      if (perpendicularSquared > this.environment.sensorRadius * this.environment.sensorRadius + POSITION_EPSILON) continue;
      const span = Math.sqrt(Math.max(0, this.environment.sensorRadius * this.environment.sensorRadius - perpendicularSquared));
      if (projection + span < 0 || projection - span > length) continue;
      const lastSeen = time + seconds * (length ? Math.min(length, projection + span) / length : 1);
      cell.lastVisited = Math.max(cell.lastVisited ?? 0, lastSeen);
    }
  }

  private patrolSpeed(): number {
    return this.environment.maxSpeed * (this.strategy.kind === 'adaptive' ? this.strategy.parameters.speedFraction ?? 1 : 1);
  }

  private returnEnergy(position: Vec3): number {
    return Math.hypot(position.x - this.environment.depot.x, position.z - this.environment.depot.z) / this.environment.maxSpeed * energyRate(this.environment.maxSpeed, this.environment);
  }

  private beginReturn(drone: PatrolDrone): void {
    drone.serviceState = 'returning';
    drone.route = [{ x: this.environment.depot.x, y: drone.position.y, z: this.environment.depot.z }];
    drone.routeIndex = 0;
    drone.assignedCellIds = [];
    this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[0] } });
    this.commitmentUntil.delete(drone.id);
    this.serviceChanged = true;
    this.log(`Drone ${drone.id} returning to charge; remaining patrol paths will redistribute.`);
  }

  private advanceService(drone: PatrolDrone, seconds: number): void {
    if (drone.serviceState === 'patrol') this.advanceDrone(drone, seconds);
    else if (drone.serviceState === 'returning') this.advanceReturn(drone, seconds, this.time);
    else if (drone.serviceState === 'waiting') this.energy.waitingSeconds += seconds;
    else {
      const chargingSeconds = Math.min(seconds, (1 - drone.batteryFraction) * this.environment.rechargeSeconds);
      this.energy.chargingSeconds += chargingSeconds;
      drone.batteryFraction = Math.min(1, drone.batteryFraction + chargingSeconds / this.environment.rechargeSeconds);
      if (drone.batteryFraction >= 1 - POSITION_EPSILON) {
        drone.batteryFraction = 1;
        drone.chargeCycles += 1;
        this.energy.completedCharges += 1;
        this.energy.waitingSeconds += seconds - chargingSeconds;
        drone.serviceState = 'patrol';
        drone.route = [];
        drone.routeIndex = 0;
        this.reserveBreaches.delete(drone.id);
        this.serviceChanged = true;
        this.log(`Drone ${drone.id} fully charged and rejoining patrol.`);
      }
    }
  }

  private advanceReturn(drone: PatrolDrone, seconds: number, time: number): void {
    const target = drone.route[0];
    if (!target) return;
    const distance = horizontalDistance(drone.position, target);
    const availableSeconds = drone.batteryFraction / energyRate(this.environment.maxSpeed, this.environment);
    const travelSeconds = Math.min(seconds, distance / this.environment.maxSpeed, availableSeconds);
    const ratio = distance ? Math.min(1, travelSeconds * this.environment.maxSpeed / distance) : 1;
    drone.position.x += (target.x - drone.position.x) * ratio;
    drone.position.z += (target.z - drone.position.z) * ratio;
    drone.speed = travelSeconds > 0 ? this.environment.maxSpeed : 0;
    this.consumeEnergy(drone, travelSeconds, this.environment.maxSpeed);
    if (ratio >= 1 - POSITION_EPSILON) {
      drone.position.x = target.x;
      drone.position.z = target.z;
      drone.serviceState = 'waiting';
      drone.speed = 0;
      this.waitingSince.set(drone.id, time + travelSeconds);
      this.energy.waitingSeconds += seconds - travelSeconds;
      this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.position } });
    }
  }

  private assignChargingPads(): void {
    const occupied = this.drones.filter(drone => drone.serviceState === 'charging').length;
    const waiting = this.drones.filter(drone => drone.status === 'patrolling' && drone.serviceState === 'waiting' && drone.batteryFraction < 1 - POSITION_EPSILON)
      .sort((first, second) => (this.waitingSince.get(first.id) ?? 0) - (this.waitingSince.get(second.id) ?? 0) || first.id - second.id);
    for (const drone of waiting.slice(0, Math.max(0, this.environment.chargingPads - occupied))) {
      drone.serviceState = 'charging';
      this.waitingSince.delete(drone.id);
      this.log(`Drone ${drone.id} connected to a charging pad.`);
    }
  }

  private consumeEnergy(drone: PatrolDrone, seconds: number, speed: number): void {
    if (!this.environment.batteryEnabled || seconds <= 0) return;
    const consumed = Math.min(drone.batteryFraction, seconds * energyRate(speed, this.environment));
    drone.batteryFraction = Math.max(0, drone.batteryFraction - consumed);
    this.energy.energyUsed += consumed;
    if (drone.batteryFraction < this.environment.reserveFraction - POSITION_EPSILON && !this.reserveBreaches.has(drone.id)) {
      this.reserveBreaches.add(drone.id);
      this.energy.reserveViolations += 1;
    }
    if (drone.batteryFraction <= POSITION_EPSILON && !this.stranded.has(drone.id)) {
      this.stranded.add(drone.id);
      this.energy.strandedDrones += 1;
      drone.status = 'offline';
      drone.speed = 0;
      this.serviceChanged = true;
      this.log(`Drone ${drone.id} depleted its battery and cannot continue flight.`);
    }
  }

  private log(message: string): void {
    this.events.push({ id: ++this.eventId, time: this.time, message });
    if (this.events.length > 12) this.events.shift();
  }
}
