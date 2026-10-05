import type { PatrolStrategy, PolicyParameters } from './patrol-learning-types';
import { insideEnvironment } from './patrol-environment';
import type { PatrolEnvironment } from './patrol-environment';
import type { Vec3 } from './types';

export const DEFAULT_POLICY_PARAMETERS: Readonly<PolicyParameters> = Object.freeze({
  populationWeight: 2,
  coverageWeight: 20,
  ageExponent: 2,
  travelPenalty: 1,
  commitmentSeconds: 3,
  speedFraction: 1,
});

export const POLICY_PARAMETER_LIMITS: Readonly<Record<keyof PolicyParameters, readonly [number, number]>> = Object.freeze({
  populationWeight: [0, 20],
  coverageWeight: [0.01, 30],
  ageExponent: [1, 4],
  travelPenalty: [0, 5],
  commitmentSeconds: [1, 15],
  speedFraction: [0.5, 1],
});

export function validateStrategy(value: unknown): PatrolStrategy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const strategy = value as Record<string, unknown>;
  if (strategy.kind === 'uniform' && Object.keys(strategy).length === 1) return { kind: 'uniform' };
  if (strategy.kind !== 'adaptive' || Object.keys(strategy).length !== 2 || !strategy.parameters || typeof strategy.parameters !== 'object' || Array.isArray(strategy.parameters)) return null;
  const parameters = strategy.parameters as Record<string, unknown>;
  const allKeys = Object.keys(POLICY_PARAMETER_LIMITS) as (keyof PolicyParameters)[];
  const keys = allKeys.filter(key => key !== 'speedFraction' || 'speedFraction' in parameters);
  if (Object.keys(parameters).length !== keys.length) return null;
  for (const key of keys) {
    const candidate = parameters[key];
    const [minimum, maximum] = POLICY_PARAMETER_LIMITS[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) return null;
  }
  return { kind: 'adaptive', parameters: Object.fromEntries(keys.map(key => [key, parameters[key]])) as unknown as PolicyParameters };
}

export interface PolicyCell {
  readonly id: number;
  readonly position: Readonly<Vec3>;
  readonly lastVisited: number | null;
  readonly population: number;
  readonly targetRevisitSeconds: number;
}

export interface PolicyAircraft {
  readonly id: number;
  readonly position: Readonly<Vec3>;
  readonly destination: Readonly<Vec3> | null;
  readonly committed: boolean;
}

interface Footprint {
  position: Vec3;
  cells: number[];
  geographic: number[];
}

export function assignPolicyRegions(cellCount: number, aircraftIds: readonly number[]): Map<number, number> {
  const owners = new Map<number, number>();
  aircraftIds.forEach((id, index) => {
    for (let cell = Math.floor(index * cellCount / aircraftIds.length); cell < Math.floor((index + 1) * cellCount / aircraftIds.length); cell += 1) owners.set(cell, id);
  });
  return owners;
}

export class PopulationPolicy {
  private footprints: Footprint[] = [];
  private candidates: Vec3[];
  private positions: Readonly<Vec3>[];
  private geography: { position: Vec3; lastVisited: number | null }[];
  private readonly sensorRadius: number;
  private readonly geographicScale: number;
  private readonly geographicSpacing: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly geographicLookup: Int32Array;

