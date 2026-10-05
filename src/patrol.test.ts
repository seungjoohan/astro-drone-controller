import { describe, expect, it } from 'vitest';
import { FLIGHT_MAPS } from './maps';
import { PATROL_DEFAULTS, PATROL_LIMITS, PatrolSystem, recommendFleet } from './patrol';
import type { PatrolSnapshot } from './patrol-types';
import type { Vec3 } from './types';

function expectCompleteAssignment(snapshot: PatrolSnapshot): void {
  const active = snapshot.drones.filter(drone => drone.status === 'patrolling');
  const assigned = active.flatMap(drone => drone.assignedCellIds);
  expect(assigned).toHaveLength(snapshot.cells.length);
  expect(new Set(assigned).size).toBe(snapshot.cells.length);
  for (const cell of snapshot.cells) {
    const owner = active.find(drone => drone.id === cell.assignedDroneId);
    expect(owner?.assignedCellIds).toContain(cell.id);
  }
  const sizes = active.map(drone => drone.assignedCellIds.length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
}

function expectEquivalent(first: PatrolSnapshot, second: PatrolSnapshot): void {
  expect(first.time).toBeCloseTo(second.time, 6);
  expect(first.revision).toBe(second.revision);
  expect(first.coverage).toBe(second.coverage);
  expect(first.everCovered).toBe(second.everCovered);
  first.drones.forEach((drone, index) => {
    expect(drone.status).toBe(second.drones[index].status);
    expect(drone.routeIndex).toBe(second.drones[index].routeIndex);
    expect(drone.position.x).toBeCloseTo(second.drones[index].position.x, 6);
    expect(drone.position.z).toBeCloseTo(second.drones[index].position.z, 6);
  });
  first.cells.forEach((cell, index) => {
    if (cell.lastVisited === null) expect(second.cells[index].lastVisited).toBeNull();
    else expect(cell.lastVisited).toBeCloseTo(second.cells[index].lastVisited!, 6);
  });
}

describe('PatrolSystem', () => {
  it('starts with a balanced complete lawnmower partition and unseen cells', () => {
    const snapshot = new PatrolSystem().snapshot();
    expect(snapshot.config).toEqual(PATROL_DEFAULTS);
    expect(snapshot.time).toBe(0);
    expect(snapshot.coverage).toBe(0);
    expect(snapshot.everCovered).toBe(0);
    expect(snapshot.maxAge).toBeNull();
    expect(snapshot.cells).toHaveLength(208);
    expect(snapshot.uncoveredCells).toBe(208);
    expect(snapshot.cells.every(cell => cell.lastVisited === null)).toBe(true);
    expectCompleteAssignment(snapshot);
    for (const drone of snapshot.drones) {
      expect(drone.assignedCellIds).toEqual(Array.from({ length: drone.assignedCellIds.length }, (_, index) => drone.assignedCellIds[0] + index));
      expect(drone.position).toEqual(drone.route[0]);
    }
  });

  it('selects the smallest fleet satisfying the conservative route estimate', () => {
    const recommendation = recommendFleet({ coverageTarget: 95, revisitSeconds: 120 });
    expect(recommendation.count).toBe(5);
    expect(recommendation.achievable).toBe(true);
    expect(recommendation.estimatedCoverage).toBeGreaterThanOrEqual(95);
    expect(recommendation.revisitSeconds).toBeCloseTo(114.69389464346376, 6);
    for (let count = 1; count < recommendation.count; count += 1) {
      expect(new PatrolSystem({ fleetSize: count }).snapshot().estimatedCoverage).toBeLessThan(95);
    }
    expect(PATROL_DEFAULTS.fleetSize).toBe(recommendation.count);
  });

  it('reports an infeasible target instead of promising unbounded fleet capacity', () => {
    const recommendation = recommendFleet({ coverageTarget: 100, revisitSeconds: 5 });
    expect(recommendation.count).toBe(PATROL_LIMITS.maxDrones);
    expect(recommendation.achievable).toBe(false);
    expect(recommendation.estimatedCoverage).toBeLessThan(100);
    expect(recommendFleet({ coverageTarget: 95, revisitSeconds: 600 }).count).toBe(1);
  });

  it('converges to the default target and sustains it throughout further loops', () => {
    const system = new PatrolSystem();
    system.step(150);
    for (let sample = 0; sample < 120; sample += 1) {
      const snapshot = system.snapshot();
      expect(snapshot.coverage).toBeGreaterThanOrEqual(PATROL_DEFAULTS.coverageTarget);
      expect(snapshot.everCovered).toBe(100);
      expect(snapshot.maxAge).toBeLessThanOrEqual(PATROL_DEFAULTS.revisitSeconds);
      system.step(2);
    }
  });

  it('keeps conservative estimates below actual steady-state rolling coverage', () => {
    for (const fleetSize of [1, 2, 3, 4, 6, 8]) {
      const system = new PatrolSystem({ fleetSize });
      system.step(system.snapshot().predictedRevisitSeconds! + 1);
      for (let sample = 0; sample < 30; sample += 1) {
        const snapshot = system.snapshot();
        expect(snapshot.coverage + 1e-8).toBeGreaterThanOrEqual(snapshot.estimatedCoverage!);
        system.step(11);
      }
    }
  });

  it('confirms a missing heartbeat after three seconds and reassigns every cell', () => {
    const system = new PatrolSystem();
    system.step(60);
    const before = system.snapshot();
    system.injectFault(2, 'malfunction');
    const stoppedPosition = system.snapshot().drones[1].position;
    system.step(2.9);
    expect(system.snapshot().drones[1].status).toBe('unresponsive');
    expect(system.snapshot().revision).toBe(before.revision);
    system.step(0.1);
    const after = system.snapshot();
    expect(after.drones[1].status).toBe('offline');
    expect(after.drones[1].position).toEqual(stoppedPosition);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.activeCount).toBe(PATROL_DEFAULTS.fleetSize - 1);
    expect(after.drones).toHaveLength(before.drones.length);
    expect(after.everCovered).toBeGreaterThanOrEqual(before.everCovered);
    expect(after.estimatedCoverage).toBeLessThan(95);
    expectCompleteAssignment(after);
    for (const cell of before.cells.filter(cell => cell.lastVisited !== null)) expect(after.cells[cell.id].lastVisited!).toBeGreaterThanOrEqual(cell.lastVisited!);
  });

  it('detects sustained actual cross-track deviation after crossing the tolerance', () => {
    const system = new PatrolSystem();
    const before = system.snapshot();
    system.injectFault(1, 'deviation');
    system.step(0.5);
    const drifting = system.snapshot();
    expect(drifting.drones[0].status).toBe('deviating');
    expect(drifting.drones[0].position).not.toEqual(before.drones[0].position);
    system.step(2.5);
    expect(system.snapshot().drones[0].status).toBe('deviating');
    system.step(0.8);
    const after = system.snapshot();
    expect(after.drones[0].status).toBe('offline');
    expect(after.drones[0].fault).toBe('deviation');
    expect(after.revision).toBe(before.revision + 1);
    expectCompleteAssignment(after);
  });

  it('uses heartbeat deadlines independently of the health sampling clock', () => {
    const system = new PatrolSystem();
    system.step(0.025);
    system.injectFault(1, 'malfunction');
    system.step(2.999);
    expect(system.snapshot().drones[0].status).toBe('unresponsive');
    system.step(0.001);
    expect(system.snapshot().drones[0].status).toBe('offline');
    expect(system.snapshot().time).toBeCloseTo(3.025, 8);
  });

  it('does not credit a drifting sensor while the deviation is being investigated', () => {
    const system = new PatrolSystem({ fleetSize: 1 });
    system.injectFault(1, 'deviation');
    system.step(3);
    expect(system.snapshot().drones[0].status).toBe('deviating');
    expect(system.snapshot().coverage).toBe(0);
    expect(system.snapshot().everCovered).toBe(0);
  });

  it('observes stationary sensor footprints without crediting cells outside the radius', () => {
    const system = new PatrolSystem({ fleetSize: 1 });
    const position = system.snapshot().cells[0].position;
    const sensor = system as unknown as { observe(start: Vec3, end: Vec3, time: number, seconds: number): void };
    sensor.observe(position, position, 0, 2);
    const visited = system.snapshot().cells.filter(cell => cell.lastVisited !== null);
    expect(visited).toHaveLength(1);
    expect(visited[0].lastVisited).toBe(2);
    expect(visited[0].id).toBe(0);
  });

  it('does not confirm transient signal loss or a restored short route deviation', () => {
    for (const fault of ['malfunction', 'deviation'] as const) {
      const system = new PatrolSystem();
      system.injectFault(1, fault);
      system.step(2);
      const position = system.snapshot().drones[0].position;
      system.restoreDrone(1);
      expect(system.snapshot().drones[0].position).toEqual(position);
      system.step(20);
      const snapshot = system.snapshot();
      expect(snapshot.drones.every(drone => drone.status === 'patrolling')).toBe(true);
      expect(snapshot.events.some(event => event.message.includes('confirmed'))).toBe(false);
      expectCompleteAssignment(snapshot);
    }
  });

  it('preserves a pending drifting leg while a different fault triggers reassignment', () => {
    const system = new PatrolSystem();
    system.injectFault(1, 'malfunction');
    system.step(1);
    system.injectFault(2, 'deviation');
    const route = system.snapshot().drones[1].route;
    system.step(2);
    let snapshot = system.snapshot();
    expect(snapshot.drones[0].status).toBe('offline');
    expect(snapshot.drones[1].status).toBe('deviating');
    expect(snapshot.drones[1].route).toEqual(route);
    expectCompleteAssignment(snapshot);
    system.step(2);
    snapshot = system.snapshot();
    expect(snapshot.drones[1].status).toBe('offline');
    expect(snapshot.revision).toBe(3);
    expectCompleteAssignment(snapshot);
  });

  it('never credits faulty sensors and lets coverage expire when all drones go offline', () => {
    const system = new PatrolSystem();
    system.step(150);
    const before = system.snapshot();
    for (const drone of before.drones) system.injectFault(drone.id, 'malfunction');
    system.step(3);
    const offline = system.snapshot();
    expect(offline.activeCount).toBe(0);
    expect(offline.cells.every(cell => cell.assignedDroneId === null)).toBe(true);
    expect(offline.cells.map(cell => cell.lastVisited)).toEqual(before.cells.map(cell => cell.lastVisited));
    expect(offline.predictedRevisitSeconds).toBe(Infinity);
    expect(offline.estimatedCoverage).toBe(0);
    system.step(PATROL_DEFAULTS.revisitSeconds + 1);
    const expired = system.snapshot();
    expect(expired.coverage).toBe(0);
    expect(expired.uncoveredCells).toBe(expired.cells.length);
    expect(expired.everCovered).toBe(100);
    expect(expired.drones.map(drone => drone.position)).toEqual(offline.drones.map(drone => drone.position));
    expect(expired.maxAge).toBeGreaterThan(PATROL_DEFAULTS.revisitSeconds);
  });

  it('preserves survivor positions at replan and restores from the actual stopped position', () => {
    const normal = new PatrolSystem();
    const failing = new PatrolSystem();
    normal.step(27);
    failing.step(27);
    failing.injectFault(2, 'malfunction');
    normal.step(3);
    failing.step(3);
    const expected = normal.snapshot();
    const failed = failing.snapshot();
    for (const drone of failed.drones.filter(drone => drone.id !== 2)) {
      expect(drone.position.x).toBeCloseTo(expected.drones[drone.id - 1].position.x, 6);
      expect(drone.position.z).toBeCloseTo(expected.drones[drone.id - 1].position.z, 6);
    }
    failing.step(70);
    const beforeRestore = failing.snapshot();
    failing.restoreDrone(2);
    const restored = failing.snapshot();
    expect(restored.time).toBe(beforeRestore.time);
    expect(restored.drones.map(drone => drone.position)).toEqual(beforeRestore.drones.map(drone => drone.position));
    expect(restored.cells.map(cell => cell.lastVisited)).toEqual(beforeRestore.cells.map(cell => cell.lastVisited));
    expectCompleteAssignment(restored);
    failing.step(180);
    expect(failing.snapshot().drones.every(drone => drone.status === 'patrolling')).toBe(true);
    expect(failing.snapshot().coverage).toBeGreaterThanOrEqual(95);
  });

  it('keeps every route, movement, and altitude lane within the city flight bounds', () => {
    const system = new PatrolSystem({ fleetSize: 8 });
    const highestBuilding = Math.max(...FLIGHT_MAPS.nyc.buildings.flatMap(building => building.tiers.map(tier => tier.base + tier.height)));
    for (let sample = 0; sample < 70; sample += 1) {
      const snapshot = system.snapshot();
      for (const drone of snapshot.drones) {
        expect(drone.position.y).toBe(260 + (drone.id - 1) * 4);
        expect(drone.position.y).toBeGreaterThan(highestBuilding);
        expect(drone.position.y).toBeLessThan(FLIGHT_MAPS.nyc.maxAltitude);
        for (const position of [drone.position, ...drone.route]) expect(Math.hypot(position.x, position.z)).toBeLessThanOrEqual(FLIGHT_MAPS.nyc.radius + 1e-8);
      }
      expect(new Set(snapshot.drones.map(drone => drone.position.y)).size).toBe(8);
      expect(snapshot.coverage).toBeGreaterThanOrEqual(0);
      expect(snapshot.coverage).toBeLessThanOrEqual(100);
      if (sample === 10) system.injectFault(1, 'deviation');
      if (sample === 25) system.restoreDrone(1);
      system.step(5);
    }
  });

  it('sweeps sensor footprints so large and small time steps produce the same coverage', () => {
    const large = new PatrolSystem();
    const small = new PatrolSystem();
    large.step(240);
    for (let frame = 0; frame < 2400; frame += 1) small.step(0.1);
    expectEquivalent(large.snapshot(), small.snapshot());
    expect(large.snapshot().cells.every(cell => cell.lastVisited !== null)).toBe(true);
  });

  it('detects faults at the same logical sampling times across frame rates', () => {
    for (const fault of ['malfunction', 'deviation'] as const) {
      const large = new PatrolSystem();
      const small = new PatrolSystem();
      large.injectFault(1, fault);
      small.injectFault(1, fault);
      large.step(12);
      for (let frame = 0; frame < 1200; frame += 1) small.step(0.01);
      expectEquivalent(large.snapshot(), small.snapshot());
    }
  });

  it('returns detached snapshots and bounds its event history', () => {
    const system = new PatrolSystem();
    const snapshot = system.snapshot();
    snapshot.drones[0].position.x = 10000;
    snapshot.drones[0].route[0].x = 10000;
    snapshot.drones[0].assignedCellIds.length = 0;
    snapshot.cells[0].position.x = 10000;
    snapshot.cells[0].lastVisited = 10000;
    snapshot.config.fleetSize = 10000;
    expect(system.snapshot().drones[0].position.x).not.toBe(10000);
    expect(system.snapshot().cells[0].lastVisited).toBeNull();
    expectCompleteAssignment(system.snapshot());
    for (let repetition = 0; repetition < 15; repetition += 1) {
      system.injectFault(1, 'malfunction');
      system.restoreDrone(1);
    }
    const events = system.snapshot().events;
    expect(events).toHaveLength(12);
    expect(new Set(events.map(event => event.id)).size).toBe(12);
    expect(events[0].id).toBeGreaterThan(1);
  });

  it('validates configuration, ignores invalid input, and resets all patrol state', () => {
    const system = new PatrolSystem({ coverageTarget: NaN, revisitSeconds: Infinity, fleetSize: -1 });
    expect(system.snapshot().config).toEqual({ ...PATROL_DEFAULTS, fleetSize: 1 });
    const before = system.snapshot();
    for (const delta of [NaN, Infinity, -1, 0]) system.step(delta);
    system.injectFault(999, 'malfunction');
    system.restoreDrone(999);
    expect(system.snapshot()).toEqual(before);
    system.step(1e9);
    expect(system.snapshot().time).toBe(3600);
    system.reset({ coverageTarget: 200, revisitSeconds: -3, fleetSize: 200 });
    const after = system.snapshot();
    expect(after.config).toEqual({ ...PATROL_DEFAULTS, coverageTarget: 100, revisitSeconds: 1, fleetSize: 8, crowdedRevisitSeconds: 1 });
    expect(after.time).toBe(0);
    expect(after.coverage).toBe(0);
    expect(after.everCovered).toBe(0);
    expect(after.maxAge).toBeNull();
    expect(after.events).toHaveLength(1);
    expect(after.revision).toBe(1);
    expectCompleteAssignment(after);
  });
});

