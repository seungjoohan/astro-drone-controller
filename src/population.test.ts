import { describe, expect, it } from 'vitest';
import type { PatrolCell, PatrolConfig, PatrolDrone } from './patrol-types';
import { evaluatePopulation, POPULATION_DEFAULTS, POPULATION_LIMITS, populateCells } from './population';

const CONFIG: PatrolConfig = { coverageTarget: 95, revisitSeconds: 120, fleetSize: 5, ...POPULATION_DEFAULTS };

function createCells(): PatrolCell[] {
  return Array.from({ length: 208 }, (_, index) => ({
    id: index,
    position: { x: (index % 16) * 40 - 300, y: 0, z: Math.floor(index / 16) * 40 - 240 },
    lastVisited: null,
    assignedDroneId: null,
    population: 0,
    targetRevisitSeconds: 120,
  }));
}

function drone(overrides: Partial<PatrolDrone> = {}): PatrolDrone {
  return { id: 1, color: '#ffffff', status: 'patrolling', serviceState: 'patrol', batteryFraction: 1, speed: 18, chargeCycles: 0, fault: null, position: { x: 0, y: 260, z: 0 }, route: [], assignedCellIds: [], routeIndex: 0, cycleSeconds: 0, ...overrides };
}

function cell(overrides: Partial<PatrolCell> = {}): PatrolCell {
  return { id: 1, position: { x: 0, y: 0, z: 0 }, lastVisited: null, assignedDroneId: null, population: 80, targetRevisitSeconds: 15, ...overrides };
}

describe('population scenarios', () => {
  it('reproduces a nonuniform clustered population with an exact total', () => {
    const first = createCells();
    const second = createCells();
    populateCells(first, CONFIG);
    populateCells(second, CONFIG);
    expect(first).toEqual(second);
    expect(first.reduce((total, entry) => total + entry.population, 0)).toBe(5000);
    expect(first.every(entry => Number.isInteger(entry.population) && entry.population >= 0)).toBe(true);
    expect(Math.max(...first.map(entry => entry.population))).toBeGreaterThan(4 * 5000 / first.length);
    expect(new Set(first.map(entry => entry.population)).size).toBeGreaterThan(20);
    expect(first.some(entry => entry.population >= CONFIG.crowdedCellPopulation)).toBe(true);
  });

  it('changes the scenario with its seed without changing its total', () => {
    const first = createCells();
    const second = createCells();
    populateCells(first, CONFIG);
    populateCells(second, { ...CONFIG, populationSeed: 43 });
    expect(first.map(entry => entry.population)).not.toEqual(second.map(entry => entry.population));
    expect(second.reduce((total, entry) => total + entry.population, 0)).toBe(CONFIG.populationCount);
  });

  it('allocates exact counts for sparse, empty, and maximum population scenarios', () => {
    for (const populationCount of [0, 1, 7, 49999, POPULATION_LIMITS.maxPopulation]) {
      const cells = createCells();
      populateCells(cells, { ...CONFIG, populationCount });
      expect(cells.reduce((total, entry) => total + entry.population, 0)).toBe(populationCount);
    }
    expect(() => populateCells([], CONFIG)).not.toThrow();
  });

  it('bounds invalid population inputs and uses deterministic fallback values', () => {
    const cells = createCells();
    populateCells(cells, { ...CONFIG, populationCount: Infinity, populationSeed: NaN, crowdedRevisitSeconds: NaN, crowdedCellPopulation: NaN });
    const defaults = createCells();
    populateCells(defaults, CONFIG);
    expect(cells).toEqual(defaults);
    populateCells(cells, { ...CONFIG, populationCount: 999999, populationSeed: -10 });
    expect(cells.reduce((total, entry) => total + entry.population, 0)).toBe(POPULATION_LIMITS.maxPopulation);
    populateCells(cells, { ...CONFIG, populationCount: -1 });
    expect(cells.every(entry => entry.population === 0 && entry.targetRevisitSeconds === 120)).toBe(true);
  });

  it('tightens deadlines with absolute population and caps them at the crowded deadline', () => {
    const cells = [cell()];
    for (const [populationCount, target] of [[0, 120], [40, 67.5], [80, 15], [160, 15]]) {
      populateCells(cells, { ...CONFIG, populationCount });
      expect(cells[0].targetRevisitSeconds).toBe(target);
    }
    populateCells(cells, { ...CONFIG, populationCount: 80, revisitSeconds: 10 });
    expect(cells[0].targetRevisitSeconds).toBe(10);
    populateCells(cells, { ...CONFIG, populationCount: 40, crowdedCellPopulation: 40 });
    expect(cells[0].targetRevisitSeconds).toBe(15);
  });

  it('preserves cell identity, ownership, positions, and observation history', () => {
    const cells = [cell({ lastVisited: 13, assignedDroneId: 4 })];
    const original = { ...cells[0], position: { ...cells[0].position } };
    populateCells(cells, CONFIG);
    expect(cells[0]).toMatchObject({ id: original.id, position: original.position, lastVisited: 13, assignedDroneId: 4 });
  });
});

