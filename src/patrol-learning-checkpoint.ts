import { EVALUATOR_VERSION } from './patrol-evaluator';
import { validateStrategy } from './patrol-policy';
import { validateEnvironment } from './patrol-environment';
import { validatePopulationDynamics } from './population';
import type { EvaluationMetrics, LearningCheckpoint, LearningProgress, LearningSettings } from './patrol-learning-types';
import type { PopulationDynamics } from './patrol-types';

const MAX_CHECKPOINT_LENGTH = 1000000;
export const LEGACY_EVALUATOR_VERSION = 'patrol-pilot-v1-grid40-audit10-dt0.5';
export const ENERGY_EVALUATOR_VERSION = 'patrol-robustness-v2-energy-grid40-audit10-dt0.5';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberIn(value: unknown, minimum: number, maximum: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isInteger(value));
}

export function validateLearningSettings(value: unknown): LearningSettings | null {
  if (!record(value) || !record(value.config)) return null;
  const config = value.config;
  if (!numberIn(config.coverageTarget, 0, 100) || !numberIn(config.revisitSeconds, 1, 3600)
    || !numberIn(config.fleetSize, 1, 8, true) || !numberIn(config.populationCount, 0, 50000, true)
    || !numberIn(config.populationSeed, 1, 2147483647, true) || !numberIn(config.crowdedRevisitSeconds, 1, Math.min(config.revisitSeconds, 300))
    || !numberIn(config.crowdedCellPopulation, 1, 1000, true) || !numberIn(value.optimizerSeed, 1, 2147483647, true)
    || !numberIn(value.generations, 1, 20, true) || !numberIn(value.budgetSeconds, 15, 600)
    || value.profile !== undefined && value.profile !== 'current' && value.profile !== 'diverse'
    || value.scenarioCount !== undefined && !numberIn(value.scenarioCount, 3, 12, true)) return null;
  const environment = value.environment === undefined ? undefined : validateEnvironment(value.environment);
  const populationDynamics = config.populationDynamics === undefined ? undefined : validatePopulationDynamics(config.populationDynamics);
  if (environment === null || populationDynamics === null) return null;
  return {
    config: {
      coverageTarget: config.coverageTarget, revisitSeconds: config.revisitSeconds, fleetSize: config.fleetSize,
      populationCount: config.populationCount, populationSeed: config.populationSeed,
      crowdedRevisitSeconds: config.crowdedRevisitSeconds, crowdedCellPopulation: config.crowdedCellPopulation,
      ...(populationDynamics === undefined ? {} : { populationDynamics }),
    },
    optimizerSeed: value.optimizerSeed, generations: value.generations, budgetSeconds: value.budgetSeconds,
    ...(value.profile === undefined ? {} : { profile: value.profile }),
    ...(value.scenarioCount === undefined ? {} : { scenarioCount: value.scenarioCount as number }),
    ...(environment ? { environment } : {}),
  };
}