describe('Patrol population integration', () => {
  it('recreates the same stationary population on reset and varies it with the seed', () => {
    const system = new PatrolSystem({ populationCount: 4321, populationSeed: 17 });
    const populations = system.snapshot().cells.map(cell => cell.population);
    expect(populations.reduce((total, population) => total + population, 0)).toBe(4321);
    system.step(150);
    system.reset();
    expect(system.snapshot().cells.map(cell => cell.population)).toEqual(populations);
    expect(system.snapshot().population.unseenPeople).toBe(4321);
    system.reset({ populationSeed: 18 });
    expect(system.snapshot().cells.map(cell => cell.population)).not.toEqual(populations);
  });

  it('keeps baseline routes and the geographic fleet estimate independent of population scoring', () => {
    const empty = new PatrolSystem({ populationCount: 0 });
    const crowded = new PatrolSystem({ populationCount: 50000 });
    empty.step(180);
    crowded.step(180);
    expect(empty.snapshot().drones).toEqual(crowded.snapshot().drones);
    expect(empty.snapshot().coverage).toBe(crowded.snapshot().coverage);
    expect(empty.snapshot().recommendedFleet).toEqual(crowded.snapshot().recommendedFleet);
    expect(crowded.snapshot().population.onTimeCoverage).toBeLessThan(100);
    expect(crowded.snapshot().coverage).toBe(100);
    expect(empty.snapshot().population.onTimeCoverage).toBeNull();
  });

  it('preserves population and deadlines during fault recovery and expires population coverage', () => {
    const system = new PatrolSystem();
    system.step(150);
    const before = system.snapshot();
    for (const drone of before.drones) system.injectFault(drone.id, 'malfunction');
    system.step(150);
    const offline = system.snapshot();
    expect(offline.population.inViewPeople).toBe(0);
    expect(offline.population.onTimePeople).toBe(0);
    expect(offline.population.normalizedGapCost).toBeGreaterThan(before.population.normalizedGapCost!);
    system.restoreDrone(1);
    expect(system.snapshot().cells.map(cell => [cell.population, cell.targetRevisitSeconds])).toEqual(before.cells.map(cell => [cell.population, cell.targetRevisitSeconds]));
    expect(system.snapshot().population.totalPeople).toBe(before.population.totalPeople);
  });

  it('bounds population inputs and never makes crowded deadlines longer than the area window', () => {
    const system = new PatrolSystem({ populationCount: NaN, populationSeed: Infinity, crowdedRevisitSeconds: NaN, crowdedCellPopulation: Infinity });
    expect(system.snapshot().config).toEqual(PATROL_DEFAULTS);
    system.reset({ populationCount: 1e9, populationSeed: -4, crowdedRevisitSeconds: 300, crowdedCellPopulation: 0, revisitSeconds: 60 });
    const snapshot = system.snapshot();
    expect(snapshot.config).toMatchObject({ populationCount: 50000, populationSeed: 1, crowdedRevisitSeconds: 60, crowdedCellPopulation: 1 });
    expect(snapshot.population.totalPeople).toBe(50000);
    expect(snapshot.cells.every(cell => cell.targetRevisitSeconds <= 60)).toBe(true);
    system.reset({ populationCount: -1 });
    expect(system.snapshot().population.totalPeople).toBe(0);
  });

  it('returns population fields as detached values and is frame-rate independent', () => {
    const large = new PatrolSystem();
    const small = new PatrolSystem();
    const detached = large.snapshot();
    detached.cells[0].population = 1e9;
    detached.cells[0].targetRevisitSeconds = 1e9;
    detached.population.totalPeople = 1e9;
    detached.config.populationCount = 1e9;
    large.step(180);
    for (let frame = 0; frame < 1800; frame += 1) small.step(0.1);
    const first = large.snapshot().population;
    const second = small.snapshot().population;
    expect(first.totalPeople).toBe(PATROL_DEFAULTS.populationCount);
    expect(first.onTimeCoverage).toBe(second.onTimeCoverage);
    expect(first.inViewCoverage).toBe(second.inViewCoverage);
    expect(first.meanAgeSeconds).toBeCloseTo(second.meanAgeSeconds!, 6);
    expect(first.normalizedGapCost).toBeCloseTo(second.normalizedGapCost!, 6);
  });
});