  constructor(positions: readonly Readonly<Vec3>[], radius: number, sensorRadius: number, spacing: number, environment?: PatrolEnvironment) {
    this.sensorRadius = sensorRadius;
    const inside = (position: Vec3) => environment ? insideEnvironment(position, environment) : Math.hypot(position.x, position.z) <= radius;
    const width = environment?.width ?? radius * 2;
    const depth = environment?.depth ?? radius * 2;
    const geographicSpacing = spacing / 2;
    this.geographicSpacing = geographicSpacing;
    this.originX = -width / 2 + geographicSpacing / 2;
    this.originZ = -depth / 2 + geographicSpacing / 2;
    this.columns = Math.ceil(width / geographicSpacing);
    this.rows = Math.ceil(depth / geographicSpacing);
    this.geographicLookup = new Int32Array(this.columns * this.rows).fill(-1);
    this.geography = [];
    let rowIndex = 0;
    for (let depthCoordinate = -depth / 2 + geographicSpacing / 2; depthCoordinate < depth / 2; depthCoordinate += geographicSpacing) {
      const row: Vec3[] = [];
      for (let horizontalCoordinate = -width / 2 + geographicSpacing / 2; horizontalCoordinate < width / 2; horizontalCoordinate += geographicSpacing) {
        const position = { x: horizontalCoordinate, y: 0, z: depthCoordinate };
        if (inside(position)) row.push(position);
      }
      if (rowIndex % 2) row.reverse();
      this.geography.push(...row.map(position => ({ position, lastVisited: null })));
      rowIndex += 1;
    }
    this.geography.forEach((cell, index) => {
      const column = Math.round((cell.position.x - this.originX) / geographicSpacing);
      const row = Math.round((cell.position.z - this.originZ) / geographicSpacing);
      this.geographicLookup[row * this.columns + column] = index;
    });
    this.geographicScale = positions.length / Math.max(1, this.geography.length);
    const candidates = positions.map(position => ({ ...position }));
    const horizontal = [...new Set(positions.map(position => position.x))].sort((first, second) => first - second);
    const depths = [...new Set(positions.map(position => position.z))].sort((first, second) => first - second);
    for (const coordinate of horizontal) {
      for (const depth of depths) {
        const position = { x: coordinate + spacing / 2, y: 0, z: depth + spacing / 2 };
        if (inside(position)) candidates.push(position);
      }
    }
    candidates.push(...this.geography.map(cell => ({ ...cell.position })));
    const unique = new Map(candidates.map(position => [`${position.x},${position.z}`, position]));
    this.candidates = [...unique.values()];
    this.positions = positions.map(position => ({ ...position }));
  }

