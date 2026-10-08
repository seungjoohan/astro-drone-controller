import { describe, expect, it } from 'vitest';
import { PatrolCoverageAudit } from './patrol-audit';
import { PatrolSystem } from './patrol';
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_PRESETS } from './patrol-environment';
import type { PatrolDrone } from './patrol-types';

describe('independent patrol coverage audit', () => {
  it('audits the configured footprint and excludes charging aircraft', () => {
    const environment = { ...ENVIRONMENT_PRESETS.corridor, sensorRadius: 64 };
    const audit = new PatrolCoverageAudit(10, environment);
    expect(audit.pointCount).toBe(960);
    const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
    snapshot.drones[0].position = { x: 0, y: 260, z: 0 };
    snapshot.drones[0].serviceState = 'charging';
    audit.observe(snapshot);
    expect(audit.measure(0, 120).coverage).toBe(0);
    snapshot.drones[0].serviceState = 'patrol';
    audit.observe(snapshot);
    expect(audit.measure(0, 120).coverage).toBeGreaterThan(10);
  });
  it('uses a denser independent grid and gives no credit to unseen locations', () => {
    const audit = new PatrolCoverageAudit();
    expect(audit.pointCount).toBe(3228);
    expect(audit.measure(0, 120)).toEqual({ coverage: 0, neverObserved: 3228, maxAge: 120 });
  });

  it('observes actual healthy footprints, unions overlap, and expires old observations', () => {
    const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
    snapshot.drones[0].position = { x: 0, y: 260, z: 0 };
    const audit = new PatrolCoverageAudit();
    audit.observe(snapshot);
    const single = audit.measure(0, 120);
    expect(single.coverage).toBeGreaterThan(0);
    expect(single.coverage).toBeLessThan(2);
    snapshot.drones.push({ ...snapshot.drones[0], id: 2 });
    audit.observe(snapshot);
    expect(audit.measure(0, 120)).toEqual(single);
    expect(audit.measure(120, 120).coverage).toBe(single.coverage);
    expect(audit.measure(120.01, 120).coverage).toBe(0);
  });

  it('does not let disabled sensors or invalid coordinates create observations', () => {
    const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
    const audit = new PatrolCoverageAudit();
    snapshot.drones[0].fault = 'malfunction';
    audit.observe(snapshot);
    expect(audit.measure(0, 120).coverage).toBe(0);
    snapshot.drones[0].fault = null;
    snapshot.drones[0].position.x = NaN;
    audit.observe(snapshot);
    expect(audit.measure(0, 120).coverage).toBe(0);
  });

  it('corroborates baseline five-drone coverage without trusting reported coverage', () => {
    const system = new PatrolSystem();
    const audit = new PatrolCoverageAudit();
    for (let sample = 0; sample < 600; sample += 1) {
      system.step(0.5);
      const snapshot = system.snapshot();
      snapshot.coverage = 0;
      audit.observe(snapshot);
      if (snapshot.time > 150) expect(audit.measure(snapshot.time, 120).coverage).toBe(100);
    }
  });

  it('reports maximal age cost for unseen area without changing the legacy measurement shape', () => {
    const audit = new PatrolCoverageAudit();
    expect(audit.measureReward(0, 120)).toEqual({ coverage: 0, meanAgeCost: 1, overlapFraction: 0 });
    expect(audit.measureReward(10000, 120)).toEqual({ coverage: 0, meanAgeCost: 1, overlapFraction: 0 });
    expect(audit.measure(0, 120)).toEqual({ coverage: 0, neverObserved: 3228, maxAge: 120 });
  });

  it('averages bounded elapsed ages over all boundary points, including empty or unseen areas', () => {
    const audit = new PatrolCoverageAudit();
    const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
    snapshot.drones[0].position = { x: 0, y: 260, z: 0 };
    snapshot.cells.forEach(cell => { cell.population = 0; });
    audit.observe(snapshot);
    const initial = audit.measureReward(0, 120);
    const fraction = initial.coverage / 100;
    expect(initial.meanAgeCost).toBeCloseTo(1 - fraction, 12);
    const elapsed = audit.measureReward(120, 120);
    expect(elapsed.coverage).toBe(initial.coverage);
    expect(elapsed.meanAgeCost).toBeCloseTo(1 - fraction / 2, 12);
    expect(audit.measureReward(120, 240).meanAgeCost).toBeCloseTo(1 - fraction * 2 / 3, 12);
    expect(audit.measureReward(120.01, 120).coverage).toBe(0);
    expect(audit.measureReward(100000, 120).meanAgeCost).toBeLessThan(1);
    const previous = audit.measure(120, 120);
    snapshot.cells.forEach(cell => { cell.population = 1000000; });
    expect(audit.measureReward(120, 120)).toEqual(elapsed);
    expect(audit.measure(120, 120)).toEqual(previous);
    expect(audit.measureReward(0, 0).meanAgeCost).toBeCloseTo(1 - fraction, 12);
    expect(audit.measureReward(NaN, NaN).meanAgeCost).toBeCloseTo(1 - fraction, 12);
  });

  it('penalizes redundant sensing fractions but never changes union coverage or historical visits', () => {
    const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
    snapshot.drones[0].position = { x: 0, y: 260, z: 0 };
    const audit = new PatrolCoverageAudit();
    audit.observe(snapshot);
    const single = audit.measure(0, 120);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0);
    snapshot.drones.push({ ...snapshot.drones[0], id: 2 });
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0.5);
    expect(audit.measure(0, 120)).toEqual(single);
    snapshot.drones.push({ ...snapshot.drones[0], id: 3 });
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(2 / 3);
    expect(audit.measure(0, 120)).toEqual(single);
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(2 / 3);
    snapshot.drones.reverse();
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(2 / 3);
    snapshot.drones = [];
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0);
    expect(audit.measure(0, 120)).toEqual(single);
  });

  it('does not penalize nearby drones whose sensing footprints are disjoint', () => {
    const audit = new PatrolCoverageAudit(5, { ...DEFAULT_ENVIRONMENT, sensorRadius: 16 });
    const snapshot = new PatrolSystem({ fleetSize: 2 }).snapshot();
    snapshot.drones[0].position = { x: -20, y: 260, z: 0 };
    snapshot.drones[1].position = { x: 20, y: 260, z: 0 };
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).coverage).toBeGreaterThan(0);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0);
    snapshot.drones[1].position.x = -20;
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0.5);
    snapshot.drones[1].position.x = 20;
    audit.observe(snapshot);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0);
  });

  it('resets instantaneous counts only for valid observations, including non-sensing snapshots', () => {
    const audit = new PatrolCoverageAudit();
    const snapshot = new PatrolSystem({ fleetSize: 2 }).snapshot();
    snapshot.drones.forEach(drone => { drone.position = { x: 0, y: 260, z: 0 }; });
    audit.observe(snapshot);
    const before = audit.measure(0, 120);
    expect(audit.measureReward(0, 120).overlapFraction).toBe(0.5);
    for (const time of [NaN, Infinity, -1]) {
      audit.observe({ time, drones: [] });
      expect(audit.measureReward(0, 120).overlapFraction).toBe(0.5);
      expect(audit.measure(0, 120)).toEqual(before);
    }
    snapshot.time = 1;
    snapshot.drones.forEach(drone => { drone.serviceState = 'charging'; });
    audit.observe(snapshot);
    expect(audit.measureReward(1, 120).overlapFraction).toBe(0);
    expect(audit.measure(0, 120)).toEqual(before);
  });

  it('counts only valid sensing aircraft, not depot service, faults or invalid coordinates', () => {
    const inactive: Partial<PatrolDrone>[] = [
      { serviceState: 'returning' }, { serviceState: 'waiting' }, { serviceState: 'charging' }, { serviceState: 'standby' },
      { status: 'offline' }, { status: 'unresponsive' }, { status: 'deviating' }, { fault: 'malfunction' },
      { position: { x: NaN, y: 260, z: 0 } },
    ];
    for (const properties of inactive) {
      const audit = new PatrolCoverageAudit();
      const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
      snapshot.drones[0].position = { x: 0, y: 260, z: 0 };
      snapshot.drones.push({ ...snapshot.drones[0], id: 2, ...properties });
      audit.observe(snapshot);
      expect(audit.measureReward(0, 120).overlapFraction).toBe(0);
      expect(audit.measureReward(0, 120).coverage).toBeGreaterThan(0);
      snapshot.drones.shift();
      const emptyAudit = new PatrolCoverageAudit();
      emptyAudit.observe(snapshot);
      expect(emptyAudit.measureReward(0, 120)).toEqual({ coverage: 0, meanAgeCost: 1, overlapFraction: 0 });
    }
  });

  it('computes overlap only over inside-circle audit points, not the enclosing rectangle', () => {
    const environment = { ...DEFAULT_ENVIRONMENT, width: 120, depth: 120, sensorRadius: 32 };
    const snapshot = new PatrolSystem({ fleetSize: 2 }).snapshot();
    snapshot.drones[0].position = { x: 40, y: 260, z: 0 };
    snapshot.drones[1].position = { x: 0, y: 260, z: 40 };
    let insidePoints = 0;
    let sensedPoints = 0;
    let uniqueSensedPoints = 0;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const horizontal = -55 + column * 10;
        const vertical = -55 + row * 10;
        if (horizontal ** 2 + vertical ** 2 > 60 ** 2) continue;
        insidePoints += 1;
        const count = snapshot.drones.filter(drone => (horizontal - drone.position.x) ** 2 + (vertical - drone.position.z) ** 2 <= 32 ** 2).length;
        sensedPoints += count;
        uniqueSensedPoints += Number(count > 0);
      }
    }
    const audit = new PatrolCoverageAudit(10, environment);
    audit.observe(snapshot);
    expect(audit.pointCount).toBe(insidePoints);
    expect(audit.measureReward(0, 120)).toEqual({ coverage: 100 * uniqueSensedPoints / insidePoints,
      meanAgeCost: (insidePoints - uniqueSensedPoints) / insidePoints,
      overlapFraction: (sensedPoints - uniqueSensedPoints) / sensedPoints });
    const rectangle = new PatrolCoverageAudit(10, { ...environment, shape: 'rectangle' });
    rectangle.observe(snapshot);
    expect(rectangle.measureReward(0, 120).overlapFraction).not.toBe(audit.measureReward(0, 120).overlapFraction);
  });

  it('normalizes geometry and elapsed ages across uniformly scaled maps with equal grid shapes', () => {
    const small = new PatrolCoverageAudit(5, { ...DEFAULT_ENVIRONMENT, width: 240, depth: 240, sensorRadius: 16 });
    const large = new PatrolCoverageAudit(10, { ...DEFAULT_ENVIRONMENT, width: 480, depth: 480, sensorRadius: 32 });
    const snapshot = new PatrolSystem({ fleetSize: 2 }).snapshot();
    snapshot.drones[0].position = { x: -30, y: 260, z: 10 };
    snapshot.drones[1].position = { x: -20, y: 260, z: 10 };
    const enlarged = structuredClone(snapshot);
    enlarged.drones.forEach(drone => { drone.position.x *= 2; drone.position.z *= 2; });
    small.observe(snapshot);
    large.observe(enlarged);
    expect(small.pointCount).toBe(large.pointCount);
    expect(small.measureReward(0, 120)).toEqual(large.measureReward(0, 240));
    snapshot.time = 30;
    enlarged.time = 60;
    snapshot.drones[0].position.x = 60;
    enlarged.drones[0].position.x = 120;
    small.observe(snapshot);
    large.observe(enlarged);
    expect(small.measureReward(90, 120)).toEqual(large.measureReward(180, 240));
  });

  it('normalizes non-square boundaries by inside area, not raw grid size or population', () => {
    const snapshot = new PatrolSystem({ fleetSize: 1 }).snapshot();
    snapshot.drones[0].position = { x: -40, y: 260, z: 20 };
    const horizontal = new PatrolCoverageAudit(10, { ...DEFAULT_ENVIRONMENT, shape: 'rectangle', width: 240, depth: 120 });
    const vertical = new PatrolCoverageAudit(10, { ...DEFAULT_ENVIRONMENT, shape: 'rectangle', width: 120, depth: 240 });
    horizontal.observe(snapshot);
    const transposed = structuredClone(snapshot);
    transposed.drones[0].position = { x: 20, y: 260, z: -40 };
    vertical.observe(transposed);
    expect(horizontal.pointCount).toBe(vertical.pointCount);
    expect(horizontal.measureReward(120, 120)).toEqual(vertical.measureReward(120, 120));
    const larger = new PatrolCoverageAudit(10, { ...DEFAULT_ENVIRONMENT, shape: 'rectangle', width: 480, depth: 120 });
    larger.observe(snapshot);
    expect(larger.pointCount).toBe(horizontal.pointCount * 2);
    for (const audit of [horizontal, vertical, larger]) {
      const measured = audit.measureReward(120, 120);
      expect(measured.meanAgeCost).toBeCloseTo(1 - measured.coverage / 200, 12);
    }
  });
});