describe('population evaluation', () => {
  it('reports weighted observation age, deadlines, unseen population, and hotspot service', () => {
    const cells = [
      cell({ population: 80, lastVisited: 90, targetRevisitSeconds: 15 }),
      cell({ id: 2, population: 20, lastVisited: 60, targetRevisitSeconds: 30 }),
      cell({ id: 3, population: 100, targetRevisitSeconds: 15 }),
    ];
    const result = evaluatePopulation(cells, 100, CONFIG, [], 32);
    expect(result.totalPeople).toBe(200);
    expect(result.onTimePeople).toBe(80);
    expect(result.onTimeCoverage).toBe(40);
    expect(result.inViewCoverage).toBe(0);
    expect(result.unseenPeople).toBe(100);
    expect(result.meanAgeSeconds).toBe((80 * 10 + 20 * 40 + 100 * 115) / 200);
    expect(result.normalizedGapCost).toBeCloseTo((80 * (10 / 15) ** 2 + 20 * (40 / 30) ** 2 + 100 * (115 / 15) ** 2) / 200);
    expect(result.hotspotCells).toBe(2);
    expect(result.hotspotOnTimeCells).toBe(1);
  });

  it('rewards shorter unobserved gaps even before deadlines are exceeded', () => {
    const cells = [cell({ lastVisited: 0 })];
    const recent = evaluatePopulation(cells, 2, CONFIG, [], 32);
    const older = evaluatePopulation(cells, 10, CONFIG, [], 32);
    expect(recent.onTimeCoverage).toBe(100);
    expect(older.onTimeCoverage).toBe(100);
    expect(recent.normalizedGapCost!).toBeLessThan(older.normalizedGapCost!);
    expect(evaluatePopulation(cells, 0, CONFIG, [], 32).normalizedGapCost).toBe(0);
  });

  it('counts current 360 degree footprints as a union regardless of drone altitude', () => {
    const cells = [cell({ population: 20, position: { x: 32, y: 0, z: 0 } }), cell({ id: 2, population: 60, position: { x: -32, y: 0, z: 0 } }), cell({ id: 3, population: 20, position: { x: 0, y: 0, z: 33 } })];
    const result = evaluatePopulation(cells, 0, CONFIG, [drone(), drone({ id: 2 })], 32);
    expect(result.inViewPeople).toBe(80);
    expect(result.inViewCoverage).toBe(80);
    expect(result.onTimeCoverage).toBe(0);
  });

  it('never credits faulty or offline sensors with current visibility', () => {
    for (const faulty of [drone({ status: 'unresponsive', fault: 'malfunction' }), drone({ status: 'deviating', fault: 'deviation' }), drone({ status: 'offline', fault: 'malfunction' }), drone({ fault: 'malfunction' })]) {
      expect(evaluatePopulation([cell()], 0, CONFIG, [faulty], 32).inViewPeople).toBe(0);
    }
  });

  it('does not treat unseen people as fresh at startup or hide them from the gap cost', () => {
    const initial = evaluatePopulation([cell()], 0, CONFIG, [], 32);
    expect(initial.onTimePeople).toBe(0);
    expect(initial.unseenPeople).toBe(80);
    expect(initial.meanAgeSeconds).toBe(15);
    expect(initial.normalizedGapCost).toBe(1);
    expect(evaluatePopulation([cell()], 10, CONFIG, [], 32).normalizedGapCost!).toBeGreaterThan(1);
  });

  it('uses inclusive deadlines and excludes empty cells from people metrics', () => {
    const cells = [cell({ lastVisited: 0 }), cell({ id: 2, population: 0 })];
    expect(evaluatePopulation(cells, 15, CONFIG, [], 32).onTimeCoverage).toBe(100);
    expect(evaluatePopulation(cells, 15.01, CONFIG, [], 32).onTimeCoverage).toBe(0);
    expect(evaluatePopulation(cells, 15, CONFIG, [], 32).unseenPeople).toBe(0);
  });

  it('reports no population as not applicable rather than perfect coverage', () => {
    for (const cells of [[], [cell({ population: 0 })]]) {
      expect(evaluatePopulation(cells, 30, CONFIG, [drone()], 32)).toEqual({ totalPeople: 0, onTimePeople: 0, onTimeCoverage: null, inViewPeople: 0, inViewCoverage: null, unseenPeople: 0, meanAgeSeconds: null, normalizedGapCost: null, hotspotCells: 0, hotspotOnTimeCells: 0 });
    }
  });

  it('returns detached metrics without mutating scenario data', () => {
    const cells = [cell({ lastVisited: 10 })];
    const before = structuredClone(cells);
    const result = evaluatePopulation(cells, 20, CONFIG, [], 32);
    result.totalPeople = 0;
    expect(evaluatePopulation(cells, 20, CONFIG, [], 32).totalPeople).toBe(80);
    expect(cells).toEqual(before);
  });
});