  observeSegment(start: Readonly<Vec3>, end: Readonly<Vec3>, startTime: number, duration: number): void {
    const horizontal = end.x - start.x;
    const depth = end.z - start.z;
    const distance = Math.hypot(horizontal, depth);
    const radiusSquared = this.sensorRadius ** 2;
    const firstColumn = Math.max(0, Math.ceil((Math.min(start.x, end.x) - this.sensorRadius - this.originX) / this.geographicSpacing));
    const lastColumn = Math.min(this.columns - 1, Math.floor((Math.max(start.x, end.x) + this.sensorRadius - this.originX) / this.geographicSpacing));
    const firstRow = Math.max(0, Math.ceil((Math.min(start.z, end.z) - this.sensorRadius - this.originZ) / this.geographicSpacing));
    const lastRow = Math.min(this.rows - 1, Math.floor((Math.max(start.z, end.z) + this.sensorRadius - this.originZ) / this.geographicSpacing));
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const index = this.geographicLookup[row * this.columns + column];
        if (index < 0) continue;
        const cell = this.geography[index];
        const offsetX = cell.position.x - start.x;
        const offsetZ = cell.position.z - start.z;
        if (distance <= 1e-8) {
          if (offsetX ** 2 + offsetZ ** 2 <= radiusSquared + 1e-8) cell.lastVisited = Math.max(cell.lastVisited ?? -Infinity, startTime + duration);
          continue;
        }
        const projection = (offsetX * horizontal + offsetZ * depth) / distance;
        const perpendicularSquared = Math.max(0, offsetX ** 2 + offsetZ ** 2 - projection ** 2);
        if (perpendicularSquared > radiusSquared + 1e-8) continue;
        const span = Math.sqrt(Math.max(0, radiusSquared - perpendicularSquared));
        if (projection + span < 0 || projection - span > distance) continue;
        const observedAt = startTime + duration * Math.min(1, Math.max(0, (projection + span) / distance));
        cell.lastVisited = Math.max(cell.lastVisited ?? -Infinity, observedAt);
      }
    }
  }

  choose(cells: readonly PolicyCell[], aircraft: readonly PolicyAircraft[], time: number, revisitSeconds: number, speed: number, parameters: Readonly<PolicyParameters>): Map<number, Vec3> {
    if (!this.footprints.length) {
      const radiusSquared = this.sensorRadius ** 2 + 1e-8;
      this.footprints = this.candidates.map(position => ({
        position,
        cells: this.positions.flatMap((cell, index) => (cell.x - position.x) ** 2 + (cell.z - position.z) ** 2 <= radiusSquared ? [index] : []),
        geographic: this.geography.flatMap((cell, index) => (cell.position.x - position.x) ** 2 + (cell.position.z - position.z) ** 2 <= radiusSquared ? [index] : []),
      })).filter(footprint => footprint.cells.length > 0 || footprint.geographic.length > 0);
    }
    const result = new Map<number, Vec3>();
    const reserved = new Set<number>();
    const reservedGeography = new Set<number>();
    const averagePopulation = Math.max(1, cells.reduce((total, cell) => total + cell.population, 0) / cells.length);
    const owners = assignPolicyRegions(cells.length, aircraft.map(drone => drone.id));
    const geographicOwners = assignPolicyRegions(this.geography.length, aircraft.map(drone => drone.id));
    const geographicUrgency = this.geography.map(cell => {
      const age = cell.lastVisited === null ? time + revisitSeconds : Math.max(0, time - cell.lastVisited);
      const geographicAge = age / revisitSeconds;
      const geographic = geographicAge ** parameters.ageExponent + 40 * Math.max(0, geographicAge - 0.65) ** 2;
      return parameters.coverageWeight * geographic * this.geographicScale;
    });
    const urgency = cells.map(cell => {
      const age = cell.lastVisited === null ? time + cell.targetRevisitSeconds : Math.max(0, time - cell.lastVisited);
      const populated = cell.population / averagePopulation * (age / cell.targetRevisitSeconds) ** parameters.ageExponent;
      return parameters.populationWeight * populated;
    });
    const reserve = (destination: Readonly<Vec3>) => {
      const footprint = this.footprints.find(candidate => candidate.position.x === destination.x && candidate.position.z === destination.z);
      for (const cell of footprint?.cells ?? []) reserved.add(cell);
      for (const cell of footprint?.geographic ?? []) reservedGeography.add(cell);
    };
    for (const drone of aircraft) {
      if (drone.committed && drone.destination) {
        result.set(drone.id, { ...drone.destination });
        reserve(drone.destination);
      }
    }
    const available = aircraft.filter(drone => !result.has(drone.id));
    const offset = available.length ? Math.floor(time + 1e-8) % available.length : 0;
    const ordered = [...available.slice(offset), ...available.slice(0, offset)];
    for (const drone of ordered) {
      let selected = this.footprints[0];
      let bestScore = -Infinity;
      for (const footprint of this.footprints) {
        const distance = Math.hypot(footprint.position.x - drone.position.x, footprint.position.z - drone.position.z);
        const travel = distance / speed;
        let gain = 0;
        for (const cell of footprint.cells) gain += urgency[cell] * (reserved.has(cell) ? 0.02 : 1) * (owners.get(cell) === drone.id ? 1 : 0.05);
        for (const cell of footprint.geographic) gain += geographicUrgency[cell] * (reservedGeography.has(cell) ? 0.02 : 1) * (geographicOwners.get(cell) === drone.id ? 1 : 0.05);
        const score = gain / (1 + parameters.travelPenalty * travel / revisitSeconds * 120);
        if (score > bestScore + 1e-8) {
          selected = footprint;
          bestScore = score;
        }
      }
      const destination = { ...selected.position, y: drone.position.y };
      result.set(drone.id, destination);
      reserve(destination);
    }
    return result;
  }
}
