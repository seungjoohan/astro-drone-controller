import { DEFAULT_ENVIRONMENT, insideEnvironment, validateEnvironment } from './patrol-environment';
import type { PatrolEnvironment } from './patrol-environment';
import type { PatrolSnapshot } from './patrol-types';

export class PatrolCoverageAudit {
  private readonly spacing: number;
  private readonly sensorRadius: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly lastSeen: Float64Array;
  private readonly inside: Uint8Array;
  readonly pointCount: number;

  constructor(spacing = 10, environment: PatrolEnvironment = DEFAULT_ENVIRONMENT) {
    const validated = validateEnvironment(environment);
    if (!validated) throw new Error('Invalid audit environment.');
    this.spacing = Number.isFinite(spacing) ? Math.max(5, Math.min(40, spacing)) : 10;
    this.sensorRadius = validated.sensorRadius;
    this.columns = Math.ceil(validated.width / this.spacing);
    this.rows = Math.ceil(validated.depth / this.spacing);
    this.originX = -validated.width / 2 + this.spacing / 2;
    this.originZ = -validated.depth / 2 + this.spacing / 2;
    this.lastSeen = new Float64Array(this.columns * this.rows).fill(-Infinity);
    this.inside = new Uint8Array(this.lastSeen.length);
    let pointCount = 0;
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const horizontal = this.originX + column * this.spacing;
        const depth = this.originZ + row * this.spacing;
        if (!insideEnvironment({ x: horizontal, z: depth }, validated)) continue;
        this.inside[row * this.columns + column] = 1;
        pointCount += 1;
      }
    }
    this.pointCount = pointCount;
  }

  observe(snapshot: Pick<PatrolSnapshot, 'time' | 'drones'>): void {
    if (!Number.isFinite(snapshot.time) || snapshot.time < 0) return;
    const radiusSquared = this.sensorRadius ** 2;
    for (const drone of snapshot.drones) {
      if (drone.status !== 'patrolling' || drone.fault !== null || drone.serviceState && drone.serviceState !== 'patrol') continue;
      const { x: horizontal, z: depth } = drone.position;
      if (!Number.isFinite(horizontal) || !Number.isFinite(depth)) continue;
      const firstColumn = Math.max(0, Math.ceil((horizontal - this.sensorRadius - this.originX) / this.spacing));
      const lastColumn = Math.min(this.columns - 1, Math.floor((horizontal + this.sensorRadius - this.originX) / this.spacing));
      const firstRow = Math.max(0, Math.ceil((depth - this.sensorRadius - this.originZ) / this.spacing));
      const lastRow = Math.min(this.rows - 1, Math.floor((depth + this.sensorRadius - this.originZ) / this.spacing));
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const index = row * this.columns + column;
          if (!this.inside[index]) continue;
          const horizontalOffset = this.originX + column * this.spacing - horizontal;
          const depthOffset = this.originZ + row * this.spacing - depth;
          if (horizontalOffset ** 2 + depthOffset ** 2 > radiusSquared + 1e-8) continue;
          this.lastSeen[index] = Math.max(this.lastSeen[index], snapshot.time);
        }
      }
    }
  }

  measure(time: number, revisitSeconds: number): { coverage: number; neverObserved: number; maxAge: number } {
    const currentTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    const window = Number.isFinite(revisitSeconds) ? Math.max(0, revisitSeconds) : 0;
    let fresh = 0;
    let neverObserved = 0;
    let maxAge = 0;
    for (let index = 0; index < this.lastSeen.length; index += 1) {
      if (!this.inside[index]) continue;
      const observed = Number.isFinite(this.lastSeen[index]);
      if (!observed) neverObserved += 1;
      const age = observed ? Math.max(0, currentTime - this.lastSeen[index]) : currentTime + window;
      if (observed && age <= window + 1e-8) fresh += 1;
      maxAge = Math.max(maxAge, age);
    }
    return { coverage: 100 * fresh / this.pointCount, neverObserved, maxAge };
  }
}
