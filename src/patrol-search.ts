import { createScenarios, evaluateScenarios } from './patrol-evaluator';
import { validateLearningSettings } from './patrol-learning-checkpoint';
import { DEFAULT_POLICY_PARAMETERS, validateStrategy } from './patrol-policy';
import type { EvaluationMetrics, LearningCandidate, LearningProgress, LearningSettings, PatrolStrategy, PolicyParameters } from './patrol-learning-types';

export { validateLearningSettings } from './patrol-learning-checkpoint';

export interface SearchControls {
  isCancelled?: () => boolean;
  isPaused?: () => boolean;
  yieldControl?: () => Promise<void>;
  now?: () => number;
}

class SearchInterrupted extends Error {
  constructor(readonly reason: 'cancelled' | 'budget') { super(reason); }
}

function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 4294967296;
  };
}

export function meetsRequirements(metrics: EvaluationMetrics): boolean {
  return metrics.geographicFeasible && metrics.hotspotFeasible && metrics.neverObservedPeople === 0
    && (metrics.energyViolations ?? 0) === 0 && (metrics.reserveViolations ?? 0) === 0
    && (metrics.feasibleScenarioFraction ?? 1) >= 1 - 1e-8;
}

function robustComparison(metrics: EvaluationMetrics): boolean {
  return metrics.scenarioResults ? metrics.scenarioResults.some(scenario => scenario.family !== 'current' || scenario.environment.batteryEnabled)
    : metrics.feasibleScenarioFraction !== undefined || metrics.worstCaseGapCost !== undefined;
}

function comparisonPassFraction(metrics: EvaluationMetrics): number {
  return robustComparison(metrics) ? metrics.feasibleScenarioFraction ?? Number(meetsRequirements(metrics)) : Number(meetsRequirements(metrics));
}

function comparisonGapCost(metrics: EvaluationMetrics): number {
  return (robustComparison(metrics) ? metrics.worstCaseGapCost ?? metrics.gapCost : metrics.gapCost) ?? 0;
}

export function compareMetrics(first: EvaluationMetrics, second: EvaluationMetrics): number {
  const energyDifference = (first.energyViolations ?? 0) - (second.energyViolations ?? 0);
  if (energyDifference) return energyDifference;
  const reserveDifference = (first.reserveViolations ?? 0) - (second.reserveViolations ?? 0);
  if (reserveDifference) return reserveDifference;
  const firstFeasible = meetsRequirements(first);
  const secondFeasible = meetsRequirements(second);
  if (firstFeasible !== secondFeasible) return firstFeasible ? -1 : 1;
  const scenarioDifference = comparisonPassFraction(second) - comparisonPassFraction(first);
  if (Math.abs(scenarioDifference) > 1e-8) return scenarioDifference;
  const firstDeficit = (100 - Math.min(first.areaMinimum, first.auditAreaMinimum)) / 100 + (1 - first.areaTargetFraction) + (100 - (first.hotspotOnTime ?? 100)) / 100;
  const secondDeficit = (100 - Math.min(second.areaMinimum, second.auditAreaMinimum)) / 100 + (1 - second.areaTargetFraction) + (100 - (second.hotspotOnTime ?? 100)) / 100;
  if (!firstFeasible && Math.abs(firstDeficit - secondDeficit) > 1e-8) return firstDeficit - secondDeficit;
  if (first.neverObservedPeople !== second.neverObservedPeople) return first.neverObservedPeople - second.neverObservedPeople;
  if (robustComparison(first) && robustComparison(second)) {
    const worstCaseDifference = comparisonGapCost(first) - comparisonGapCost(second);
    if (Math.abs(worstCaseDifference) > 1e-8) return worstCaseDifference;
  }
  return (first.gapCost ?? (100 - first.areaMean)) - (second.gapCost ?? (100 - second.areaMean)) || first.distanceMeters - second.distanceMeters;
}

