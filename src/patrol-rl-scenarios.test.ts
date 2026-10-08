import { describe, expect, it } from 'vitest';
import { insideEnvironment, validateEnvironment } from './patrol-environment';
import { createRLScenarios, populationDeadlineForScenario, populationForScenario } from './patrol-rl-scenarios';
import type { RLScenario } from './patrol-rl-scenarios';
import { populateCells } from './population';

function positionsFor(scenario: RLScenario): { x: number; z: number }[] {
  const positions: { x: number; z: number }[] = [];
  for (let depth = -scenario.environment.depth / 2 + 20; depth < scenario.environment.depth / 2; depth += 40) {
    for (let horizontal = -scenario.environment.width / 2 + 20; horizontal < scenario.environment.width / 2; horizontal += 40) {
      const position = { x: horizontal, z: depth };
      if (insideEnvironment(position, scenario.environment)) positions.push(position);
    }
  }
  return positions;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('neural patrol scenario protocol', () => {
  it('replays and extends suites while reserving disjoint seed partitions', () => {
    const seeds: number[] = [];
    for (const split of ['train', 'validation', 'final'] as const) {
      const small = createRLScenarios(split, 42, 8);
      const large = createRLScenarios(split, 42, 32);
      expect(createRLScenarios(split, 42, 8)).toEqual(small);
      expect(large.slice(0, 8)).toEqual(small);
      seeds.push(...large.map(scenario => scenario.seed));
      expect(new Set(large.map(scenario => scenario.family))).toEqual(new Set(['persistent', 'moving', 'surge', 'diffuse']));
    }
    expect(new Set(seeds).size).toBe(seeds.length);
    const training = createRLScenarios('train', 1, 4096).map(scenario => scenario.seed);
    const validation = createRLScenarios('validation', 2147483647, 4096).map(scenario => scenario.seed);
    const final = createRLScenarios('final', 900, 4096).map(scenario => scenario.seed);
    expect(Math.max(...training)).toBeLessThan(Math.min(...validation));
    expect(Math.max(...validation)).toBeLessThan(Math.min(...final));
    expect(new Set([...training, ...validation, ...final]).size).toBe(12288);
  });

  it('uses validated diverse conditions with held-out corridors and three scored battery cycles', () => {
    const training = createRLScenarios('train', 42, 24);
    const validation = createRLScenarios('validation', 42, 24);
    const final = createRLScenarios('final', 42, 24);
    expect(training.some(scenario => scenario.environment.shape === 'circle')).toBe(true);
    expect(training.some(scenario => scenario.environment.shape === 'rectangle')).toBe(true);
    expect(training.every(scenario => !scenario.environment.id.includes('corridor'))).toBe(true);
    expect(validation.some(scenario => scenario.environment.shape === 'circle')).toBe(true);
    expect(validation.some(scenario => scenario.environment.id.includes('district'))).toBe(true);
    expect(validation.filter(scenario => scenario.environment.id.includes('corridor'))).toHaveLength(12);
    const validationPilot = validation.slice(0, 4);
    expect(validationPilot.filter(scenario => !scenario.fault && scenario.environment.id.includes('corridor'))).toHaveLength(2);
    expect(validationPilot.filter(scenario => !scenario.fault && scenario.environment.shape === 'circle')).toHaveLength(1);
    expect(validationPilot.filter(scenario => scenario.fault)).toHaveLength(1);
    expect(Math.max(...final.map(scenario => scenario.environment.enduranceSeconds))).toBeLessThan(Math.min(...training.map(scenario => scenario.environment.enduranceSeconds)));
    for (const scenario of [...training, ...validation, ...final]) {
      expect(validateEnvironment(scenario.environment)).toEqual(scenario.environment);
      expect(scenario.warmupSeconds).toBe(120);
      expect(scenario.durationSeconds).toBeGreaterThanOrEqual(3 * (scenario.environment.enduranceSeconds + scenario.environment.rechargeSeconds));
      expect(scenario.config.populationDynamics?.enabled ?? false).toBe(false);
      if (scenario.fault) {
        expect(scenario.fault.atSeconds).toBeGreaterThan(scenario.warmupSeconds);
        expect(scenario.fault.atSeconds).toBeLessThan(scenario.warmupSeconds + scenario.durationSeconds);
        expect(scenario.fault.droneId).toBeUndefined();
      }
    }
    expect(new Set(training.flatMap(scenario => scenario.fault ? [scenario.fault.kind] : []))).toEqual(new Set(['malfunction', 'deviation']));
  });

  it('defines population by absolute time independently of call order, fleet size, or stepping', () => {
    for (const scenario of createRLScenarios('train', 42, 4)) {
      const positions = positionsFor(scenario);
      const directly = populationForScenario(scenario, positions, 900);
      for (let time = 0; time < 900; time += 0.5) populationForScenario(scenario, positions, time);
      expect(populationForScenario(scenario, positions, 900)).toEqual(directly);
      populationForScenario(scenario, positions, 5000);
      expect(populationForScenario(scenario, positions, 900)).toEqual(directly);
      expect(populationForScenario({ ...scenario, config: { ...scenario.config, fleetSize: 8 } }, positions, 900)).toEqual(directly);
      expect(populationForScenario(scenario, [...positions].reverse(), 900).reverse()).toEqual(directly);
    }
  });

  it('varies both totals and spatial density, retaining integer bounded population', () => {
    for (const scenario of createRLScenarios('train', 42, 4)) {
      const positions = positionsFor(scenario);
      const samples = Array.from({ length: 40 }, (_entry, index) => populationForScenario(scenario, positions, index * 45));
      const totals = samples.map(sum);
      expect(new Set(totals).size).toBeGreaterThan(10);
      expect(Math.min(...totals)).toBeGreaterThanOrEqual(Math.floor(scenario.config.populationCount * 0.65));
      expect(Math.max(...totals)).toBeLessThanOrEqual(Math.ceil(scenario.config.populationCount * 1.35));
      expect(samples.every(counts => counts.every(count => Number.isInteger(count) && count >= 0))).toBe(true);
      const firstDensity = samples[0].map(count => count / totals[0]);
      const lastDensity = samples.at(-1)!.map(count => count / totals.at(-1)!);
      expect(sum(firstDensity.map((density, index) => Math.abs(density - lastDensity[index])))).toBeGreaterThan(0.02);
    }
  });

  it('keeps persistent and moving crowds concentrated through long episodes', () => {
    for (const scenario of createRLScenarios('train', 123, 12).filter(entry => entry.family === 'persistent' || entry.family === 'moving')) {
      const positions = positionsFor(scenario);
      for (const time of [0, 120, 900, 3600, 10000]) {
        const counts = populationForScenario(scenario, positions, time);
        const strongest = [...counts].sort((first, second) => second - first).slice(0, Math.ceil(counts.length * 0.15));
        expect(sum(strongest) / sum(counts)).toBeGreaterThan(0.6);
        expect(Math.max(...counts)).toBeGreaterThanOrEqual(scenario.config.crowdedCellPopulation);
      }
    }
  });

  it('moves population peaks rather than blending old crowds away', () => {
    const scenario = createRLScenarios('train', 42, 2)[1];
    const positions = positionsFor(scenario);
    const peakPosition = (time: number) => {
      const counts = populationForScenario(scenario, positions, time);
      return positions[counts.indexOf(Math.max(...counts))];
    };
    const start = peakPosition(0);
    const later = peakPosition(240);
    expect(Math.hypot(later.x - start.x, later.z - start.z)).toBeGreaterThan(60);
  });

  it('introduces abrupt demand changes without depending on prior observations', () => {
    const scenario = createRLScenarios('train', 42, 3)[2];
    const positions = positionsFor(scenario);
    const boundary = 90 + scenario.seed % 61;
    const before = populationForScenario(scenario, positions, boundary - 0.001);
    const after = populationForScenario(scenario, positions, boundary);
    const difference = sum(before.map((count, index) => Math.abs(count / sum(before) - after[index] / sum(after))));
    expect(difference).toBeGreaterThan(0.5);
  });

  it('supports zero, tiny, capped totals and uses the established revisit deadline formula', () => {
    const scenario = createRLScenarios('train', 42, 1)[0];
    const positions = positionsFor(scenario);
    for (const baseline of [0, 1, 50000, 100000]) {
      const configured = { ...scenario, config: { ...scenario.config, populationCount: baseline } };
      for (const time of [0, 60, 1000]) {
        const counts = populationForScenario(configured, positions, time);
        expect(sum(counts)).toBeLessThanOrEqual(50000);
        expect(sum(counts)).toBeGreaterThanOrEqual(baseline ? 1 : 0);
        if (!baseline) expect(counts.every(count => count === 0)).toBe(true);
      }
    }
    const cells = positions.map((position, index) => ({ id: index, position: { ...position, y: 0 }, population: 0, lastVisited: null, assignedDroneId: null, targetRevisitSeconds: 0 }));
    populateCells(cells, scenario.config);
    for (const cell of cells) expect(populationDeadlineForScenario(scenario, cell.population)).toBe(cell.targetRevisitSeconds);
    expect(populationDeadlineForScenario(scenario, 0)).toBe(120);
    expect(populationDeadlineForScenario(scenario, 40)).toBe(67.5);
    expect(populationDeadlineForScenario(scenario, 80)).toBe(15);
    expect(populationForScenario(scenario, [], 0)).toEqual([]);
  });

  it('rejects invalid suite and time inputs', () => {
    expect(() => createRLScenarios('train', 0, 1)).toThrow();
    expect(() => createRLScenarios('train', 42, 0)).toThrow();
    expect(() => createRLScenarios('train', 42, 4097)).toThrow();
    const scenario = createRLScenarios('train', 42, 1)[0];
    expect(() => populationForScenario(scenario, positionsFor(scenario), -1)).toThrow();
    expect(() => populationForScenario(scenario, positionsFor(scenario), Infinity)).toThrow();
    expect(() => populationForScenario(scenario, [{ x: NaN, z: 0 }], 0)).toThrow();
  });
});
