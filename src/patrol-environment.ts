import type { Vec3 } from './types';

export interface PatrolEnvironment {
  id: string;
  shape: 'circle' | 'rectangle';
  width: number;
  depth: number;
  maxSpeed: number;
  sensorRadius: number;
  batteryEnabled: boolean;
  enduranceSeconds: number;
  rechargeSeconds: number;
  reserveFraction: number;
  chargingPads: number;
  depot: { x: number; z: number };
  initialChargeFraction: number;
}

export interface PatrolEnergyMetrics {
  energyUsed: number;
  reserveViolations: number;
  strandedDrones: number;
  completedCharges: number;
  chargingSeconds: number;
  waitingSeconds: number;
}

export const DEFAULT_ENVIRONMENT: Readonly<PatrolEnvironment> = Object.freeze({
  id: 'classic', shape: 'circle', width: 640, depth: 640, maxSpeed: 18, sensorRadius: 32,
  batteryEnabled: false, enduranceSeconds: 300, rechargeSeconds: 120, reserveFraction: 0.2,
  chargingPads: 2, depot: Object.freeze({ x: 0, z: 0 }), initialChargeFraction: 1,
});

export const ENVIRONMENT_PRESETS: Readonly<Record<string, Readonly<PatrolEnvironment>>> = Object.freeze({
  classic: DEFAULT_ENVIRONMENT,
  compact: Object.freeze({ ...DEFAULT_ENVIRONMENT, id: 'compact', width: 360, depth: 360, maxSpeed: 14, batteryEnabled: true, enduranceSeconds: 240, rechargeSeconds: 90 }),
  district: Object.freeze({ ...DEFAULT_ENVIRONMENT, id: 'district', shape: 'rectangle', width: 520, depth: 360, batteryEnabled: true }),
  corridor: Object.freeze({ ...DEFAULT_ENVIRONMENT, id: 'corridor', shape: 'rectangle', width: 600, depth: 160, maxSpeed: 22, batteryEnabled: true, enduranceSeconds: 360, rechargeSeconds: 150, chargingPads: 1, depot: Object.freeze({ x: -240, z: 0 }) }),
});

export function insideEnvironment(position: Pick<Vec3, 'x' | 'z'>, environment: PatrolEnvironment, margin = 0): boolean {
  const halfWidth = environment.width / 2 - margin;
  const halfDepth = environment.depth / 2 - margin;
  if (halfWidth <= 0 || halfDepth <= 0) return false;
  return environment.shape === 'circle'
    ? Math.hypot(position.x, position.z) <= halfWidth + 1e-8
    : Math.abs(position.x) <= halfWidth + 1e-8 && Math.abs(position.z) <= halfDepth + 1e-8;
}

export function validateEnvironment(value: unknown): PatrolEnvironment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const environment = value as Record<string, unknown>;
  const bounded = (entry: unknown, minimum: number, maximum: number) => typeof entry === 'number' && Number.isFinite(entry) && entry >= minimum && entry <= maximum;
  if (typeof environment.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(environment.id)
    || !['circle', 'rectangle'].includes(String(environment.shape))
    || !bounded(environment.width, 120, 640) || !bounded(environment.depth, 120, 640)
    || environment.shape === 'circle' && environment.width !== environment.depth
    || !bounded(environment.maxSpeed, 4, 30) || !bounded(environment.sensorRadius, 16, 64)
    || typeof environment.batteryEnabled !== 'boolean' || !bounded(environment.enduranceSeconds, 120, 1800)
    || !bounded(environment.rechargeSeconds, 30, 1800) || !bounded(environment.reserveFraction, 0.1, 0.4)
    || !bounded(environment.chargingPads, 1, 8) || !Number.isInteger(environment.chargingPads)
    || !bounded(environment.initialChargeFraction, 0.5, 1)
    || !environment.depot || typeof environment.depot !== 'object' || Array.isArray(environment.depot)) return null;
  const depot = environment.depot as Record<string, unknown>;
  if (!bounded(depot.x, -320, 320) || !bounded(depot.z, -320, 320)) return null;
  const parsed = {
    id: environment.id, shape: environment.shape, width: environment.width, depth: environment.depth,
    maxSpeed: environment.maxSpeed, sensorRadius: environment.sensorRadius, batteryEnabled: environment.batteryEnabled,
    enduranceSeconds: environment.enduranceSeconds, rechargeSeconds: environment.rechargeSeconds,
    reserveFraction: environment.reserveFraction, chargingPads: environment.chargingPads,
    depot: { x: depot.x, z: depot.z }, initialChargeFraction: environment.initialChargeFraction,
  } as PatrolEnvironment;
  return insideEnvironment(parsed.depot, parsed) ? parsed : null;
}

export function environmentKey(environment: PatrolEnvironment): string {
  const validated = validateEnvironment(environment);
  if (!validated) throw new Error('Invalid patrol environment.');
  return JSON.stringify({ ...validated, id: '' });
}

export function energyRate(speed: number, environment: PatrolEnvironment): number {
  const fraction = Math.max(0, Math.min(1, speed / environment.maxSpeed));
  return (0.55 + 0.45 * fraction ** 2) / environment.enduranceSeconds;
}
