import type { PatrolConfig, PopulationDynamics } from './patrol-types';
import type { PatrolEnvironment } from './patrol-environment';

export interface PolicyParameters {
  populationWeight: number;
  coverageWeight: number;
  ageExponent: number;
  travelPenalty: number;
  commitmentSeconds: number;
  speedFraction?: number;
}

export type PatrolStrategy = { kind: 'uniform' } | { kind: 'adaptive'; parameters: PolicyParameters };

export interface LearningSettings {
  config: PatrolConfig;
  optimizerSeed: number;
  generations: number;
  budgetSeconds: number;
  profile?: 'current' | 'diverse';
  environment?: PatrolEnvironment;
  scenarioCount?: number;
}

export interface ScenarioEvaluationResult {
  id: string;
  family: string;
  populationSeed: number;
  populationCount: number;
  populationDynamics?: PopulationDynamics;
  environment: PatrolEnvironment;
  metrics: Omit<EvaluationMetrics, 'scenarioResults'>;
}

export interface EvaluationMetrics {
  scenarios: number;
  durationSeconds: number;
  areaMinimum: number;
  areaMean: number;
  auditAreaMinimum: number;
  auditAreaMean: number;
  areaTargetFraction: number;
  populationOnTime: number | null;
  hotspotOnTime: number | null;
  meanAgeSeconds: number | null;
  gapCost: number | null;
  maxObservationAge: number;
  neverObservedPeople: number;
  distanceMeters: number;
  geographicFeasible: boolean;
  hotspotFeasible: boolean;
  scenarioResults?: ScenarioEvaluationResult[];
  feasibleScenarioFraction?: number;
  worstCaseGapCost?: number | null;
  energyViolations?: number;
  reserveViolations?: number;
  energyUsed?: number;
  completedCharges?: number;
  populationWeighting?: 'person-time';
  populationMinimum?: number;
  populationMaximum?: number;
  populationUpdates?: number;
}

export interface LearningCandidate {
  id: string;
  fleetSize: number;
  strategy: PatrolStrategy;
  training: EvaluationMetrics;
  validation: EvaluationMetrics | null;
  failure: EvaluationMetrics | null;
}

export type LearningStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'error';

export interface LearningProgress {
  status: LearningStatus;
  generation: number;
  evaluations: number;
  elapsedSeconds: number;
  testedFleetSizes: number[];
  candidates: LearningCandidate[];
  frontierIds: string[];
  recommendedId: string | null;
  message: string;
}

export interface LearningCheckpoint {
  version: 1 | 2 | 3;
  evaluatorVersion: string;
  settings: LearningSettings;
  progress: LearningProgress;
}

export type LearningRequest =
  | { type: 'start'; settings: LearningSettings }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' };

export type LearningResponse =
  | { type: 'progress'; progress: LearningProgress }
  | { type: 'checkpoint'; checkpoint: LearningCheckpoint }
  | { type: 'error'; message: string };
