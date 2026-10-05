import { describe, expect, it } from 'vitest';
import { PATROL_DEFAULTS } from './patrol';
import { compareMetrics, frontierCandidates, meetsRequirements, recommendedCandidate, runSearch, validateLearningSettings } from './patrol-search';
import type { EvaluationMetrics, LearningCandidate, LearningProgress, LearningSettings } from './patrol-learning-types';

const settings: LearningSettings = { config: { ...PATROL_DEFAULTS }, optimizerSeed: 91, generations: 1, budgetSeconds: 60 };
const perfect: EvaluationMetrics = {
  scenarios: 2, durationSeconds: 720, areaMinimum: 100, areaMean: 100, auditAreaMinimum: 100, auditAreaMean: 100,
  areaTargetFraction: 1, populationOnTime: 100, hotspotOnTime: 100, meanAgeSeconds: 1, gapCost: 0.1,
  maxObservationAge: 3, neverObservedPeople: 0, distanceMeters: 1000, geographicFeasible: true, hotspotFeasible: true,
};
const candidate = (id: string, fleetSize: number, metrics = perfect): LearningCandidate => ({ id, fleetSize, strategy: { kind: 'uniform' }, training: { ...metrics }, validation: { ...metrics }, failure: null });

describe('joint fleet and policy search', () => {
  it('requires every strict service gate before recommending the smallest tested fleet', () => {
    const small = candidate('small', 1, { ...perfect, gapCost: 0, hotspotOnTime: 99, hotspotFeasible: false });
    const feasible = candidate('feasible', 5);
    const larger = candidate('larger', 6, { ...perfect, gapCost: 0 });
    expect(compareMetrics(feasible.training, small.training)).toBeLessThan(0);
    expect(recommendedCandidate([small, larger, feasible])).toBe('feasible');
    feasible.validation = null;
    larger.validation = { ...perfect, neverObservedPeople: 1 };
    expect(recommendedCandidate([small, feasible, larger])).toBeNull();
  });

  it('retains fleet versus service trade-offs and separates training from held-out evidence', () => {
    const cheap = candidate('cheap', 2, { ...perfect, gapCost: 4 });
    const balanced = candidate('balanced', 4, { ...perfect, gapCost: 1 });
    const dominated = candidate('dominated', 5, { ...perfect, gapCost: 2 });
    const unvalidated = candidate('unvalidated', 1, { ...perfect, gapCost: 0 });
    unvalidated.validation = null;
    expect(frontierCandidates([cheap, balanced, dominated, unvalidated])).toEqual(['cheap', 'balanced', 'unvalidated']);
  });

  it('never trades battery safety or a failed scenario for pooled coverage gains', () => {
    const unsafe = { ...perfect, gapCost: 0, energyViolations: 1 };
    const reserveBreach = { ...perfect, gapCost: 0, reserveViolations: 1 };
    const uneven = { ...perfect, gapCost: 0, feasibleScenarioFraction: 0.5, worstCaseGapCost: 12 };
    expect(meetsRequirements(unsafe)).toBe(false);
    expect(meetsRequirements(reserveBreach)).toBe(false);
    expect(meetsRequirements(uneven)).toBe(false);
    expect(compareMetrics(perfect, unsafe)).toBeLessThan(0);
    expect(compareMetrics(perfect, reserveBreach)).toBeLessThan(0);
    expect(compareMetrics(perfect, uneven)).toBeLessThan(0);
    expect(recommendedCandidate([candidate('unsafe', 1, unsafe), candidate('uneven', 2, uneven), candidate('safe', 5)])).toBe('safe');
    expect(frontierCandidates([candidate('unsafe', 1, unsafe), candidate('safe', 1)])).toContain('safe');
    expect(compareMetrics({ ...perfect, worstCaseGapCost: 2, gapCost: 1 }, { ...perfect, worstCaseGapCost: 6, gapCost: 0.1 })).toBeLessThan(0);
  });

  it('rejects malformed settings instead of changing requirements', async () => {
    expect(validateLearningSettings(settings)).toEqual(settings);
    for (const invalid of [null, {}, { ...settings, profile: 'unknown' }, { ...settings, scenarioCount: 2 }, { ...settings, scenarioCount: 13 }, { ...settings, scenarioCount: 3.5 }, { ...settings, environment: {} }, { ...settings, generations: 0 }, { ...settings, budgetSeconds: Infinity }, { ...settings, optimizerSeed: 0 }, { ...settings, config: { ...settings.config, fleetSize: 9 } }]) {
      expect(validateLearningSettings(invalid)).toBeNull();
    }
    await expect(runSearch({ ...settings, budgetSeconds: 0 }, () => {})).rejects.toThrow('Invalid');
  });

  it('cancels within an episode without publishing a partial candidate', async () => {
    let checkpoints = 0;
    const result = await runSearch(settings, () => {}, { isCancelled: () => ++checkpoints > 10, now: () => 0 });
    expect(result.status).toBe('cancelled');
    expect(result.candidates).toEqual([]);
    expect(result.evaluations).toBe(0);
    expect(result.recommendedId).toBeNull();
  });

  it('honors its compute budget in an unfinished episode', async () => {
    let milliseconds = 0;
    const result = await runSearch({ ...settings, budgetSeconds: 15 }, () => {}, { now: () => (milliseconds += 1000), yieldControl: async () => {} });
    expect(result.status).toBe('completed');
    expect(result.message).toContain('budget exhausted');
    expect(result.candidates).toEqual([]);
    expect(result.evaluations).toBe(0);
  });

  it('pauses cooperatively and excludes pause time from the budget', async () => {
    let paused = true;
    let milliseconds = 0;
    let cancelled = false;
    const statuses: string[] = [];
    const result = await runSearch(settings, progress => statuses.push(progress.status), {
      isPaused: () => paused, isCancelled: () => cancelled, now: () => milliseconds,
      yieldControl: async () => { milliseconds += 100000; paused = false; cancelled = true; },
    });
    expect(statuses).toContain('paused');
    expect(result.status).toBe('cancelled');
    expect(result.elapsedSeconds).toBe(0);
  });

  it('actually searches all fleet sizes in generation one with deterministic policies and independent validation', async () => {
    const completed: LearningProgress[] = [];
    let firstGeneration: LearningProgress | null = null;
    const generations = { ...settings, generations: 2 };
    const first = await runSearch(generations, progress => {
      if (progress.evaluations <= 8 && progress.candidates.length) completed.push(progress);
      if (progress.generation === 1 && progress.evaluations === 16) firstGeneration = progress;
    }, { now: () => 0 });
    const second = await runSearch(generations, () => {}, { now: () => 0 });
    expect(first).toEqual(second);
    expect(first.status).toBe('completed');
    expect(first.testedFleetSizes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(first.candidates).toHaveLength(16);
    expect(first.candidates.every(entry => entry.validation !== null && entry.failure !== null)).toBe(true);
    expect(first.candidates.filter(entry => entry.strategy.kind === 'adaptive')).toHaveLength(8);
    expect(completed.find(progress => progress.evaluations === 8)?.candidates.every(entry => entry.strategy.kind === 'adaptive')).toBe(true);
    const adaptive = first.candidates.filter(entry => entry.strategy.kind === 'adaptive');
    expect(new Set(adaptive.map(entry => JSON.stringify(entry.strategy))).size).toBeGreaterThan(1);
    expect(first.evaluations).toBe(56);
    for (const entry of adaptive) {
      const original = (firstGeneration as LearningProgress | null)?.candidates.find(candidate => candidate.fleetSize === entry.fleetSize && candidate.strategy.kind === 'adaptive');
      expect(original).toBeDefined();
      expect(compareMetrics(entry.training, original!.training)).toBeLessThanOrEqual(0);
    }
    expect(settings.config).toEqual(PATROL_DEFAULTS);
  }, 60000);
});