function validMetrics(value: unknown, settings: LearningSettings, version: 1 | 2 | 3, populationCount?: number, populationDynamics?: PopulationDynamics): value is EvaluationMetrics {
  if (!record(value)) return false;
  const basePopulation = populationCount ?? settings.config.populationCount;
  const dynamics = populationDynamics ?? settings.config.populationDynamics;
  const cases = populationCount === undefined && Array.isArray(value.scenarioResults) ? value.scenarioResults : undefined;
  const dynamicPopulation = version === 3 && (cases ? cases.some(result => record(result) && record(result.populationDynamics) && result.populationDynamics.enabled === true)
    : dynamics?.enabled ?? (populationCount === undefined && settings.profile === 'diverse'));
  const populationLimit = (count: number, variation: number) => count === 0 ? 0 : Math.min(50000, Math.round(count * (1 + variation)));
  const maximumPopulation = cases && cases.length ? Math.max(...cases.map(result => record(result) && numberIn(result.populationCount, 0, 50000, true)
    ? populationLimit(result.populationCount, record(result.populationDynamics) && result.populationDynamics.enabled === true && numberIn(result.populationDynamics.countVariation, 0, 1) ? result.populationDynamics.countVariation : 0) : 0))
    : basePopulation === 0 ? 0 : populationCount === undefined && settings.profile === 'diverse' ? 50000
      : populationLimit(basePopulation, dynamicPopulation ? dynamics?.countVariation ?? 1 : 0);
  const nullable = (entry: unknown, maximum: number) => entry === null || numberIn(entry, 0, maximum);
  if (!numberIn(value.scenarios, 1, 100, true) || !numberIn(value.durationSeconds, 0.000001, 1000000)
    || !numberIn(value.areaMinimum, 0, 100) || !numberIn(value.areaMean, value.areaMinimum, 100)
    || !numberIn(value.auditAreaMinimum, 0, 100) || !numberIn(value.auditAreaMean, value.auditAreaMinimum, 100)
    || !numberIn(value.areaTargetFraction, 0, 1) || !nullable(value.populationOnTime, 100) || !nullable(value.hotspotOnTime, 100)
    || !nullable(value.meanAgeSeconds, 100000000) || !nullable(value.gapCost, 1e16)
    || !numberIn(value.maxObservationAge, 0, 100000000) || !numberIn(value.neverObservedPeople, 0, maximumPopulation, true)
    || !numberIn(value.distanceMeters, 0, 1e12) || typeof value.geographicFeasible !== 'boolean' || typeof value.hotspotFeasible !== 'boolean') return false;
  if (value.geographicFeasible !== (value.areaMinimum + 1e-8 >= settings.config.coverageTarget && value.auditAreaMinimum + 1e-8 >= settings.config.coverageTarget && value.areaTargetFraction >= 1 - 1e-8)) return false;
  if (value.hotspotFeasible !== (value.hotspotOnTime === null || value.hotspotOnTime >= 100 - 1e-8)) return false;
  const noPopulation = cases ? cases.every(result => record(result) && result.populationCount === 0) : basePopulation === 0;
  if ((value.populationOnTime === null) !== noPopulation || (value.meanAgeSeconds === null) !== noPopulation || (value.gapCost === null) !== noPopulation) return false;
  if (noPopulation && value.hotspotOnTime !== null) return false;
  if (value.feasibleScenarioFraction !== undefined && !numberIn(value.feasibleScenarioFraction, 0, 1)
    || value.worstCaseGapCost !== undefined && !nullable(value.worstCaseGapCost, 1e16)
    || value.energyViolations !== undefined && !numberIn(value.energyViolations, 0, 800, true)
    || value.reserveViolations !== undefined && !numberIn(value.reserveViolations, 0, 1e9, true)
    || value.energyUsed !== undefined && !numberIn(value.energyUsed, 0, 1e9)
    || value.completedCharges !== undefined && !numberIn(value.completedCharges, 0, 1e9, true)) return false;
  if (dynamicPopulation) {
    const minimumPopulation = noPopulation || cases?.some(result => record(result) && result.populationCount === 0) ? 0 : 1;
    if (value.populationWeighting !== 'person-time' || !numberIn(value.populationMinimum, minimumPopulation, maximumPopulation, true)
      || !numberIn(value.populationMaximum, value.populationMinimum, maximumPopulation, true)
      || !numberIn(value.populationUpdates, 0, 1000000, true)) return false;
  } else if (value.populationWeighting !== undefined || value.populationMinimum !== undefined || value.populationMaximum !== undefined || value.populationUpdates !== undefined) return false;
  if (populationCount !== undefined) return value.scenarioResults === undefined;
  if ((settings.profile === 'diverse' || settings.environment?.batteryEnabled || dynamicPopulation) && value.scenarioResults === undefined) return false;
  if (value.scenarioResults === undefined) return true;
  if (!Array.isArray(value.scenarioResults) || value.scenarioResults.length !== value.scenarios || value.scenarioResults.length > 100) return false;
  const ids = new Set<string>();
  const scenarioMetrics: EvaluationMetrics[] = [];
  const scenarioPopulations: number[] = [];
  for (const result of value.scenarioResults) {
    if (!record(result)) return false;
    const scenarioDynamics = result.populationDynamics === undefined ? undefined : validatePopulationDynamics(result.populationDynamics);
    if (scenarioDynamics === null || version < 3 && scenarioDynamics !== undefined
      || version === 3 && (settings.profile === 'diverse' || settings.config.populationDynamics !== undefined) && scenarioDynamics === undefined) return false;
    if (!record(result) || typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(result.id) || ids.has(result.id)
      || typeof result.family !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(result.family)
      || !numberIn(result.populationSeed, 1, 2147483647, true) || !numberIn(result.populationCount, 0, 50000, true)
      || !validateEnvironment(result.environment) || !validMetrics(result.metrics, settings, version, result.populationCount, scenarioDynamics)
      || result.metrics.scenarios !== 1) return false;
    if (!numberIn(result.metrics.energyViolations, 0, 8, true) || !numberIn(result.metrics.reserveViolations, 0, 1e9, true)
      || !numberIn(result.metrics.energyUsed, 0, 1e9) || !numberIn(result.metrics.completedCharges, 0, 1e9, true)) return false;
    ids.add(result.id);
    scenarioMetrics.push(result.metrics);
    scenarioPopulations.push(result.populationCount);
  }
  const sum = (key: 'durationSeconds' | 'energyViolations' | 'reserveViolations' | 'energyUsed' | 'completedCharges') => scenarioMetrics.reduce((total, metrics) => total + (metrics[key] ?? 0), 0);
  const near = (first: unknown, second: number) => typeof first === 'number' && Math.abs(first - second) <= 1e-7 * Math.max(1, Math.abs(second));
  const feasibleCount = scenarioMetrics.filter(metrics => metrics.geographicFeasible && metrics.hotspotFeasible && metrics.neverObservedPeople === 0
    && !(metrics.energyViolations ?? 0) && !(metrics.reserveViolations ?? 0)).length;
  const gapCosts = scenarioMetrics.flatMap(metrics => metrics.gapCost === null ? [] : [metrics.gapCost]);
  if (!near(value.durationSeconds, sum('durationSeconds')) || !near(value.areaMinimum, Math.min(...scenarioMetrics.map(metrics => metrics.areaMinimum)))
    || !near(value.auditAreaMinimum, Math.min(...scenarioMetrics.map(metrics => metrics.auditAreaMinimum)))
    || !near(value.feasibleScenarioFraction, feasibleCount / scenarioMetrics.length)
    || (gapCosts.length ? !near(value.worstCaseGapCost, Math.max(...gapCosts)) : value.worstCaseGapCost !== null)) return false;
  if (dynamicPopulation && (!near(value.populationMinimum, Math.min(...scenarioMetrics.map((metrics, index) => metrics.populationMinimum ?? scenarioPopulations[index])))
    || !near(value.populationMaximum, Math.max(...scenarioMetrics.map((metrics, index) => metrics.populationMaximum ?? scenarioPopulations[index])))
    || !near(value.populationUpdates, scenarioMetrics.reduce((total, metrics) => total + (metrics.populationUpdates ?? 0), 0)))) return false;
  return (['energyViolations', 'reserveViolations', 'energyUsed', 'completedCharges'] as const).every(key => near(value[key], sum(key)));
}

