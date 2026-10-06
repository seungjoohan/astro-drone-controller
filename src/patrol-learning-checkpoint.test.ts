import { describe, expect, it } from 'vitest';
import { PATROL_DEFAULTS } from './patrol';
import { createCheckpoint, ENERGY_EVALUATOR_VERSION, LEGACY_EVALUATOR_VERSION, parseCheckpoint, serializeCheckpoint, validateLearningSettings } from './patrol-learning-checkpoint';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import { createScenarios, evaluateScenarios } from './patrol-evaluator';
import type { EvaluationMetrics, LearningProgress, LearningSettings } from './patrol-learning-types';
import { DEFAULT_POPULATION_DYNAMICS } from './population';

const settings: LearningSettings = { config: { ...PATROL_DEFAULTS }, optimizerSeed: 42, generations: 3, budgetSeconds: 60 };
const metrics: EvaluationMetrics = {
  scenarios: 2, durationSeconds: 720, areaMinimum: 100, areaMean: 100, auditAreaMinimum: 100, auditAreaMean: 100, areaTargetFraction: 1,
  populationOnTime: 100, hotspotOnTime: 100, meanAgeSeconds: 2, gapCost: 0.1, maxObservationAge: 4,
  neverObservedPeople: 0, distanceMeters: 100, geographicFeasible: true, hotspotFeasible: true,
};
function progress(): LearningProgress {
  return {
    status: 'completed', generation: 3, evaluations: 4, elapsedSeconds: 5, testedFleetSizes: [5],
    candidates: [{ id: 'adaptive-5-3', fleetSize: 5, strategy: { kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS } }, training: { ...metrics }, validation: { ...metrics }, failure: null }],
    frontierIds: ['adaptive-5-3'], recommendedId: 'adaptive-5-3', message: 'Short pilot complete.',
  };
}