export function frontierCandidates(candidates: LearningCandidate[]): string[] {
  return candidates.filter(candidate => !candidates.some(other => {
    if (other.id === candidate.id) return false;
    const first = other.validation ?? other.training;
    const second = candidate.validation ?? candidate.training;
    if ((other.validation === null) !== (candidate.validation === null)) return false;
    const noWorse = other.fleetSize <= candidate.fleetSize && first.areaMinimum >= second.areaMinimum - 1e-8
      && first.auditAreaMinimum >= second.auditAreaMinimum - 1e-8
      && first.areaTargetFraction >= second.areaTargetFraction - 1e-8 && (first.hotspotOnTime ?? 100) >= (second.hotspotOnTime ?? 100) - 1e-8
      && first.neverObservedPeople <= second.neverObservedPeople && (first.gapCost ?? 0) <= (second.gapCost ?? 0) + 1e-8
      && (first.energyViolations ?? 0) <= (second.energyViolations ?? 0) && (first.reserveViolations ?? 0) <= (second.reserveViolations ?? 0)
      && comparisonPassFraction(first) >= comparisonPassFraction(second) - 1e-8
      && comparisonGapCost(first) <= comparisonGapCost(second) + 1e-8;
    const better = other.fleetSize < candidate.fleetSize || first.areaMinimum > second.areaMinimum + 1e-8
      || first.auditAreaMinimum > second.auditAreaMinimum + 1e-8
      || first.areaTargetFraction > second.areaTargetFraction + 1e-8 || (first.hotspotOnTime ?? 100) > (second.hotspotOnTime ?? 100) + 1e-8
      || first.neverObservedPeople < second.neverObservedPeople || (first.gapCost ?? 0) < (second.gapCost ?? 0) - 1e-8
      || (first.energyViolations ?? 0) < (second.energyViolations ?? 0) || (first.reserveViolations ?? 0) < (second.reserveViolations ?? 0)
      || comparisonPassFraction(first) > comparisonPassFraction(second) + 1e-8
      || comparisonGapCost(first) < comparisonGapCost(second) - 1e-8;
    return noWorse && better;
  })).map(candidate => candidate.id);
}

export function recommendedCandidate(candidates: LearningCandidate[]): string | null {
  return candidates.filter(candidate => candidate.validation && meetsRequirements(candidate.validation))
    .sort((first, second) => first.fleetSize - second.fleetSize || compareMetrics(first.validation!, second.validation!))[0]?.id ?? null;
}

function mutate(parameters: PolicyParameters, random: () => number, magnitude: number, learnSpeed = false): PatrolStrategy {
  const change = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value + (random() * 2 - 1) * (maximum - minimum) * magnitude));
  const strategy: PatrolStrategy = { kind: 'adaptive', parameters: {
    populationWeight: change(parameters.populationWeight, 0, 20), coverageWeight: change(parameters.coverageWeight, 0.01, 30),
    ageExponent: change(parameters.ageExponent, 1, 4), travelPenalty: change(parameters.travelPenalty, 0, 5),
    commitmentSeconds: change(parameters.commitmentSeconds, 1, 15),
    ...(learnSpeed ? { speedFraction: change(parameters.speedFraction ?? 1, 0.5, 1) } : {}),
  } };
  return validateStrategy(strategy)!;
}

