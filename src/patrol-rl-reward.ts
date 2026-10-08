import { RL_CONTROL_SECONDS } from './patrol-rl-contract';
import type { PatrolSnapshot } from './patrol-types';

export type RLRewardProfile = 'legacy-v1' | 'coverage-v2';
export const DEFAULT_RL_REWARD_PROFILE: RLRewardProfile = 'coverage-v2';

export interface RLRewardMetadata {
  format: 'astro-patrol-rl-reward';
  version: 1;
  profile: RLRewardProfile;
  auditSpacingMeters: 10;
  populationUrgency: 'unbounded-overdue-quadratic' | 'bounded-relative-age';
  populationNormalization: 'configured-population' | 'current-population';
  geographicDeficit: 'squared-absolute' | 'linear-target-relative';
  overlap: 'none' | 'excess-active-audit-footprints';
  weights: {
    geographicAge: number;
    geographicUncovered: number;
    geographicDeficit: number;
    populationRevisit: number;
    unobservedPeople: number;
    overlap: number;
    fleet: number;
    reserve: number;
    stranded: number;
    forcedReturn: number;
  };
}

export interface RLRewardAuditMetrics {
  coverage: number;
  meanAgeCost: number;
  overlapFraction: number;
}

export interface RLRewardComponents {
  geographicAge: number;
  geographicUncovered: number;
  geographicDeficit: number;
  populationRevisit: number;
  unobservedPeople: number;
  overlap: number;
  fleet: number;
  reserve: number;
  stranded: number;
  forcedReturn: number;
}

const PROFILES: Record<RLRewardProfile, RLRewardMetadata> = {
  'legacy-v1': {
    format: 'astro-patrol-rl-reward', version: 1, profile: 'legacy-v1', auditSpacingMeters: 10,
    populationUrgency: 'unbounded-overdue-quadratic', populationNormalization: 'configured-population',
    geographicDeficit: 'squared-absolute', overlap: 'none',
    weights: { geographicAge: 0, geographicUncovered: 1, geographicDeficit: 10, populationRevisit: 1,
      unobservedPeople: 1, overlap: 0, fleet: 0.02, reserve: 20, stranded: 50, forcedReturn: 1 },
  },
  'coverage-v2': {
    format: 'astro-patrol-rl-reward', version: 1, profile: 'coverage-v2', auditSpacingMeters: 10,
    populationUrgency: 'bounded-relative-age', populationNormalization: 'current-population',
    geographicDeficit: 'linear-target-relative', overlap: 'excess-active-audit-footprints',
    weights: { geographicAge: 4, geographicUncovered: 4, geographicDeficit: 8, populationRevisit: 2,
      unobservedPeople: 1, overlap: 0.25, fleet: 0.02, reserve: 20, stranded: 50, forcedReturn: 1 },
  },
};

function specification(profile: RLRewardProfile): RLRewardMetadata {
  if (profile !== 'legacy-v1' && profile !== 'coverage-v2') throw new Error('Invalid RL reward profile');
  return PROFILES[profile];
}

export function rewardMetadata(profile: RLRewardProfile): RLRewardMetadata {
  return structuredClone(specification(profile));
}

function matches(value: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return value === expected;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const wanted = expected as Record<string, unknown>;
  return Object.keys(actual).length === Object.keys(wanted).length
    && Object.entries(wanted).every(([key, entry]) => Object.hasOwn(actual, key) && matches(actual[key], entry));
}

export function validateRewardMetadata(value: unknown): RLRewardProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RL reward metadata');
  const profile = (value as Record<string, unknown>).profile;
  if (profile !== 'legacy-v1' && profile !== 'coverage-v2' || !matches(value, PROFILES[profile])) {
    throw new Error('Invalid RL reward metadata');
  }
  return profile;
}

export function emptyRewardComponents(): RLRewardComponents {
  return { geographicAge: 0, geographicUncovered: 0, geographicDeficit: 0, populationRevisit: 0,
    unobservedPeople: 0, overlap: 0, fleet: 0, reserve: 0, stranded: 0, forcedReturn: 0 };
}