describe('learning checkpoint validation', () => {
  it('round-trips a versioned results snapshot without retaining mutable references', () => {
    const source = progress();
    const checkpoint = createCheckpoint(settings, source);
    expect(parseCheckpoint(serializeCheckpoint(checkpoint))).toEqual(checkpoint);
    source.candidates[0].training.gapCost = 999;
    expect(checkpoint.progress.candidates[0].training.gapCost).toBe(0.1);
  });

  it('accepts paused partial results but never upgrades unvalidated candidates', () => {
    const source = progress();
    source.status = 'paused';
    source.candidates[0].validation = null;
    source.recommendedId = null;
    expect(createCheckpoint(settings, source).progress.status).toBe('paused');
    source.recommendedId = source.candidates[0].id;
    expect(() => createCheckpoint(settings, source)).toThrow();
  });

  it('keeps the first-learning v1 report readable without relabeling its evaluation protocol', () => {
    const legacy = { version: 1, evaluatorVersion: LEGACY_EVALUATOR_VERSION, settings, progress: progress() };
    expect(parseCheckpoint(JSON.stringify(legacy))).toEqual(legacy);
    expect(createCheckpoint(settings, progress()).version).toBe(3);
    expect(parseCheckpoint(JSON.stringify({ ...legacy, version: 2 }))).toBeNull();
  });

  it('preserves v2 energy reports without adding or accepting new population semantics', () => {
    const legacy = { version: 2, evaluatorVersion: ENERGY_EVALUATOR_VERSION, settings, progress: progress() };
    expect(parseCheckpoint(JSON.stringify(legacy))).toEqual(legacy);
    expect(parseCheckpoint(JSON.stringify({ ...legacy, settings: { ...settings, config: { ...settings.config, populationDynamics: DEFAULT_POPULATION_DYNAMICS } } }))).toBeNull();
    const changed = structuredClone(legacy);
    changed.progress.candidates[0].training.populationWeighting = 'person-time';
    expect(parseCheckpoint(JSON.stringify(changed))).toBeNull();
  });

  it('strictly validates and copies population dynamics settings', () => {
    const source = { ...settings, config: { ...settings.config, populationDynamics: { ...DEFAULT_POPULATION_DYNAMICS, enabled: true } } };
    const parsed = validateLearningSettings(source)!;
    expect(parsed).toEqual(source);
    expect(parsed.config.populationDynamics).not.toBe(source.config.populationDynamics);
    for (const populationDynamics of [null, {}, { ...DEFAULT_POPULATION_DYNAMICS, enabled: 1 },
      { ...DEFAULT_POPULATION_DYNAMICS, intervalSeconds: 4 }, { ...DEFAULT_POPULATION_DYNAMICS, intervalSeconds: 5.5 },
      { ...DEFAULT_POPULATION_DYNAMICS, intervalSeconds: 601 }, { ...DEFAULT_POPULATION_DYNAMICS, redistributionFraction: 0 },
      { ...DEFAULT_POPULATION_DYNAMICS, countVariation: 1.1 }, { ...DEFAULT_POPULATION_DYNAMICS, extra: 1 }]) {
      expect(validateLearningSettings({ ...source, config: { ...source.config, populationDynamics } })).toBeNull();
    }
  });

  it('round-trips dynamic metrics above the initial count and rejects out-of-bound or relabeled evidence', async () => {
    const dynamicSettings = { ...settings, config: { ...settings.config, populationCount: 1000,
      populationDynamics: { ...DEFAULT_POPULATION_DYNAMICS, enabled: true, intervalSeconds: 5, countVariation: 1 } } };
    const evaluated = await evaluateScenarios(dynamicSettings.config, { kind: 'uniform' }, [{ populationSeed: 77, warmupSeconds: 0, evaluationSeconds: 60 }]);
    const source = progress();
    source.candidates[0].training = evaluated;
    source.candidates[0].validation = evaluated;
    source.recommendedId = null;
    const saved = createCheckpoint(dynamicSettings, source);
    expect(saved.version).toBe(3);
    expect(saved.progress.candidates[0].training.populationMaximum).toBeGreaterThan(1000);
    expect(parseCheckpoint(serializeCheckpoint(saved))).toEqual(saved);
    const changed = structuredClone(saved);
    changed.progress.candidates[0].training.scenarioResults![0].metrics.neverObservedPeople = 2001;
    expect(parseCheckpoint(JSON.stringify(changed))).toBeNull();
    const unweighted = structuredClone(saved);
    delete unweighted.progress.candidates[0].training.populationWeighting;
    expect(parseCheckpoint(JSON.stringify(unweighted))).toBeNull();
    const inconsistent = structuredClone(saved);
    inconsistent.progress.candidates[0].training.populationUpdates! += 1;
    expect(parseCheckpoint(JSON.stringify(inconsistent))).toBeNull();
    const missingSettings = structuredClone(saved);
    delete missingSettings.progress.candidates[0].training.scenarioResults![0].populationDynamics;
    expect(parseCheckpoint(JSON.stringify(missingSettings))).toBeNull();
  });

  it('round-trips diverse case evidence and rejects inconsistent aggregate safety claims', async () => {
    const diverseSettings = { ...settings, profile: 'diverse' as const, scenarioCount: 6 };
    const scenarios = createScenarios(settings.config, 'validation', diverseSettings).map(scenario => ({ ...scenario, warmupSeconds: 0, evaluationSeconds: 1 }));
    const evaluated = await evaluateScenarios(settings.config, { kind: 'uniform' }, scenarios);
    const source = progress();
    source.candidates[0].training = evaluated;
    source.candidates[0].validation = evaluated;
    source.recommendedId = null;
    const saved = createCheckpoint(diverseSettings, source);
    expect(parseCheckpoint(serializeCheckpoint(saved))).toEqual(saved);
    expect(saved.progress.candidates[0].validation!.scenarioResults).toHaveLength(3);
    const inconsistent = structuredClone(saved);
    inconsistent.progress.candidates[0].training.energyViolations = 1;
    expect(parseCheckpoint(JSON.stringify(inconsistent))).toBeNull();
    const nested = structuredClone(saved);
    nested.progress.candidates[0].training.scenarioResults![0].populationCount = 0;
    expect(parseCheckpoint(JSON.stringify(nested))).toBeNull();
  });

  it('preserves replay overrides when a suite mixes dynamic and stationary cities', async () => {
    const evaluated = await evaluateScenarios(settings.config, { kind: 'uniform' }, [
      { populationSeed: 77, populationCount: 1000, populationDynamics: { ...DEFAULT_POPULATION_DYNAMICS, enabled: true, intervalSeconds: 5 }, warmupSeconds: 0, evaluationSeconds: 10 },
      { populationSeed: 78, populationCount: 0, warmupSeconds: 0, evaluationSeconds: 10 },
    ]);
    const source = progress();
    source.candidates[0].training = evaluated;
    source.candidates[0].validation = null;
    source.recommendedId = null;
    const saved = createCheckpoint(settings, source);
    expect(saved.progress.candidates[0].training).toMatchObject({ populationWeighting: 'person-time', populationMinimum: 0, populationUpdates: 2 });
    expect(saved.progress.candidates[0].training.scenarioResults![1].metrics.populationWeighting).toBeUndefined();
    expect(parseCheckpoint(serializeCheckpoint(saved))).toEqual(saved);
  });

  it('rejects malformed, oversized, incompatible, non-finite and inconsistent evidence', () => {
    expect(parseCheckpoint('not json')).toBeNull();
    expect(parseCheckpoint(' '.repeat(250001))).toBeNull();
    const mutations: ((value: ReturnType<typeof createCheckpoint>) => void)[] = [
      value => { value.version = 4 as 1; },
      value => { value.evaluatorVersion = 'old'; },
      value => { value.settings.config.populationCount = -1; },
      value => { value.progress.elapsedSeconds = Infinity; },
      value => { value.progress.candidates[0].training.gapCost = NaN; },
      value => { value.progress.candidates[0].training.auditAreaMinimum = 90; },
      value => { value.progress.candidates[0].training.hotspotOnTime = 99; },
      value => { value.progress.candidates[0].validation!.energyViolations = 1; },
      value => { value.progress.candidates[0].validation!.reserveViolations = 1; },
      value => { value.progress.candidates[0].validation!.feasibleScenarioFraction = 0.5; },
      value => { value.progress.candidates[0].training.neverObservedPeople = 50001; },
      value => { value.progress.candidates[0].fleetSize = 9; },
      value => { value.progress.candidates.push(value.progress.candidates[0]); },
      value => { value.progress.frontierIds = ['missing']; },
      value => { value.progress.recommendedId = 'missing'; },
      value => { value.progress.testedFleetSizes = [1]; },
      value => { value.progress.candidates[0].strategy = { kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS, travelPenalty: -1 } }; },
    ];
    for (const mutate of mutations) {
      const checkpoint = createCheckpoint(settings, progress());
      mutate(checkpoint);
      expect(parseCheckpoint(JSON.stringify(checkpoint))).toBeNull();
    }
  });
});