export async function runSearch(input: LearningSettings, onProgress: (progress: LearningProgress) => void, controls: SearchControls = {}): Promise<LearningProgress> {
  const settings = validateLearningSettings(input);
  if (!settings) throw new Error('Invalid learning settings.');
  const now = controls.now ?? (() => performance.now());
  const yieldControl = controls.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const started = now();
  let pausedMilliseconds = 0;
  let lastYield = started;
  const random = randomGenerator(settings.optimizerSeed);
  const diverse = settings.profile === 'diverse';
  const protocolLabel = diverse ? 'Bounded robustness pilot' : settings.environment?.batteryEnabled ? 'Battery-cycle pilot' : 'Short pilot';
  const incumbents = new Map<number, LearningCandidate>();
  const baselines = new Map<number, LearningCandidate>();
  const progress: LearningProgress = { status: 'running', generation: 0, evaluations: 0, elapsedSeconds: 0, testedFleetSizes: [], candidates: [], frontierIds: [], recommendedId: null, message: `${protocolLabel}: jointly testing total fleets 1–8, then held-out validation.` };
  const elapsed = () => Math.max(0, (now() - started - pausedMilliseconds) / 1000);
  const emit = () => {
    progress.elapsedSeconds = elapsed();
    progress.candidates = [...baselines.values(), ...incumbents.values()].sort((first, second) => first.fleetSize - second.fleetSize || first.id.localeCompare(second.id));
    progress.testedFleetSizes = [...new Set(progress.candidates.map(candidate => candidate.fleetSize))].sort((first, second) => first - second);
    progress.frontierIds = frontierCandidates(progress.candidates);
    progress.recommendedId = recommendedCandidate(progress.candidates);
    onProgress(structuredClone(progress));
  };
  const checkpoint = async () => {
    if (controls.isCancelled?.()) throw new SearchInterrupted('cancelled');
    if (controls.isPaused?.()) {
      const pausedAt = now();
      progress.status = 'paused';
      emit();
      while (controls.isPaused?.() && !controls.isCancelled?.()) await yieldControl();
      pausedMilliseconds += now() - pausedAt;
      lastYield = now();
      progress.status = 'running';
      if (controls.isCancelled?.()) throw new SearchInterrupted('cancelled');
      emit();
    }
    if (elapsed() >= settings.budgetSeconds) throw new SearchInterrupted('budget');
    if (now() - lastYield >= 20) {
      await yieldControl();
      lastYield = now();
      if (controls.isCancelled?.()) throw new SearchInterrupted('cancelled');
      if (elapsed() >= settings.budgetSeconds) throw new SearchInterrupted('budget');
    }
  };
  const evaluate = async (fleetSize: number, strategy: PatrolStrategy, kind: 'training' | 'validation' | 'failure') => {
    progress.message = `${protocolLabel} · ${kind} · ${fleetSize} total drones · ${strategy.kind}.`;
    emit();
    const config = { ...settings.config, fleetSize };
    const metrics = await evaluateScenarios(config, strategy, createScenarios(config, kind, settings), { checkpoint });
    progress.evaluations += 1;
    return metrics;
  };
  emit();
  try {
    for (let generation = 1; generation <= settings.generations; generation += 1) {
      progress.generation = generation;
      for (let fleetSize = 1; fleetSize <= 8; fleetSize += 1) {
        if (generation > 1 && elapsed() >= settings.budgetSeconds * 0.45) break;
        const parent = incumbents.get(fleetSize)?.strategy;
        const parameters = parent?.kind === 'adaptive' ? parent.parameters : DEFAULT_POLICY_PARAMETERS;
        const strategy = mutate(parameters, random, generation === 1 ? 0.12 : 0.3 / Math.sqrt(generation), diverse || settings.environment?.batteryEnabled);
        const training = await evaluate(fleetSize, strategy, 'training');
        const candidate: LearningCandidate = { id: `adaptive-${fleetSize}-${generation}`, fleetSize, strategy, training, validation: null, failure: null };
        const incumbent = incumbents.get(fleetSize);
        if (!incumbent || compareMetrics(training, incumbent.training) < 0) incumbents.set(fleetSize, candidate);
        emit();
      }
      if (generation === 1) {
        for (let fleetSize = 1; fleetSize <= 8; fleetSize += 1) {
          const strategy: PatrolStrategy = { kind: 'uniform' };
          const training = await evaluate(fleetSize, strategy, 'training');
          baselines.set(fleetSize, { id: `uniform-${fleetSize}`, fleetSize, strategy, training, validation: null, failure: null });
          emit();
        }
      }
      if (elapsed() >= settings.budgetSeconds * 0.45) break;
    }
    const finalists = [...incumbents.values()].sort((first, second) => compareMetrics(first.training, second.training) || first.fleetSize - second.fleetSize);
    for (const candidate of finalists) {
      candidate.validation = await evaluate(candidate.fleetSize, candidate.strategy, 'validation');
      emit();
      const baseline = baselines.get(candidate.fleetSize);
      if (baseline) {
        baseline.validation = await evaluate(baseline.fleetSize, baseline.strategy, 'validation');
        emit();
      }
    }
    for (const candidate of [...finalists, ...baselines.values()]) {
      candidate.failure = await evaluate(candidate.fleetSize, candidate.strategy, 'failure');
      emit();
    }
    progress.status = 'completed';
    progress.message = progress.recommendedId ? `${protocolLabel} complete. A tested candidate meets all sampled healthy gates; this is not proof of an optimal or universally robust fleet.` : `${protocolLabel} complete. No tested strategy meets all strict healthy requirements. Review per-scenario trade-offs; failure results are separate.`;
  } catch (error) {
    if (!(error instanceof SearchInterrupted)) throw error;
    progress.status = error.reason === 'cancelled' ? 'cancelled' : 'completed';
    progress.message = error.reason === 'cancelled' ? 'Search cancelled. Only fully completed evaluations are retained; the visible mission is unchanged.' : 'Compute budget exhausted. Partial results retained; unvalidated candidates cannot be applied. Increase the budget for more evidence.';
  }
  emit();
  return structuredClone(progress);
}
