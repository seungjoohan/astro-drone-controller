import { FLIGHT_MAPS } from './maps';
import { evaluatePopulation, populateCells, POPULATION_DEFAULTS, POPULATION_LIMITS } from './population';
import type { FleetRecommendation, PatrolCell, PatrolConfig, PatrolDrone, PatrolEvent, PatrolFault, PatrolSnapshot } from './patrol-types';
import type { Vec3 } from './types';

export const PATROL_LIMITS = Object.freeze({ maxDrones: 8, speed: 18, sensorRadius: 32, cellSize: 40, detectionSeconds: 3 });

const POSITION_EPSILON = 1e-8;
const MAX_STEP_SECONDS = 3600;
const HEALTH_INTERVAL = 0.1;
const DEVIATION_TOLERANCE = 8;
const COLORS = ['#416b28', '#985c23', '#246f8a', '#a14f7a', '#70549c', '#75651d', '#23745b', '#a14643'];
const MAP_RADIUS = FLIGHT_MAPS.nyc.radius;

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

function createCells(revisitSeconds = 120): PatrolCell[] {
  const cells: PatrolCell[] = [];
  let rowIndex = 0;
  for (let depth = -MAP_RADIUS + PATROL_LIMITS.cellSize / 2; depth < MAP_RADIUS; depth += PATROL_LIMITS.cellSize) {
    const row: Vec3[] = [];
    for (let horizontal = -MAP_RADIUS + PATROL_LIMITS.cellSize / 2; horizontal < MAP_RADIUS; horizontal += PATROL_LIMITS.cellSize) {
      if (Math.hypot(horizontal, depth) <= MAP_RADIUS) row.push({ x: horizontal, y: 0, z: depth });
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

function routeSchedule(route: Vec3[]): { arrivals: number[]; cycle: number } {
  const arrivals: number[] = [];
  let cycle = 0;
  for (let index = 0; index < route.length; index += 1) {
    arrivals.push(cycle);
    cycle += horizontalDistance(route[index], route[(index + 1) % route.length]) / PATROL_LIMITS.speed;
  }
  return { arrivals, cycle };
}

function minimumFreshCells(route: Vec3[], revisitSeconds: number): number {
  const { arrivals, cycle } = routeSchedule(route);
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

function estimateCoverage(routes: Vec3[][], revisitSeconds: number): number {
  return 100 * routes.reduce((total, route) => total + minimumFreshCells(route, revisitSeconds), 0) / CELL_POSITIONS.length;
}

export function recommendFleet(config: Pick<PatrolConfig, 'coverageTarget' | 'revisitSeconds'>): FleetRecommendation {
  const coverageTarget = bounded(config.coverageTarget, 95, 0, 100);
  const revisitSeconds = bounded(config.revisitSeconds, 120, 1, 3600);
  let estimatedCoverage = 0;
  for (let count = 1; count <= PATROL_LIMITS.maxDrones; count += 1) {
    const routes = partition(CELL_POSITIONS, count);
    estimatedCoverage = estimateCoverage(routes, revisitSeconds);
    if (estimatedCoverage + POSITION_EPSILON >= coverageTarget) return { count, achievable: true, estimatedCoverage, revisitSeconds: Math.max(...routes.map(route => routeSchedule(route).cycle)) };
  }
  return { count: PATROL_LIMITS.maxDrones, achievable: false, estimatedCoverage, revisitSeconds: Math.max(...partition(CELL_POSITIONS, PATROL_LIMITS.maxDrones).map(route => routeSchedule(route).cycle)) };
}

export const PATROL_DEFAULTS: Readonly<PatrolConfig> = Object.freeze({
  ...POPULATION_DEFAULTS,
  coverageTarget: 95,
  revisitSeconds: 120,
  fleetSize: recommendFleet({ coverageTarget: 95, revisitSeconds: 120 }).count,
});

export class PatrolSystem {
  private config: PatrolConfig = { ...PATROL_DEFAULTS };
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

  constructor(config: Partial<PatrolConfig> = {}) {
    this.reset(config);
  }

  reset(overrides: Partial<PatrolConfig> = {}): void {
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
    this.recommendation = recommendFleet(this.config);
    this.time = 0;
    this.cells = createCells(revisitSeconds);
    populateCells(this.cells, this.config);
    this.revision = 0;
    this.events = [];
    this.eventId = 0;
    this.lastHeartbeat.clear();
    this.deviationSince.clear();
    this.plannedLegs.clear();
    this.deviationTargets.clear();
    this.drones = Array.from({ length: this.config.fleetSize }, (_, index) => ({
      id: index + 1,
      color: COLORS[index],
      status: 'patrolling',
      fault: null,
      position: { x: 0, y: 260 + index * 4, z: 0 },
      route: [],
      assignedCellIds: [],
      routeIndex: 0,
      cycleSeconds: 0,
    }));
    this.replan();
    for (const drone of this.drones) {
      drone.position = { ...drone.route[0] };
      drone.routeIndex = drone.route.length > 1 ? 1 : 0;
      this.lastHeartbeat.set(drone.id, 0);
      this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[drone.routeIndex] } });
    }
  }

  step(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    let remaining = Math.min(dtSeconds, MAX_STEP_SECONDS);
    while (remaining > POSITION_EPSILON) {
      let interval = remaining;
      const pending = this.drones.some(drone => drone.status === 'unresponsive' || drone.status === 'deviating');
      if (pending) interval = Math.min(interval, (Math.floor((this.time + POSITION_EPSILON) / HEALTH_INTERVAL) + 1) * HEALTH_INTERVAL - this.time);
      for (const drone of this.drones) {
        if (drone.status === 'unresponsive') interval = Math.min(interval, Math.max(0, (this.lastHeartbeat.get(drone.id) ?? this.time) + PATROL_LIMITS.detectionSeconds - this.time));
      }
      if (interval > POSITION_EPSILON) {
        for (const drone of this.drones) {
          if (drone.status === 'patrolling') this.advanceDrone(drone, interval);
          else if (drone.status === 'deviating') this.advanceDeviation(drone, interval);
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
      if (confirmed) this.replan();
    }
  }

  snapshot(): PatrolSnapshot {
    const active = this.drones.filter(drone => drone.status === 'patrolling');
    const covered = this.cells.filter(cell => cell.lastVisited !== null && this.time - cell.lastVisited <= this.config.revisitSeconds + POSITION_EPSILON);
    const visited = this.cells.filter(cell => cell.lastVisited !== null);
    const fullyAssigned = this.cells.every(cell => active.some(drone => drone.id === cell.assignedDroneId));
    return {
      config: { ...this.config },
      time: this.time,
      drones: this.drones.map(drone => ({ ...drone, position: { ...drone.position }, route: drone.route.map(position => ({ ...position })), assignedCellIds: [...drone.assignedCellIds] })),
      cells: this.cells.map(cell => ({ ...cell, position: { ...cell.position } })),
      population: evaluatePopulation(this.cells, this.time, this.config, this.drones, PATROL_LIMITS.sensorRadius),
      coverage: 100 * covered.length / this.cells.length,
      everCovered: 100 * visited.length / this.cells.length,
      uncoveredCells: this.cells.length - covered.length,
      maxAge: visited.length ? Math.max(0, ...visited.map(cell => this.time - cell.lastVisited!)) : null,
      recommendedFleet: { ...this.recommendation },
      estimatedCoverage: estimateCoverage(active.map(drone => drone.route), this.config.revisitSeconds),
      predictedRevisitSeconds: active.length && fullyAssigned ? Math.max(...active.map(drone => drone.cycleSeconds)) : Infinity,
      activeCount: active.length,
      revision: this.revision,
      events: this.events.map(event => ({ ...event })),
    };
  }

  injectFault(id: number, kind: PatrolFault): void {
    const drone = this.drones.find(candidate => candidate.id === id);
    if (!drone || drone.status !== 'patrolling' || (kind !== 'malfunction' && kind !== 'deviation')) return;
    drone.fault = kind;
    drone.status = kind === 'malfunction' ? 'unresponsive' : 'deviating';
    this.lastHeartbeat.set(id, this.time);
    if (kind === 'deviation') {
      const waypoint = drone.route[drone.routeIndex];
      const distance = Math.max(horizontalDistance(drone.position, waypoint), 1);
      const direction = { x: -(waypoint.z - drone.position.z) / distance, z: (waypoint.x - drone.position.x) / distance };
      let target = { x: drone.position.x + direction.x * 80, y: drone.position.y, z: drone.position.z + direction.z * 80 };
      if (Math.hypot(target.x, target.z) > MAP_RADIUS) target = { x: drone.position.x - direction.x * 80, y: drone.position.y, z: drone.position.z - direction.z * 80 };
      const radius = Math.hypot(target.x, target.z);
      if (radius > MAP_RADIUS) {
        target.x *= MAP_RADIUS / radius;
        target.z *= MAP_RADIUS / radius;
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
    this.lastHeartbeat.set(id, this.time);
    this.deviationSince.delete(id);
    this.deviationTargets.delete(id);
    this.log(`Drone ${id} restored at its current position.`);
    this.replan();
  }

  private replan(): void {
    const active = this.drones.filter(drone => drone.status === 'patrolling');
    for (const cell of this.cells) cell.assignedDroneId = null;
    for (const drone of this.drones) {
      drone.assignedCellIds = [];
      drone.cycleSeconds = 0;
      if (drone.status === 'patrolling' || drone.status === 'offline') {
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
      drone.cycleSeconds = routeSchedule(drone.route).cycle;
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
      if (distance <= POSITION_EPSILON) {
        if (drone.route.length === 1) {
          this.observe(drone.position, drone.position, cursor, remaining);
          return;
        }
        drone.routeIndex = (drone.routeIndex + 1) % drone.route.length;
        this.plannedLegs.set(drone.id, { start: { ...drone.position }, end: { ...drone.route[drone.routeIndex] } });
        continue;
      }
      const travelSeconds = Math.min(remaining, distance / PATROL_LIMITS.speed);
      const ratio = Math.min(1, PATROL_LIMITS.speed * travelSeconds / distance);
      const nextPosition = { x: drone.position.x + (target.x - drone.position.x) * ratio, y: drone.position.y, z: drone.position.z + (target.z - drone.position.z) * ratio };
      this.observe(drone.position, nextPosition, cursor, travelSeconds);
      drone.position = nextPosition;
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
    const ratio = distance ? Math.min(1, seconds * 12 / distance) : 0;
    drone.position.x += (target.x - drone.position.x) * ratio;
    drone.position.z += (target.z - drone.position.z) * ratio;
  }

  private observe(start: Vec3, end: Vec3, time: number, seconds: number): void {
    const length = horizontalDistance(start, end);
    const directionX = length ? (end.x - start.x) / length : 0;
    const directionZ = length ? (end.z - start.z) / length : 0;
    for (const cell of this.cells) {
      const offsetX = cell.position.x - start.x;
      const offsetZ = cell.position.z - start.z;
      const projection = offsetX * directionX + offsetZ * directionZ;
      const perpendicularSquared = Math.max(0, offsetX * offsetX + offsetZ * offsetZ - projection * projection);
      if (perpendicularSquared > PATROL_LIMITS.sensorRadius * PATROL_LIMITS.sensorRadius + POSITION_EPSILON) continue;
      const span = Math.sqrt(Math.max(0, PATROL_LIMITS.sensorRadius * PATROL_LIMITS.sensorRadius - perpendicularSquared));
      if (projection + span < 0 || projection - span > length) continue;
      const lastSeen = time + seconds * (length ? Math.min(length, projection + span) / length : 1);
      cell.lastVisited = Math.max(cell.lastVisited ?? 0, lastSeen);
    }
  }

  private log(message: string): void {
    this.events.push({ id: ++this.eventId, time: this.time, message });
    if (this.events.length > 12) this.events.shift();
  }
}
