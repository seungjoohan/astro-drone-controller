import { describe, expect, it } from 'vitest';
import { PatrolCoverageAudit } from './patrol-audit';
import { PatrolSystem } from './patrol';
import { ENVIRONMENT_PRESETS } from './patrol-environment';

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
});