export function calculatePatrolReward(snapshot: PatrolSnapshot, audit: RLRewardAuditMetrics, previous: PatrolSnapshot,
  profile: RLRewardProfile = DEFAULT_RL_REWARD_PROFILE): { reward: number; components: RLRewardComponents } {
  const { weights } = specification(profile);
  const legacy = profile === 'legacy-v1';
  const seconds = snapshot.time - previous.time;
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(audit.coverage) || audit.coverage < 0 || audit.coverage > 100
    || !legacy && [audit.meanAgeCost, audit.overlapFraction].some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('Invalid RL reward audit or elapsed time');
  }
  const baselinePopulation = Math.max(1, legacy ? snapshot.config.populationCount : snapshot.population.totalPeople);
  let populationCost = 0;
  for (const cell of snapshot.cells) {
    const age = cell.lastVisited === null ? snapshot.time + cell.targetRevisitSeconds : Math.max(0, snapshot.time - cell.lastVisited);
    const relativeAge = age / cell.targetRevisitSeconds;
    const urgency = legacy ? relativeAge + Math.max(0, relativeAge - 1) ** 2
      : cell.lastVisited === null ? 1 : age / (age + cell.targetRevisitSeconds);
    populationCost += cell.population / baselinePopulation * urgency;
  }
  const unobservedCost = (snapshot.population.totalPeople - snapshot.population.inViewPeople) / baselinePopulation;
  const geographicDeficit = Math.max(0, (snapshot.config.coverageTarget - audit.coverage) / 100);
  const deficitCost = legacy ? geographicDeficit ** 2 : geographicDeficit / Math.max(snapshot.config.coverageTarget / 100, 1e-6);
  const ageCost = legacy ? 0 : audit.meanAgeCost;
  const overlapCost = legacy ? 0 : audit.overlapFraction;
  const geographyCost = legacy ? 1 - audit.coverage / 100 + 10 * geographicDeficit ** 2
    : weights.geographicAge * ageCost + weights.geographicUncovered * (1 - audit.coverage / 100) + weights.geographicDeficit * deficitCost;
  const reserveViolations = snapshot.energy.reserveViolations - previous.energy.reserveViolations;
  const stranded = snapshot.energy.strandedDrones - previous.energy.strandedDrones;
  const forcedReturns = (snapshot.externalControl?.forcedReturns ?? 0) - (previous.externalControl?.forcedReturns ?? 0);
  const factor = seconds / RL_CONTROL_SECONDS;
  const components: RLRewardComponents = {
    geographicAge: -weights.geographicAge * ageCost * factor,
    geographicUncovered: -weights.geographicUncovered * (1 - audit.coverage / 100) * factor,
    geographicDeficit: -weights.geographicDeficit * deficitCost * factor,
    populationRevisit: -weights.populationRevisit * populationCost * factor,
    unobservedPeople: -weights.unobservedPeople * unobservedCost * factor,
    overlap: -weights.overlap * overlapCost * factor,
    fleet: -weights.fleet * snapshot.drones.length * factor,
    reserve: -weights.reserve * reserveViolations,
    stranded: -weights.stranded * stranded,
    forcedReturn: -weights.forcedReturn * forcedReturns,
  };
  const reward = legacy
    ? -(populationCost + unobservedCost + geographyCost + 0.02 * snapshot.drones.length) * seconds / RL_CONTROL_SECONDS
      - 20 * reserveViolations - 50 * stranded - forcedReturns
    : -(weights.populationRevisit * populationCost + weights.unobservedPeople * unobservedCost + geographyCost
      + weights.overlap * overlapCost + weights.fleet * snapshot.drones.length) * factor
      - weights.reserve * reserveViolations - weights.stranded * stranded - weights.forcedReturn * forcedReturns;
  if (!Number.isFinite(reward) || Object.values(components).some(value => !Number.isFinite(value))) throw new Error('Non-finite RL reward');
  return { reward, components };
}

export function patrolReward(snapshot: PatrolSnapshot, auditCoverage: number, previous: PatrolSnapshot): number {
  return calculatePatrolReward(snapshot, { coverage: auditCoverage, meanAgeCost: 0, overlapFraction: 0 }, previous, 'legacy-v1').reward;
}
