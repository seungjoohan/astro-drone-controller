import { describe, expect, it } from 'vitest';
import { PatrolSystem } from './patrol';
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_PRESETS, insideEnvironment } from './patrol-environment';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import type { ExternalPatrolCommand } from './patrol-external';
import type { PatrolSnapshot } from './patrol-types';

function externalSystem(fleetSize = 2, batteryEnabled = false): PatrolSystem {
  const system = new PatrolSystem({ fleetSize }, { kind: 'uniform' }, {
    ...ENVIRONMENT_PRESETS.compact, batteryEnabled, enduranceSeconds: 120, rechargeSeconds: 30, chargingPads: 1,
  });
  system.enableExternalControl();
  return system;
}

function advanceUntil(system: PatrolSystem, predicate: (snapshot: PatrolSnapshot) => boolean, timeout = 300): PatrolSnapshot {
  for (let elapsed = 0; elapsed < timeout; elapsed += 0.25) {
    const snapshot = system.snapshot();
    if (predicate(snapshot)) return snapshot;
    system.step(0.25);
  }
  throw new Error('Expected external service transition did not occur.');
}

describe('external patrol control', () => {
  it('takes over without changing time, staging, visits, batteries or pending fault evidence', () => {
    const system = new PatrolSystem({ fleetSize: 3 });
    system.step(2);
    system.injectFault(1, 'deviation');
    system.step(1);
    const before = system.snapshot();
    system.enableExternalControl();
    const after = system.snapshot();
    expect(after.time).toBe(before.time);
    expect(after.cells.map(cell => cell.lastVisited)).toEqual(before.cells.map(cell => cell.lastVisited));
    expect(after.drones.map(drone => drone.position)).toEqual(before.drones.map(drone => drone.position));
    expect(after.drones.map(drone => drone.batteryFraction)).toEqual(before.drones.map(drone => drone.batteryFraction));
    expect(after.drones[0].route).toEqual(before.drones[0].route);
    expect(after.cells.every(cell => cell.assignedDroneId === null)).toBe(true);
    expect(after.drones.every(drone => drone.assignedCellIds.length === 0)).toBe(true);
    expect(after.drones.slice(1).every(drone => drone.route.length === 1 && drone.route[0].x === drone.position.x && drone.route[0].z === drone.position.z)).toBe(true);
    expect(after.estimatedCoverage).toBeNull();
    expect(after.predictedRevisitSeconds).toBeNull();
    system.step(3);
    expect(system.snapshot().drones[0].status).toBe('offline');
    expect(system.snapshot().drones.slice(1).map(drone => drone.position)).toEqual(after.drones.slice(1).map(drone => drone.position));
  });

  it('does not invoke the adaptive planner after takeover or population changes', () => {
    const system = new PatrolSystem({ fleetSize: 2, populationDynamics: { enabled: true, intervalSeconds: 5, redistributionFraction: 1, countVariation: 0.5 } }, { kind: 'adaptive', parameters: DEFAULT_POLICY_PARAMETERS });
    system.enableExternalControl();
    const before = system.snapshot();
    system.step(30);
    const after = system.snapshot();
    expect(after.populationUpdates).toBe(6);
    expect(after.drones.map(drone => drone.position)).toEqual(before.drones.map(drone => drone.position));
    expect(after.revision).toBe(before.revision);
    expect(after.cells.every(cell => cell.assignedDroneId === null)).toBe(true);
  });

  it('redirects each drone immediately at its own bounded speed and fixed altitude', () => {
    const system = externalSystem();
    const before = system.snapshot();
    system.applyExternalCommands([
      { droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 }, speedFraction: 0.5 },
      { droneId: 2, mode: 'patrol', destination: { x: 100, z: 0 }, speedFraction: 1 },
    ]);
    system.step(1);
    const moved = system.snapshot();
    for (const [index, expectedSpeed] of [7, 14].entries()) {
      const start = before.drones[index].position;
      const end = moved.drones[index].position;
      expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeCloseTo(expectedSpeed, 8);
      expect(end.y).toBe(start.y);
      expect(moved.drones[index].speed).toBe(expectedSpeed);
    }
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 100, z: 0 }, speedFraction: 0.75 }]);
    system.step(1);
    expect(system.snapshot().drones[0].speed).toBe(10.5);
    expect(system.snapshot().drones[0].route).toEqual([{ x: 100, y: before.drones[0].position.y, z: 0 }]);
    expect(system.snapshot().drones[1].route).toEqual(moved.drones[1].route);
  });

  it('credits actual swept and stationary sensor footprints, not commanded endpoints', () => {
    const system = externalSystem(1);
    const initial = system.snapshot();
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 } }]);
    expect(system.snapshot().coverage).toBe(0);
    system.step(1);
    const moved = system.snapshot();
    expect(moved.coverage).toBeGreaterThan(0);
    expect(moved.cells.filter(cell => cell.lastVisited !== null).every(cell => Math.hypot(cell.position.x - initial.drones[0].position.x, cell.position.z - initial.drones[0].position.z) <= initial.environment.maxSpeed + initial.environment.sensorRadius)).toBe(true);
    const position = moved.drones[0].position;
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: position.x, z: position.z } }]);
    system.step(3);
    const held = system.snapshot();
    expect(held.drones[0].position).toEqual(position);
    expect(held.cells.some(cell => cell.lastVisited === 4)).toBe(true);
  });

  it.each([
    { droneId: 99, mode: 'patrol', destination: { x: 0, z: 0 } },
    { droneId: 1, mode: 'patrol', destination: { x: 180, z: 180 } },
    { droneId: 1, mode: 'patrol', destination: { x: NaN, z: 0 } },
    { droneId: 1, mode: 'patrol', destination: { x: 0, y: 0, z: 0 } },
    { droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 }, speedFraction: 0.49 },
    { droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 }, speedFraction: 1.01 },
    { droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 }, speedFraction: NaN },
    { droneId: 1, mode: 'patrol' },
    { droneId: 1, mode: 'standby' },
    { droneId: 1, mode: 'return', speedFraction: 0.5 },
    { droneId: 1, mode: 'return', destination: { x: 0, z: 0 } },
    { droneId: 1, mode: 'unknown' },
    { droneId: 1.1, mode: 'return' },
    null,
  ])('rejects a malformed or unsafe batch atomically: %j', invalid => {
    const system = externalSystem();
    const before = system.snapshot();
    expect(() => system.applyExternalCommands([
      { droneId: 2, mode: 'patrol', destination: { x: 0, z: 0 } }, invalid as ExternalPatrolCommand,
    ])).toThrow('no commands applied');
    const after = system.snapshot();
    expect(after.drones).toEqual(before.drones);
    expect(after.cells).toEqual(before.cells);
    expect(after.externalControl).toEqual({ rejectedCommands: 2, forcedReturns: 0 });
  });

  it('rejects duplicate IDs, sparse batches and commands before takeover', () => {
    const system = new PatrolSystem();
    expect(() => system.applyExternalCommands([])).toThrow('not enabled');
    system.enableExternalControl();
    const command: ExternalPatrolCommand = { droneId: 1, mode: 'return' };
    expect(() => system.applyExternalCommands([command, command])).toThrow('no commands applied');
    expect(() => system.applyExternalCommands(Array(2))).toThrow('no commands applied');
    expect(() => system.applyExternalCommands(null as unknown as ExternalPatrolCommand[])).toThrow('no commands applied');
    expect(system.snapshot().externalControl?.rejectedCommands).toBe(5);
  });

  it.each(['malfunction', 'deviation'] as const)('cannot override a pending or confirmed %s and keeps failure detection active', fault => {
    const system = externalSystem();
    system.injectFault(1, fault);
    const command: ExternalPatrolCommand = { droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 } };
    const before = system.snapshot().drones[0];
    expect(() => system.applyExternalCommands([command])).toThrow('no commands applied');
    expect(system.snapshot().drones[0]).toEqual(before);
    system.step(5);
    expect(system.snapshot().drones[0].status).toBe('offline');
    expect(() => system.applyExternalCommands([command])).toThrow('no commands applied');
    expect(system.snapshot().cells.every(cell => cell.assignedDroneId === null)).toBe(true);
    system.restoreDrone(1);
    expect(system.snapshot().drones[0].route).toEqual([system.snapshot().drones[0].position]);
    expect(() => system.applyExternalCommands([command])).not.toThrow();
  });

  it('preserves unrelated learned flight commands when another drone fails or is restored', () => {
    const system = externalSystem();
    const start = system.snapshot().drones[1].position;
    system.applyExternalCommands([{ droneId: 2, mode: 'patrol', destination: { x: 160, z: 0 }, speedFraction: 0.5 }]);
    const route = system.snapshot().drones[1].route;
    system.injectFault(1, 'malfunction');
    system.step(4);
    const failed = system.snapshot();
    expect(failed.drones[0].status).toBe('offline');
    expect(failed.drones[1].route).toEqual(route);
    expect(failed.drones[1].position.x - start.x).toBeCloseTo(28, 8);
    system.restoreDrone(1);
    expect(system.snapshot().drones[0].route).toEqual([system.snapshot().drones[0].position]);
    expect(system.snapshot().drones[1].route).toEqual(route);
    system.step(1);
    expect(system.snapshot().drones[1].position.x - start.x).toBeCloseTo(35, 8);
  });

  it('preserves another learned flight command when a charging drone becomes standby', () => {
    const staged = new PatrolSystem({ fleetSize: 2 }, { kind: 'uniform' }, ENVIRONMENT_PRESETS.compact).snapshot().drones[0].position;
    const system = new PatrolSystem({ fleetSize: 2 }, { kind: 'uniform' }, {
      ...ENVIRONMENT_PRESETS.compact, rechargeSeconds: 30, depot: { x: staged.x, z: staged.z },
    });
    system.enableExternalControl();
    system.step(0.5);
    const start = system.snapshot().drones[1].position;
    system.applyExternalCommands([
      { droneId: 1, mode: 'return' },
      { droneId: 2, mode: 'patrol', destination: { x: 160, z: 0 }, speedFraction: 0.5 },
    ]);
    const route = system.snapshot().drones[1].route;
    system.step(1);
    const snapshot = system.snapshot();
    expect(snapshot.drones[0].serviceState).toBe('standby');
    expect(snapshot.drones[1].route).toEqual(route);
    expect(snapshot.drones[1].position.x - start.x).toBeCloseTo(7, 8);
    expect(snapshot.drones[1].speed).toBe(7);
  });

  it('returns without teleportation or sensing, remains grounded and can redeploy with unlimited endurance', () => {
    const system = externalSystem(1);
    const before = system.snapshot();
    system.applyExternalCommands([{ droneId: 1, mode: 'return' }]);
    expect(system.snapshot().drones[0].position).toEqual(before.drones[0].position);
    system.step(1);
    const moving = system.snapshot();
    expect(Math.hypot(moving.drones[0].position.x - before.drones[0].position.x, moving.drones[0].position.z - before.drones[0].position.z)).toBeCloseTo(before.environment.maxSpeed, 8);
    expect(() => system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 } }])).toThrow('no commands applied');
    const landed = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'standby');
    expect(landed.drones[0].position.x).toBe(0);
    expect(landed.drones[0].position.z).toBe(0);
    expect(landed.drones[0].route).toEqual([]);
    expect(landed.coverage).toBe(0);
    expect(landed.activeCount).toBe(0);
    system.applyExternalCommands([{ droneId: 1, mode: 'standby' }]);
    system.step(120);
    expect(system.snapshot().coverage).toBe(0);
    expect(system.snapshot().energy.energyUsed).toBe(0);
    expect(system.snapshot().population.inViewPeople).toBe(0);
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 50, z: 0 } }]);
    system.step(1);
    expect(system.snapshot().activeCount).toBe(1);
    expect(system.snapshot().drones[0].position.x).toBeCloseTo(14, 8);
    expect(system.snapshot().externalControl?.forcedReturns).toBe(0);
  });

  it('shields an uncommanded hovering drone from exhaustion, charges and waits for learned redeployment', () => {
    const system = externalSystem(1, true);
    const returning = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'returning');
    expect(returning.externalControl?.forcedReturns).toBe(1);
    const observed = returning.cells.map(cell => cell.lastVisited);
    const charging = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'charging');
    expect(charging.cells.map(cell => cell.lastVisited)).toEqual(observed);
    expect(() => system.applyExternalCommands([{ droneId: 1, mode: 'return' }])).toThrow('no commands applied');
    const landed = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'standby');
    expect(landed.drones[0].batteryFraction).toBe(1);
    expect(landed.drones[0].chargeCycles).toBe(1);
    expect(landed.energy.reserveViolations).toBe(0);
    expect(landed.energy.strandedDrones).toBe(0);
    expect(landed.drones[0].route).toEqual([]);
    const energyUsed = landed.energy.energyUsed;
    system.step(180);
    expect(system.snapshot().energy.energyUsed).toBe(energyUsed);
    expect(system.snapshot().drones[0].batteryFraction).toBe(1);
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 120, z: 0 }, speedFraction: 0.5 }]);
    system.step(1);
    expect(system.snapshot().drones[0].position.x).toBe(7);
  });

  it('accounts voluntary return separately from safety interventions and enforces finite charging pads', () => {
    const system = externalSystem(3, true);
    system.step(10);
    system.applyExternalCommands(system.snapshot().drones.map(drone => ({ droneId: drone.id, mode: 'return' })));
    let allStandby = false;
    for (let elapsed = 0; elapsed < 150; elapsed += 0.25) {
      system.step(0.25);
      const snapshot = system.snapshot();
      expect(snapshot.drones.filter(drone => drone.serviceState === 'charging').length).toBeLessThanOrEqual(1);
      expect(snapshot.drones.every(drone => insideEnvironment(drone.position, snapshot.environment))).toBe(true);
      if (snapshot.drones.every(drone => drone.serviceState === 'standby')) {
        allStandby = true;
        break;
      }
    }
    expect(allStandby).toBe(true);
    expect(system.snapshot().externalControl?.forcedReturns).toBe(0);
    expect(system.snapshot().energy.completedCharges).toBe(3);
    expect(system.snapshot().cells.every(cell => cell.assignedDroneId === null)).toBe(true);
  });

  it('overrides a leg that cannot retain return energy and reserve at the requested speed', () => {
    const system = new PatrolSystem({ fleetSize: 1 }, { kind: 'uniform' }, {
      ...ENVIRONMENT_PRESETS.compact, enduranceSeconds: 120, rechargeSeconds: 30, initialChargeFraction: 0.5,
    });
    system.enableExternalControl();
    const start = system.snapshot().drones[0].position;
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: -start.x, z: -start.z }, speedFraction: 0.5 }]);
    system.step(0.25);
    const returning = system.snapshot();
    expect(returning.drones[0].serviceState).toBe('returning');
    expect(returning.drones[0].speed).toBe(returning.environment.maxSpeed);
    expect(returning.externalControl?.forcedReturns).toBe(1);
    expect(returning.coverage).toBe(0);
    const landed = advanceUntil(system, snapshot => snapshot.drones[0].serviceState === 'standby');
    expect(landed.energy.reserveViolations).toBe(0);
    expect(landed.energy.strandedDrones).toBe(0);
  });

  it('does not strand an already-full drone in the charging queue', () => {
    const staged = new PatrolSystem({ fleetSize: 1 }).snapshot().drones[0].position;
    const system = new PatrolSystem({ fleetSize: 1 }, { kind: 'uniform' }, { ...DEFAULT_ENVIRONMENT, batteryEnabled: true, depot: { x: staged.x, z: staged.z } });
    system.enableExternalControl();
    system.applyExternalCommands([{ droneId: 1, mode: 'return' }]);
    system.step(1);
    expect(system.snapshot().drones[0].serviceState).toBe('standby');
    expect(system.snapshot().drones[0].batteryFraction).toBe(1);
    expect(system.snapshot().energy.completedCharges).toBe(0);
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 } }]);
    system.step(1);
    expect(system.snapshot().drones[0].serviceState).toBe('patrol');
  });

  it('resets into external holding mode and explicitly restores baseline allocation through setStrategy', () => {
    const system = externalSystem();
    system.step(10);
    system.applyExternalCommands([{ droneId: 1, mode: 'return' }]);
    system.reset();
    const reset = system.snapshot();
    expect(reset.time).toBe(0);
    expect(reset.externalControl).toEqual({ rejectedCommands: 0, forcedReturns: 0 });
    expect(reset.drones.every(drone => drone.route.length === 1 && drone.assignedCellIds.length === 0)).toBe(true);
    reset.externalControl!.forcedReturns = 100;
    expect(system.snapshot().externalControl?.forcedReturns).toBe(0);
    system.setStrategy({ kind: 'uniform' });
    const baseline = system.snapshot();
    expect(baseline.externalControl).toBeUndefined();
    expect(baseline.cells.every(cell => cell.assignedDroneId !== null)).toBe(true);
    expect(baseline.drones.every(drone => drone.route.length > 1)).toBe(true);
  });

  it('injects population counts and deadlines without resetting observation history or routes', () => {
    const system = externalSystem();
    system.applyExternalCommands([{ droneId: 1, mode: 'patrol', destination: { x: 0, z: 0 } }]);
    system.step(1);
    const before = system.snapshot();
    const counts = before.cells.map((_, index) => index === 0 ? 160 : index === 1 ? 40 : 0);
    system.applyPopulationCounts(counts);
    const after = system.snapshot();
    expect(after.cells.map(cell => cell.population)).toEqual(counts);
    expect(after.cells.map(cell => cell.lastVisited)).toEqual(before.cells.map(cell => cell.lastVisited));
    expect(after.cells[0].targetRevisitSeconds).toBe(15);
    expect(after.cells[1].targetRevisitSeconds).toBe(67.5);
    expect(after.cells[2].targetRevisitSeconds).toBe(120);
    expect(after.population.totalPeople).toBe(200);
    expect(after.drones).toEqual(before.drones);
    expect(after.revision).toBe(before.revision);
    counts[0] = 0;
    expect(system.snapshot().cells[0].population).toBe(160);
  });

  it('validates injected population arrays atomically', () => {
    const system = externalSystem();
    const before = system.snapshot();
    const count = before.cells.length;
    for (const invalid of [[], Array(count), Array(count).fill(-1), Array(count).fill(0.5), Array(count).fill(50000), Array(count).fill(Infinity)]) {
      expect(() => system.applyPopulationCounts(invalid)).toThrow('Invalid external population counts');
      expect(system.snapshot()).toEqual(before);
    }
    system.applyPopulationCounts(Array(count).fill(0));
    expect(system.snapshot().population.totalPeople).toBe(0);
  });

  it('keeps the native population timeline intact when external counts are also injected', () => {
    const system = new PatrolSystem({ populationDynamics: { enabled: true, intervalSeconds: 5, redistributionFraction: 1, countVariation: 0.5 } });
    system.enableExternalControl();
    system.applyPopulationCounts(system.snapshot().cells.map(() => 1));
    system.step(15);
    expect(system.snapshot().populationUpdates).toBe(4);
    expect(system.snapshot().nextPopulationChange).toBe(20);
  });
});
