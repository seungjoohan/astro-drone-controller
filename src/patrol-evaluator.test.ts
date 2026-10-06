import { describe, expect, it } from 'vitest';
import { PATROL_DEFAULTS, PatrolSystem } from './patrol';
import { createScenarios, evaluateScenarios, EvaluationAccumulator, scenarioSeeds } from './patrol-evaluator';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import { DEFAULT_ENVIRONMENT } from './patrol-environment';
import { DEFAULT_POPULATION_DYNAMICS } from './population';

describe('patrol episode evaluation', () => {
  it('freezes disjoint population splits independently of optimizer randomness', () => {
    const seeds = scenarioSeeds(2147483647);
    const all = [...seeds.training, ...seeds.validation, ...seeds.failure];
    expect(new Set(all).size).toBe(5);
    expect(all.every(seed => Number.isInteger(seed) && seed >= 1 && seed <= 2147483647)).toBe(true);
    expect(scenarioSeeds(2147483647)).toEqual(seeds);
    expect(scenarioSeeds(42)).not.toEqual(seeds);
    const scenarios = createScenarios(PATROL_DEFAULTS, 'failure');
    expect(scenarios[0].fault!.timeSeconds).toBeGreaterThan(scenarios[0].warmupSeconds);
    expect(scenarios[0].fault!.droneId).toBeLessThanOrEqual(PATROL_DEFAULTS.fleetSize);
  });

  it('integrates the whole observation window rather than rewarding the last frame', () => {
    const system = new PatrolSystem();
    const snapshot = system.snapshot();
    snapshot.coverage = 80;
    snapshot.population.onTimeCoverage = 20;
    snapshot.population.meanAgeSeconds = 30;
    snapshot.population.normalizedGapCost = 8;
    const accumulator = new EvaluationAccumulator();
    accumulator.add(snapshot, 3, 75);
    snapshot.coverage = 100;
    snapshot.population.onTimeCoverage = 100;
    snapshot.population.meanAgeSeconds = 2;
    snapshot.population.normalizedGapCost = 0;
    accumulator.add(snapshot, 1, 100);
    const result = accumulator.metrics();
    expect(result.durationSeconds).toBe(4);
    expect(result.areaMean).toBe(85);
    expect(result.auditAreaMean).toBe(81.25);
    expect(result.populationOnTime).toBe(40);
    expect(result.meanAgeSeconds).toBe(23);
    expect(result.gapCost).toBe(6);
    expect(result.areaTargetFraction).toBe(0.25);
    expect(result.geographicFeasible).toBe(false);
  });

  it('fails geographic gates when the independent audit finds holes', () => {
    const snapshot = new PatrolSystem({ populationCount: 0 }).snapshot();
    snapshot.coverage = 100;
    const accumulator = new EvaluationAccumulator();
    accumulator.add(snapshot, 1, 94);
    expect(accumulator.metrics()).toMatchObject({ areaMinimum: 100, auditAreaMinimum: 94, geographicFeasible: false, areaTargetFraction: 0 });
  });

  it('weights hotspot service by residents and rejects even a single late hotspot', () => {
    const snapshot = new PatrolSystem().snapshot();
    snapshot.time = 100;
    snapshot.cells = [
      { ...snapshot.cells[0], population: 100, lastVisited: 100, targetRevisitSeconds: 15 },
      { ...snapshot.cells[1], population: 300, lastVisited: 0, targetRevisitSeconds: 15 },
    ];
    const accumulator = new EvaluationAccumulator();
    accumulator.add(snapshot, 1);
    expect(accumulator.metrics()).toMatchObject({ hotspotOnTime: 25, hotspotFeasible: false });
  });

  it('weights changing population and hotspot metrics by person-time instead of averaging percentages', () => {
    const snapshot = new PatrolSystem().snapshot();
    snapshot.time = 100;
    snapshot.cells = [{ ...snapshot.cells[0], population: 100, lastVisited: 100, targetRevisitSeconds: 15 }];
    snapshot.population.totalPeople = 100;
    snapshot.population.onTimeCoverage = 100;
    snapshot.population.meanAgeSeconds = 0;
    snapshot.population.normalizedGapCost = 0;
    const accumulator = new EvaluationAccumulator(true);
    accumulator.add(snapshot, 1);
    snapshot.cells[0].population = 300;
    snapshot.cells[0].lastVisited = 0;
    snapshot.population.totalPeople = 300;
    snapshot.population.onTimeCoverage = 0;
    snapshot.population.meanAgeSeconds = 100;
    snapshot.population.normalizedGapCost = 4;
    accumulator.add(snapshot, 1);
    expect(accumulator.metrics()).toMatchObject({ populationWeighting: 'person-time', populationOnTime: 25,
      hotspotOnTime: 25, meanAgeSeconds: 75, gapCost: 3, populationMinimum: 100, populationMaximum: 300, hotspotFeasible: false });
  });

  it('reports no population objective for an empty city', async () => {
    const result = await evaluateScenarios({ ...PATROL_DEFAULTS, populationCount: 0 }, { kind: 'uniform' }, [{ populationSeed: 42, warmupSeconds: 1, evaluationSeconds: 2 }]);
    expect(result).toMatchObject({ scenarios: 1, durationSeconds: 2, populationOnTime: null, hotspotOnTime: null, meanAgeSeconds: null, gapCost: null, neverObservedPeople: 0, hotspotFeasible: true });
    expect(Number.isFinite(result.maxObservationAge)).toBe(true);
  });

  it('is deterministic, does not mutate inputs, and measures a complete held-out mission', async () => {
    const config = { ...PATROL_DEFAULTS };
    const strategy = { kind: 'adaptive' as const, parameters: { ...DEFAULT_POLICY_PARAMETERS } };
    const scenarios = [{ populationSeed: 77, warmupSeconds: 2, evaluationSeconds: 6 }];
    const first = await evaluateScenarios(config, strategy, scenarios);
    expect(await evaluateScenarios(config, strategy, scenarios)).toEqual(first);
    expect(config).toEqual(PATROL_DEFAULTS);
    expect(strategy.parameters).toEqual(DEFAULT_POLICY_PARAMETERS);
    expect(first.durationSeconds).toBe(6);
    expect(first.neverObservedPeople).toBeGreaterThan(0);
    expect(first.distanceMeters).toBeGreaterThan(0);
  });

  it('checks cancellation throughout a trial and never returns partial metrics', async () => {
    let checks = 0;
    await expect(evaluateScenarios(PATROL_DEFAULTS, { kind: 'uniform' }, [{ populationSeed: 42, warmupSeconds: 120, evaluationSeconds: 240 }], {
      checkpoint: async () => { if (++checks === 9) throw new Error('stop'); },
    })).rejects.toThrow('stop');
    expect(checks).toBe(9);
  });

  it('replays changing populations, excludes warmup changes, and honors scenario overrides', async () => {
    const populationDynamics = { ...DEFAULT_POPULATION_DYNAMICS, enabled: true, intervalSeconds: 5, countVariation: 0.75 };
    const config = { ...PATROL_DEFAULTS, populationDynamics };
    const scenarios = [{ populationSeed: 77, warmupSeconds: 5, evaluationSeconds: 15 }];
    const first = await evaluateScenarios(config, { kind: 'uniform' }, scenarios);
    expect(await evaluateScenarios(config, { kind: 'uniform' }, scenarios)).toEqual(first);
    expect(first.populationUpdates).toBe(3);
    expect(first.populationMinimum).toBeLessThan(first.populationMaximum!);
    expect(first.scenarioResults![0].populationDynamics).toEqual(populationDynamics);
    expect(first.populationWeighting).toBe('person-time');
    const stationary = await evaluateScenarios(config, { kind: 'uniform' }, [{ ...scenarios[0], populationDynamics: { ...populationDynamics, enabled: false } }]);
    const classic = await evaluateScenarios(PATROL_DEFAULTS, { kind: 'uniform' }, scenarios);
    expect(stationary.populationWeighting).toBeUndefined();
    expect(stationary.populationOnTime).toBe(classic.populationOnTime);
    expect(stationary.gapCost).toBe(classic.gapCost);
    const empty = await evaluateScenarios({ ...config, populationCount: 0 }, { kind: 'uniform' }, scenarios);
    expect(empty).toMatchObject({ populationOnTime: null, gapCost: null, populationMinimum: 0, populationMaximum: 0, neverObservedPeople: 0 });
    await expect(evaluateScenarios(config, { kind: 'uniform' }, [{ ...scenarios[0], populationDynamics: { ...populationDynamics, intervalSeconds: 0 } }])).rejects.toThrow();
  });

  it('keeps every scenario visible and reports worst-case gaps rather than just pooled means', async () => {
    const result = await evaluateScenarios(PATROL_DEFAULTS, { kind: 'uniform' }, [
      { id: 'small', family: 'compact', populationSeed: 44, populationCount: 1000, warmupSeconds: 1, evaluationSeconds: 2, environment: { ...DEFAULT_ENVIRONMENT, width: 240, depth: 240 } },
      { id: 'large', family: 'district', populationSeed: 55, populationCount: 7000, warmupSeconds: 1, evaluationSeconds: 4 },
    ]);
    expect(result.scenarioResults).toHaveLength(2);
    expect(result.scenarioResults!.map(scenario => scenario.populationCount)).toEqual([1000, 7000]);
    expect(result.scenarioResults!.map(scenario => scenario.metrics.durationSeconds)).toEqual([2, 4]);
    expect(result.worstCaseGapCost).toBe(Math.max(...result.scenarioResults!.map(scenario => scenario.metrics.gapCost!)));
    expect(result.areaMinimum).toBe(Math.min(...result.scenarioResults!.map(scenario => scenario.metrics.areaMinimum)));
    expect(result.feasibleScenarioFraction).toBe(0);
    expect(result.energyViolations).toBe(0);
  });

  it('evaluates charging rotations with the entire fleet counted and battery safety reported', async () => {
    const environment = { ...DEFAULT_ENVIRONMENT, id: 'battery-test', width: 160, depth: 160, sensorRadius: 48,
      batteryEnabled: true, enduranceSeconds: 120, rechargeSeconds: 30, chargingPads: 1, initialChargeFraction: 0.7 };
    const result = await evaluateScenarios({ ...PATROL_DEFAULTS, fleetSize: 2 }, { kind: 'uniform' }, [
      { populationSeed: 42, warmupSeconds: 120, evaluationSeconds: 600, environment },
    ]);
    expect(result.completedCharges).toBeGreaterThanOrEqual(4);
    expect(result.energyUsed).toBeGreaterThan(2);
    expect(result.reserveViolations).toBe(0);
    expect(result.energyViolations).toBe(0);
    expect(result.scenarioResults![0].metrics.completedCharges).toBe(result.completedCharges);
  });

  it('rejects empty or invalid durations and an unmeasured accumulator', async () => {
    await expect(evaluateScenarios(PATROL_DEFAULTS, { kind: 'uniform' }, [])).rejects.toThrow();
    await expect(evaluateScenarios(PATROL_DEFAULTS, { kind: 'uniform' }, [{ populationSeed: 1, warmupSeconds: 0, evaluationSeconds: NaN }])).rejects.toThrow();
    expect(() => new EvaluationAccumulator().metrics()).toThrow();
    expect(() => new EvaluationAccumulator().add(new PatrolSystem().snapshot(), 0)).toThrow();
  });
});