export function createCheckpoint(settings: LearningSettings, progress: LearningProgress): LearningCheckpoint {
  const checkpoint = parseCheckpoint(JSON.stringify({ version: 3, evaluatorVersion: EVALUATOR_VERSION, settings, progress }));
  if (!checkpoint) throw new Error('Cannot save an invalid learning checkpoint.');
  return checkpoint;
}

export function serializeCheckpoint(checkpoint: LearningCheckpoint): string {
  const text = JSON.stringify(checkpoint, null, 2);
  if (!parseCheckpoint(text)) throw new Error('Cannot export an invalid learning checkpoint.');
  return text;
}

export function parseCheckpoint(text: string): LearningCheckpoint | null {
  if (typeof text !== 'string' || text.length > MAX_CHECKPOINT_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value) || !(value.version === 1 && value.evaluatorVersion === LEGACY_EVALUATOR_VERSION
      || value.version === 2 && value.evaluatorVersion === ENERGY_EVALUATOR_VERSION
      || value.version === 3 && value.evaluatorVersion === EVALUATOR_VERSION)) return null;
    const settings = validateLearningSettings(value.settings);
    if (value.version === 1 && settings && (settings.profile !== undefined || settings.environment !== undefined || settings.scenarioCount !== undefined)) return null;
    if (value.version < 3 && settings?.config.populationDynamics !== undefined) return null;
    if (!settings || !record(value.progress)) return null;
    const progress = value.progress;
    if (typeof progress.status !== 'string' || !['idle', 'running', 'paused', 'completed', 'cancelled', 'error'].includes(progress.status)
      || !numberIn(progress.generation, 0, settings.generations, true) || !numberIn(progress.evaluations, 0, 10000, true)
      || !numberIn(progress.elapsedSeconds, 0, 3600) || typeof progress.message !== 'string' || progress.message.length > 1000
      || !Array.isArray(progress.testedFleetSizes) || progress.testedFleetSizes.length > 8
      || progress.testedFleetSizes.some(fleet => !numberIn(fleet, 1, 8, true)) || new Set(progress.testedFleetSizes).size !== progress.testedFleetSizes.length
      || !Array.isArray(progress.candidates) || progress.candidates.length > 32 || !Array.isArray(progress.frontierIds)) return null;
    const ids = new Set<string>();
    for (const candidate of progress.candidates) {
      if (!record(candidate) || typeof candidate.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(candidate.id) || ids.has(candidate.id)
        || !numberIn(candidate.fleetSize, 1, 8, true) || !progress.testedFleetSizes.includes(candidate.fleetSize)
        || !validateStrategy(candidate.strategy) || !validMetrics(candidate.training, settings, value.version)
        || (candidate.validation !== null && !validMetrics(candidate.validation, settings, value.version)) || (candidate.failure !== null && !validMetrics(candidate.failure, settings, value.version))) return null;
      ids.add(candidate.id);
    }
    if (progress.frontierIds.length > 32 || new Set(progress.frontierIds).size !== progress.frontierIds.length || progress.frontierIds.some(id => typeof id !== 'string' || !ids.has(id))) return null;
    if (progress.recommendedId !== null) {
      if (typeof progress.recommendedId !== 'string' || !ids.has(progress.recommendedId)) return null;
      const recommended = progress.candidates.find(candidate => candidate.id === progress.recommendedId);
      if (!recommended?.validation?.geographicFeasible || !recommended.validation.hotspotFeasible || recommended.validation.neverObservedPeople !== 0
        || (recommended.validation.energyViolations ?? 0) !== 0 || (recommended.validation.reserveViolations ?? 0) !== 0
        || (recommended.validation.feasibleScenarioFraction ?? 1) < 1 - 1e-8) return null;
    }
    return { version: value.version, evaluatorVersion: value.evaluatorVersion, settings, progress } as unknown as LearningCheckpoint;
  } catch {
    return null;
  }
}
