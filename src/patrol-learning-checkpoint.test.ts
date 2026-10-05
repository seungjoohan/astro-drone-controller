import { describe, expect, it } from 'vitest';
import { PATROL_DEFAULTS } from './patrol';
import { createCheckpoint, LEGACY_EVALUATOR_VERSION, parseCheckpoint, serializeCheckpoint } from './patrol-learning-checkpoint';
import { DEFAULT_POLICY_PARAMETERS } from './patrol-policy';
import { createScenarios, evaluateScenarios } from './patrol-evaluator';
import type { EvaluationMetrics, LearningProgress, LearningSettings } from './patrol-learning-types';

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
    expect(createCheckpoint(settings, progress()).version).toBe(2);
    expect(parseCheckpoint(JSON.stringify({ ...legacy, version: 2 }))).toBeNull();
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

  it('rejects malformed, oversized, incompatible, non-finite and inconsistent evidence', () => {
    expect(parseCheckpoint('not json')).toBeNull();
    expect(parseCheckpoint(' '.repeat(250001))).toBeNull();
    const mutations: ((value: ReturnType<typeof createCheckpoint>) => void)[] = [
      value => { value.version = 3 as 1; },
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
