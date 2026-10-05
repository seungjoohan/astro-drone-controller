import { describe, expect, it } from 'vitest';
import { PatrolSystem } from './patrol';
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_PRESETS, insideEnvironment } from './patrol-environment';
import type { PatrolEnvironment } from './patrol-environment';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import type { PatrolSnapshot } from './patrol-types';

function enduranceEnvironment(overrides: Partial<PatrolEnvironment> = {}): PatrolEnvironment {
  return { ...ENVIRONMENT_PRESETS.compact, enduranceSeconds: 120, rechargeSeconds: 30, chargingPads: 1, initialChargeFraction: 0.6, ...overrides };
}

function advanceUntil(system: PatrolSystem, predicate: (snapshot: PatrolSnapshot) => boolean, timeout = 300): PatrolSnapshot {
  for (let elapsed = 0; elapsed < timeout; elapsed += 0.25) {
    const snapshot = system.snapshot();
    if (predicate(snapshot)) return snapshot;
    system.step(0.25);
  }
  throw new Error('Expected service transition did not occur.');
}

describe('patrol environment and endurance', () => {
  it('retains classic unlimited endurance and keeps environment snapshots detached', () => {
    const system = new PatrolSystem();
    const snapshot = system.snapshot();
    expect(snapshot.environment).toEqual(DEFAULT_ENVIRONMENT);
    expect(snapshot.drones.every(drone => drone.batteryFraction === 1 && drone.serviceState === 'patrol')).toBe(true);
    snapshot.environment.depot.x = 100;
    snapshot.environment.maxSpeed = 4;
    system.step(500);
    expect(system.snapshot().environment).toEqual(DEFAULT_ENVIRONMENT);
    expect(system.snapshot().energy.energyUsed).toBe(0);
    expect(system.snapshot().drones.every(drone => drone.batteryFraction === 1)).toBe(true);
  });

  it('uses rectangular bounds, configured speed and actual sensor radius', () => {
    const environment = { ...ENVIRONMENT_PRESETS.corridor, batteryEnabled: false, maxSpeed: 7, sensorRadius: 16 };
    const system = new PatrolSystem({ fleetSize: 4 }, { kind: 'uniform' }, environment);
    expect(system.snapshot().cells).toHaveLength(60);
    let previous = system.snapshot();
    for (let sample = 0; sample < 60; sample += 1) {
      system.step(0.5);
      const snapshot = system.snapshot();
      expect(snapshot.cells.every(cell => insideEnvironment(cell.position, environment))).toBe(true);
      for (const drone of snapshot.drones) {
        const before = previous.drones[drone.id - 1].position;
        expect(insideEnvironment(drone.position, environment)).toBe(true);
        expect(Math.hypot(drone.position.x - before.x, drone.position.z - before.z)).toBeLessThanOrEqual(3.5 + 1e-8);
        expect(drone.speed).toBeLessThanOrEqual(7);
      }
      previous = snapshot;
    }
    expect(new PatrolSystem({}, { kind: 'uniform' }, { ...environment, sensorRadius: 64 }).snapshot().environment.sensorRadius).toBe(64);
  });

  it('enforces learned speed bounds without changing hardware or staging', () => {
    const environment = enduranceEnvironment({ batteryEnabled: false });
    const strategy = { kind: 'adaptive' as const, parameters: { ...DEFAULT_POLICY_PARAMETERS, speedFraction: 0.5 } };
    const baseline = new PatrolSystem({ fleetSize: 3 }, { kind: 'uniform' }, environment).snapshot();
    const system = new PatrolSystem({ fleetSize: 3 }, strategy, environment);
    expect(system.snapshot().drones.map(drone => drone.position)).toEqual(baseline.drones.map(drone => drone.position));
    expect(system.snapshot().drones.map(drone => drone.batteryFraction)).toEqual(baseline.drones.map(drone => drone.batteryFraction));
    system.step(20);
    expect(system.snapshot().environment.maxSpeed).toBe(14);
    expect(system.snapshot().drones.every(drone => drone.speed <= 7)).toBe(true);
  });

  it('runs repeated safe battery rotations with bounded movement and finite pads', () => {
    const environment = enduranceEnvironment();
    const system = new PatrolSystem({ fleetSize: 3 }, { kind: 'uniform' }, environment);
    let previous = system.snapshot();
    const states = new Set<string>();
    for (let elapsed = 0; elapsed < 700; elapsed += 0.25) {
      system.step(0.25);
      const snapshot = system.snapshot();
      expect(snapshot.drones.filter(drone => drone.serviceState === 'charging').length).toBeLessThanOrEqual(1);
      for (const drone of snapshot.drones) {
        states.add(drone.serviceState);
        const before = previous.drones[drone.id - 1];
        expect(Math.hypot(drone.position.x - before.position.x, drone.position.z - before.position.z)).toBeLessThanOrEqual(environment.maxSpeed * 0.25 + 1e-8);
        expect(drone.batteryFraction).toBeGreaterThanOrEqual(environment.reserveFraction - 1e-8);
        expect(drone.batteryFraction).toBeLessThanOrEqual(1);
        if (drone.batteryFraction > before.batteryFraction + 1e-8) expect(['waiting', 'charging']).toContain(before.serviceState);
        if (drone.serviceState === 'waiting' || drone.serviceState === 'charging') {
          expect(drone.position.x).toBe(environment.depot.x);
          expect(drone.position.z).toBe(environment.depot.z);
          expect(drone.assignedCellIds).toHaveLength(0);
        }
      }
      previous = snapshot;
    }
    expect(states).toEqual(new Set(['patrol', 'returning', 'waiting', 'charging']));
    expect(previous.energy.reserveViolations).toBe(0);
    expect(previous.energy.strandedDrones).toBe(0);
    expect(previous.energy.completedCharges).toBeGreaterThan(6);
    expect(previous.drones.every(drone => drone.chargeCycles >= 2)).toBe(true);
    expect(previous.energy.energyUsed).toBeGreaterThan(3);
    expect(previous.energy.waitingSeconds).toBeGreaterThan(0);
    expect(previous.energy.chargingSeconds).toBeLessThanOrEqual(700);
    expect(previous.estimatedCoverage).toBeNull();
    expect(previous.predictedRevisitSeconds).toBeNull();
    expect(previous.recommendedFleet.achievable).toBe(false);
  });

  it('does not observe while returning, waiting or charging', () => {
    const system = new PatrolSystem({ fleetSize: 1 }, { kind: 'uniform' }, enduranceEnvironment({ rechargeSeconds: 600 }));
    const returning = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'returning');
    const lastVisited = returning.cells.map(cell => cell.lastVisited);
    const charging = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'charging');
    expect(charging.cells.map(cell => cell.lastVisited)).toEqual(lastVisited);
    system.step(20);
    const snapshot = system.snapshot();
    expect(snapshot.drones[0].serviceState).toBe('charging');
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.population.inViewPeople).toBe(0);
    expect(snapshot.cells.map(cell => cell.lastVisited)).toEqual(lastVisited);
  });

  it('services waiting aircraft in arrival order and never charges on a faulted pad', () => {
    const system = new PatrolSystem({ fleetSize: 3 }, { kind: 'uniform' }, enduranceEnvironment({ rechargeSeconds: 120 }));
    const snapshot = advanceUntil(system, state => state.drones.some(drone => drone.serviceState === 'charging') && state.drones.filter(drone => drone.serviceState === 'waiting').length >= 2);
    const charging = snapshot.drones.find(drone => drone.serviceState === 'charging')!;
    const queue = snapshot.drones.filter(drone => drone.serviceState === 'waiting').map(drone => drone.id);
    const order = new Map<number, number>();
    const internal = system as unknown as { waitingSince: Map<number, number> };
    for (const id of queue) order.set(id, internal.waitingSince.get(id)!);
    system.injectFault(charging.id, 'malfunction');
    const fraction = system.snapshot().drones[charging.id - 1].batteryFraction;
    system.step(3);
    expect(system.snapshot().drones[charging.id - 1].status).toBe('offline');
    expect(system.snapshot().drones[charging.id - 1].batteryFraction).toBe(fraction);
    expect(system.snapshot().drones.filter(drone => drone.serviceState === 'charging')).toHaveLength(1);
    system.restoreDrone(charging.id);
    const next = advanceUntil(system, state => state.drones.some(drone => drone.id !== charging.id && drone.serviceState === 'charging'));
    const expected = queue.sort((first, second) => order.get(first)! - order.get(second)! || first - second)[0];
    expect(next.drones.find(drone => drone.serviceState === 'charging')?.id).toBe(expected);
  });

  it('detects a return-flight malfunction without restoring battery on recovery', () => {
    const system = new PatrolSystem({ fleetSize: 1 }, { kind: 'uniform' }, enduranceEnvironment());
    const before = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'returning');
    system.injectFault(1, 'malfunction');
    system.step(2.9);
    expect(system.snapshot().drones[0].status).toBe('unresponsive');
    system.step(0.1);
    const failed = system.snapshot();
    expect(failed.drones[0].status).toBe('offline');
    expect(failed.drones[0].serviceState).toBe('returning');
    expect(failed.drones[0].batteryFraction).toBeLessThan(before.drones[0].batteryFraction);
    system.restoreDrone(1);
    expect(system.snapshot().drones[0].batteryFraction).toBe(failed.drones[0].batteryFraction);
    expect(system.snapshot().drones[0].position).toEqual(failed.drones[0].position);
    system.step(20);
    expect(system.snapshot().drones[0].serviceState).toBe('charging');
  });

  it('records impossible initial return energy and never revives depleted aircraft for free', () => {
    const environment = { ...DEFAULT_ENVIRONMENT, batteryEnabled: true, maxSpeed: 4, enduranceSeconds: 120, initialChargeFraction: 0.5 };
    const system = new PatrolSystem({ fleetSize: 1 }, { kind: 'uniform' }, environment);
    system.step(120);
    const snapshot = system.snapshot();
    expect(snapshot.energy.reserveViolations).toBe(1);
    expect(snapshot.energy.strandedDrones).toBe(1);
    expect(snapshot.drones[0].status).toBe('offline');
    expect(snapshot.drones[0].batteryFraction).toBeLessThanOrEqual(1e-8);
    const position = snapshot.drones[0].position;
    expect(Math.hypot(position.x, position.z)).toBeGreaterThan(1);
    system.restoreDrone(1);
    system.step(30);
    expect(system.snapshot().drones[0].status).toBe('offline');
    expect(system.snapshot().drones[0].batteryFraction).toBe(snapshot.drones[0].batteryFraction);
    expect(system.snapshot().drones[0].position).toEqual(position);
    expect(system.snapshot().energy.strandedDrones).toBe(1);
  });

  it('is deterministic across chunk sizes and resets environment only when requested', () => {
    const environment = enduranceEnvironment();
    const first = new PatrolSystem({ fleetSize: 2 }, { kind: 'uniform' }, environment);
    const second = new PatrolSystem({ fleetSize: 2 }, { kind: 'uniform' }, environment);
    first.step(300);
    for (let elapsed = 0; elapsed < 300; elapsed += 0.5) second.step(0.5);
    expect(first.snapshot()).toEqual(second.snapshot());
    const before = first.snapshot();
    expect(() => first.reset({ fleetSize: 3 }, { ...environment, chargingPads: 0 })).toThrow('Invalid patrol environment');
    expect(first.snapshot()).toEqual(before);
    first.reset({ fleetSize: 4 });
    expect(first.snapshot().environment).toEqual(environment);
    expect(first.snapshot().energy.energyUsed).toBe(0);
    first.reset({}, DEFAULT_ENVIRONMENT);
    expect(first.snapshot().environment).toEqual(DEFAULT_ENVIRONMENT);
  });
});
