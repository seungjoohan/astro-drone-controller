import { describe, expect, it, vi } from 'vitest';
import { PATROL_DEFAULTS, PatrolSystem } from './patrol';
import { ENVIRONMENT_PRESETS } from './patrol-environment';
import { DEFAULT_POLICY_PARAMETERS, PopulationPolicy } from './patrol-policy';
import { DEFAULT_POPULATION_DYNAMICS, populateCells, updatePopulation, validatePopulationDynamics } from './population';
import type { PatrolConfig, PatrolSnapshot } from './patrol-types';
import type { PatrolStrategy } from './patrol-learning-types';

const DYNAMICS = { ...DEFAULT_POPULATION_DYNAMICS, enabled: true };
const CONFIG: PatrolConfig = { ...PATROL_DEFAULTS, populationDynamics: DYNAMICS };
const ADAPTIVE: PatrolStrategy = { kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS } };

function populationTrace(snapshot: PatrolSnapshot): number[] {
  return snapshot.cells.map(cell => cell.population);
}

describe('random population dynamics', () => {
  it('strictly validates bounded settings and returns detached values', () => {
    const validated = validatePopulationDynamics(DYNAMICS);
    expect(validated).toEqual(DYNAMICS);
    expect(validated).not.toBe(DYNAMICS);
    for (const invalid of [null, [], {}, { ...DYNAMICS, enabled: 1 }, { ...DYNAMICS, intervalSeconds: 4 },
      { ...DYNAMICS, intervalSeconds: 601 }, { ...DYNAMICS, intervalSeconds: 5.5 },
      { ...DYNAMICS, redistributionFraction: 0 }, { ...DYNAMICS, redistributionFraction: Infinity },
      { ...DYNAMICS, countVariation: -0.1 }, { ...DYNAMICS, countVariation: NaN },
      { ...DYNAMICS, countVariation: 1.1 }, { ...DYNAMICS, unexpected: true }]) {
      expect(validatePopulationDynamics(invalid)).toBeNull();
    }
    expect(() => new PatrolSystem({ populationDynamics: { ...DYNAMICS, intervalSeconds: 0 } })).toThrow('Invalid population dynamics');
  });

  it('changes total and density reproducibly without changing identity or observation history', () => {
    const first = new PatrolSystem(CONFIG).snapshot().cells;
    first.forEach((cell, index) => { cell.lastVisited = index % 2 ? 13 : null; });
    const original = structuredClone(first);
    const second = structuredClone(first);
    const totals = new Set<number>();
    for (let epoch = 1; epoch <= 40; epoch += 1) {
      updatePopulation(first, CONFIG, epoch);
      updatePopulation(second, CONFIG, epoch);
      expect(first).toEqual(second);
      const total = first.reduce((sum, cell) => sum + cell.population, 0);
      totals.add(total);
      expect(total).toBeGreaterThanOrEqual(3750);
      expect(total).toBeLessThanOrEqual(6250);
      first.forEach((cell, index) => {
        expect(Number.isInteger(cell.population) && cell.population >= 0).toBe(true);
        expect(cell.targetRevisitSeconds).toBeCloseTo(120 - 105 * Math.min(1, cell.population / 80));
        expect(cell).toMatchObject({ id: original[index].id, position: original[index].position,
          assignedDroneId: original[index].assignedDroneId, lastVisited: original[index].lastVisited });
      });
    }
    expect(totals.size).toBeGreaterThan(30);
    expect(first.map(cell => cell.population)).not.toEqual(original.map(cell => cell.population));
    expect(() => updatePopulation(first, CONFIG, 0)).toThrow();
  });

  it('can redistribute a fixed total and controls how strongly the layout changes', () => {
    const original = new PatrolSystem(CONFIG).snapshot().cells;
    const gentle = structuredClone(original);
    const full = structuredClone(original);
    updatePopulation(gentle, { ...CONFIG, populationDynamics: { ...DYNAMICS, countVariation: 0, redistributionFraction: 0.05 } }, 1);
    updatePopulation(full, { ...CONFIG, populationDynamics: { ...DYNAMICS, countVariation: 0, redistributionFraction: 1 } }, 1);
    const distance = (cells: typeof original) => cells.reduce((total, cell, index) => total + Math.abs(cell.population - original[index].population), 0);
    expect(gentle.reduce((total, cell) => total + cell.population, 0)).toBe(5000);
    expect(full.reduce((total, cell) => total + cell.population, 0)).toBe(5000);
    expect(distance(gentle)).toBeGreaterThan(0);
    expect(distance(gentle)).toBeLessThan(distance(full));
  });

  it('bounds empty, sparse, and maximum cities without negative counts or invalid deadlines', () => {
    for (const populationCount of [0, 1, 50000]) {
      const config = { ...CONFIG, populationCount, populationDynamics: { ...DYNAMICS, countVariation: 1 } };
      const cells = new PatrolSystem(config).snapshot().cells;
      for (let epoch = 1; epoch <= 30; epoch += 1) {
        updatePopulation(cells, config, epoch);
        const total = cells.reduce((sum, cell) => sum + cell.population, 0);
        expect(total).toBeGreaterThanOrEqual(populationCount ? 1 : 0);
        expect(total).toBeLessThanOrEqual(50000);
        if (!populationCount) expect(total).toBe(0);
        expect(cells.every(cell => Number.isInteger(cell.population) && cell.population >= 0 && Number.isFinite(cell.targetRevisitSeconds))).toBe(true);
      }
    }
  });

  it('does not freeze sparse populations by repeatedly discarding fractional redistribution', () => {
    for (const populationCount of [1, 5, 10]) {
      const config = { ...CONFIG, populationCount, populationDynamics: { ...DYNAMICS, countVariation: 0 } };
      const cells = new PatrolSystem(config).snapshot().cells;
      const layouts = new Set([JSON.stringify(cells.map(cell => cell.population))]);
      for (let epoch = 1; epoch <= 100; epoch += 1) {
        updatePopulation(cells, config, epoch);
        layouts.add(JSON.stringify(cells.map(cell => cell.population)));
        expect(cells.reduce((total, cell) => total + cell.population, 0)).toBe(populationCount);
      }
      expect(layouts.size).toBeGreaterThan(10);
    }
  });

  it('keeps disabled population and classic flight identical to the static baseline', () => {
    const classic = new PatrolSystem();
    const disabled = new PatrolSystem({ populationDynamics: { ...DYNAMICS, enabled: false } });
    classic.step(400);
    disabled.step(400);
    expect(disabled.snapshot().cells).toEqual(classic.snapshot().cells);
    expect(disabled.snapshot().drones).toEqual(classic.snapshot().drones);
    expect(disabled.snapshot().population).toEqual(classic.snapshot().population);
    expect(disabled.snapshot()).toMatchObject({ populationUpdates: 0, nextPopulationChange: null });
    const cells = disabled.snapshot().cells;
    updatePopulation(cells, disabled.snapshot().config, 1);
    expect(cells).toEqual(disabled.snapshot().cells);
  });

  it('updates on simulation boundaries, freezes without stepping, and replays on reset', () => {
    const system = new PatrolSystem(CONFIG);
    const original = system.snapshot();
    system.step(29.5);
    expect(populationTrace(system.snapshot())).toEqual(populationTrace(original));
    system.step(0.5);
    const changed = system.snapshot();
    expect(changed).toMatchObject({ populationUpdates: 1, nextPopulationChange: 60 });
    expect(populationTrace(changed)).not.toEqual(populationTrace(original));
    expect(changed.config.populationCount).toBe(5000);
    for (const invalidStep of [0, -1, NaN, Infinity]) system.step(invalidStep);
    expect(system.snapshot()).toEqual(changed);
    system.reset();
    expect(system.snapshot()).toEqual(original);
    system.step(30);
    expect(populationTrace(system.snapshot())).toEqual(populationTrace(changed));
    const detached = system.snapshot();
    detached.config.populationDynamics!.enabled = false;
    expect(system.snapshot().config.populationDynamics!.enabled).toBe(true);
  });

  it('uses the same population timeline across fleet sizes, routes, and failures', () => {
    const uniform = new PatrolSystem({ ...CONFIG, fleetSize: 1 });
    const adaptive = new PatrolSystem({ ...CONFIG, fleetSize: 8 }, ADAPTIVE);
    adaptive.injectFault(2, 'malfunction');
    for (let epoch = 1; epoch <= 4; epoch += 1) {
      uniform.step(30);
      adaptive.step(30);
      expect(populationTrace(adaptive.snapshot())).toEqual(populationTrace(uniform.snapshot()));
      expect(adaptive.snapshot().population.totalPeople).toBe(uniform.snapshot().population.totalPeople);
    }
  });

  it('preserves routing and demand across canonical battery simulation steps', () => {
    const first = new PatrolSystem(CONFIG, ADAPTIVE, ENVIRONMENT_PRESETS.compact);
    const second = new PatrolSystem(CONFIG, ADAPTIVE, ENVIRONMENT_PRESETS.compact);
    first.step(180);
    for (let step = 0; step < 360; step += 1) second.step(0.5);
    const large = first.snapshot();
    const small = second.snapshot();
    expect(populationTrace(small)).toEqual(populationTrace(large));
    expect(small.populationUpdates).toBe(6);
    expect(small.revision).toBe(large.revision);
    large.drones.forEach((drone, index) => {
      expect(small.drones[index].position.x).toBeCloseTo(drone.position.x, 6);
      expect(small.drones[index].position.z).toBeCloseTo(drone.position.z, 6);
      expect(small.drones[index].batteryFraction).toBeCloseTo(drone.batteryFraction, 6);
      expect(small.drones[index].serviceState).toBe(drone.serviceState);
    });
  });

  it('keeps density and total independent of sub-frame population boundary rounding', () => {
    const first = new PatrolSystem(CONFIG, ADAPTIVE, ENVIRONMENT_PRESETS.compact);
    const second = new PatrolSystem(CONFIG, ADAPTIVE, ENVIRONMENT_PRESETS.compact);
    first.step(180);
    for (let step = 0; step < 1800; step += 1) second.step(0.1);
    expect(populationTrace(second.snapshot())).toEqual(populationTrace(first.snapshot()));
    expect(second.snapshot().populationUpdates).toBe(first.snapshot().populationUpdates);
    expect(second.snapshot().nextPopulationChange).toBe(first.snapshot().nextPopulationChange);
  });

  it('replans immediately against changed live demand without rebuilding observation history', () => {
    const choose = vi.spyOn(PopulationPolicy.prototype, 'choose');
    try {
      const system = new PatrolSystem(CONFIG, ADAPTIVE);
      system.step(30);
      const snapshot = system.snapshot();
      const boundaryCalls = choose.mock.calls.filter(call => call[2] === 30);
      expect(boundaryCalls.length).toBeGreaterThan(0);
      expect(boundaryCalls[0][0].map(cell => cell.population)).toEqual(populationTrace(snapshot));
      expect(boundaryCalls[0][1].every(aircraft => !aircraft.committed)).toBe(true);
      expect(snapshot.revision).toBeGreaterThan(1);
      expect(snapshot.cells.some(cell => cell.lastVisited !== null && cell.lastVisited < 30)).toBe(true);
      const original = structuredClone(snapshot.cells);
      populateCells(original, snapshot.config);
      expect(original.map(cell => cell.lastVisited)).toEqual(snapshot.cells.map(cell => cell.lastVisited));
    } finally {
      choose.mockRestore();
    }
  });
});
