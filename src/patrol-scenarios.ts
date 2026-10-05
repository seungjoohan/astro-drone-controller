import { DEFAULT_ENVIRONMENT, validateEnvironment } from './patrol-environment';
import type { PatrolEnvironment } from './patrol-environment';
import type { LearningSettings } from './patrol-learning-types';
import type { PatrolConfig, PatrolFault } from './patrol-types';

export const PILOT_PROTOCOL = Object.freeze({ warmupSeconds: 120, trainingSeconds: 240, validationSeconds: 360, stepSeconds: 0.5 });
export type ScenarioKind = 'training' | 'validation' | 'failure' | 'final';

export interface EvaluationScenario {
  id?: string;
  family?: string;
  populationSeed: number;
  populationCount?: number;
  environment?: PatrolEnvironment;
  warmupSeconds: number;
  evaluationSeconds: number;
  fault?: { droneId: number; kind: PatrolFault; timeSeconds: number };
}

export function scenarioSeeds(populationSeed: number): { training: number[]; validation: number[]; failure: number[] } {
  const seeds = [104729, 130363, 155921, 181081, 206369].map(offset => (populationSeed - 1 + offset) % 2147483647 + 1);
  return { training: seeds.slice(0, 2), validation: seeds.slice(2, 4), failure: seeds.slice(4) };
}

function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 4294967296;
  };
}

function diverseScenario(config: PatrolConfig, kind: ScenarioKind, index: number, populationSeed: number): EvaluationScenario {
  const random = randomGenerator(populationSeed);
  const pick = (minimum: number, maximum: number) => Math.round(minimum + random() * (maximum - minimum));
  const family = kind === 'training' ? index % 3 < 2 ? 'compact-circle' : 'district' : 'corridor';
  const width = family === 'compact-circle' ? pick(240, 360) : family === 'district' ? pick(360, 520) : pick(440, 620);
  const depth = family === 'compact-circle' ? width : family === 'district' ? pick(240, 360) : pick(120, 200);
  const environment: PatrolEnvironment = {
    ...DEFAULT_ENVIRONMENT,
    id: `${kind}-${family}-${index + 1}`,
    shape: family === 'compact-circle' ? 'circle' : 'rectangle',
    width, depth, maxSpeed: pick(12, 26), sensorRadius: pick(24, 48), batteryEnabled: true,
    enduranceSeconds: pick(240, 420), rechargeSeconds: pick(60, 150),
    chargingPads: pick(1, 3), reserveFraction: pick(15, 25) / 100,
    initialChargeFraction: pick(65, 100) / 100,
    depot: { x: Math.round((random() - 0.5) * width * 0.5), z: Math.round((random() - 0.5) * depth * 0.5) },
  };
  const warmupSeconds = Math.min(3600, Math.max(PILOT_PROTOCOL.warmupSeconds, config.revisitSeconds));
  return {
    id: environment.id,
    family,
    populationSeed,
    populationCount: config.populationCount === 0 ? 0 : Math.max(1, Math.min(50000, Math.round(config.populationCount * (0.35 + random() * 1.1)))),
    environment,
    warmupSeconds,
    evaluationSeconds: 3 * (environment.enduranceSeconds + environment.rechargeSeconds),
    ...(kind === 'failure' ? { fault: {
      droneId: populationSeed % config.fleetSize + 1,
      kind: 'malfunction' as const,
      timeSeconds: warmupSeconds + environment.enduranceSeconds,
    } } : {}),
  };
}

export function createScenarios(config: PatrolConfig, kind: ScenarioKind, options: Pick<LearningSettings, 'profile' | 'environment' | 'scenarioCount'> = {}): EvaluationScenario[] {
  if (options.profile === 'diverse') {
    const count = options.scenarioCount ?? 6;
    if (!Number.isInteger(count) || count < 3 || count > 12) throw new Error('Diverse training requires 3–12 scenarios.');
    const offsets = {
      training: [104729, 130363, 151121, ...Array.from({ length: count - 3 }, (_value, index) => 310001 + index * 30011)],
      validation: [181081, 206369, ...Array.from({ length: Math.ceil(count / 2) - 2 }, (_value, index) => 610001 + index * 50021)],
      failure: [234457], final: [268501, 294001],
    }[kind];
    return offsets.map((offset, index) => diverseScenario(config, kind, index, (config.populationSeed - 1 + offset) % 2147483647 + 1));
  }
  const environment = options.environment === undefined ? undefined : validateEnvironment(options.environment);
  if (environment === null) throw new Error('Invalid evaluation environment.');
  const seeds = kind === 'final' ? [268501, 294001].map(offset => (config.populationSeed - 1 + offset) % 2147483647 + 1) : scenarioSeeds(config.populationSeed)[kind];
  return seeds.map(populationSeed => ({
    populationSeed,
    ...(environment ? { environment } : {}),
    warmupSeconds: PILOT_PROTOCOL.warmupSeconds,
    evaluationSeconds: environment?.batteryEnabled ? 3 * (environment.enduranceSeconds + environment.rechargeSeconds)
      : kind === 'training' ? PILOT_PROTOCOL.trainingSeconds : PILOT_PROTOCOL.validationSeconds,
    ...(kind === 'failure' ? { fault: {
      droneId: populationSeed % config.fleetSize + 1,
      kind: environment?.batteryEnabled ? 'malfunction' as const : populationSeed % 2 ? 'malfunction' as const : 'deviation' as const,
      timeSeconds: PILOT_PROTOCOL.warmupSeconds + 45 + populationSeed % 46,
    } } : {}),
  }));
}
