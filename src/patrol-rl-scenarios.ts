import { DEFAULT_ENVIRONMENT, validateEnvironment } from './patrol-environment';
import type { PatrolEnvironment } from './patrol-environment';
import type { PatrolConfig, PatrolFault } from './patrol-types';
import { POPULATION_DEFAULTS, POPULATION_LIMITS } from './population';

export type RLScenarioSplit = 'train' | 'validation' | 'final';
export type RLPopulationFamily = 'persistent' | 'moving' | 'surge' | 'diffuse';

export interface RLScenario {
  id: string;
  split: RLScenarioSplit;
  family: RLPopulationFamily;
  seed: number;
  config: PatrolConfig;
  environment: PatrolEnvironment;
  warmupSeconds: number;
  durationSeconds: number;
  fault?: { atSeconds: number; droneId?: number; kind: PatrolFault };
}

interface Position {
  x: number;
  z: number;
}

const SEED_PARTITION_SIZE = 715827882;
const SPLIT_INDEX = { train: 0, validation: 1, final: 2 } as const;
const POPULATION_FAMILIES: readonly RLPopulationFamily[] = ['persistent', 'moving', 'surge', 'diffuse'];

function mixSeed(seed: number): number {
  let mixed = Math.imul(seed ^ seed >>> 16, 0x85ebca6b);
  mixed = Math.imul(mixed ^ mixed >>> 13, 0xc2b2ae35);
  return (mixed ^ mixed >>> 16) >>> 0;
}

function randomGenerator(seed: number): () => number {
  let state = mixSeed(seed);
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 4294967296;
  };
}

export function createRLScenarios(split: RLScenarioSplit, seed: number, count: number): RLScenario[] {
  if (!Object.hasOwn(SPLIT_INDEX, split)) throw new Error('Invalid RL scenario split.');
  if (!Number.isInteger(seed) || seed < 1 || seed > POPULATION_LIMITS.maxSeed) throw new Error('Invalid RL scenario seed.');
  if (!Number.isInteger(count) || count < 1 || count > 4096) throw new Error('RL suites require 1–4096 scenarios.');
  return Array.from({ length: count }, (_entry, index) => {
    const scenarioSeed = SPLIT_INDEX[split] * SEED_PARTITION_SIZE + 1 + (mixSeed(seed) + index * 104729) % SEED_PARTITION_SIZE;
    const random = randomGenerator(scenarioSeed);
    const pick = (minimum: number, maximum: number) => Math.round(minimum + random() * (maximum - minimum));
    const family = POPULATION_FAMILIES[index % POPULATION_FAMILIES.length];
    const corridor = split === 'validation' ? index % 2 === 1 : split === 'final' && index % 3 === 2;
    const geometry = corridor ? 'corridor' : index % 3 === 0 ? 'circle' : 'district';
    const final = split === 'final';
    const width = geometry === 'corridor' ? pick(440, 640) : final ? pick(480, 640) : pick(240, 480);
    const depth = geometry === 'circle' ? width : geometry === 'corridor' ? pick(120, 180) : final ? pick(320, 480) : pick(200, 400);
    const environment: PatrolEnvironment = {
      ...DEFAULT_ENVIRONMENT,
      id: `rl-${split}-${geometry}-${index + 1}`,
      shape: geometry === 'circle' ? 'circle' : 'rectangle',
      width,
      depth,
      maxSpeed: final ? pick(10, 20) : pick(12, 28),
      sensorRadius: final ? pick(16, 28) : pick(24, 48),
      batteryEnabled: true,
      enduranceSeconds: final ? pick(120, 220) : split === 'validation' ? pick(220, 380) : pick(240, 420),
      rechargeSeconds: final ? pick(150, 240) : split === 'validation' ? pick(90, 180) : pick(60, 150),
      reserveFraction: pick(final ? 25 : 15, final ? 35 : 25) / 100,
      chargingPads: pick(1, final || split === 'validation' ? 2 : 3),
      initialChargeFraction: pick(final ? 50 : 65, 100) / 100,
      depot: { x: Math.round((random() - 0.5) * width * 0.65), z: Math.round((random() - 0.5) * depth * 0.65) },
    };
    if (!validateEnvironment(environment)) throw new Error('Generated an invalid RL environment.');
    const warmupSeconds = 120;
    return {
      id: `${environment.id}-${family}-${scenarioSeed}`,
      split,
      family,
      seed: scenarioSeed,
      config: {
        ...POPULATION_DEFAULTS,
        coverageTarget: 95,
        revisitSeconds: 120,
        fleetSize: 1,
        populationCount: pick(4000, 12000),
        populationSeed: scenarioSeed,
      },
      environment,
      warmupSeconds,
      durationSeconds: 3 * (environment.enduranceSeconds + environment.rechargeSeconds),
      ...(index % 3 === 2 ? { fault: {
        atSeconds: warmupSeconds + Math.round(environment.enduranceSeconds * 0.65),
        kind: Math.floor(index / 3) % 2 === 0 ? 'malfunction' as const : 'deviation' as const,
      } } : {}),
    };
  });
}

function reflect(value: number, limit: number): number {
  const wrapped = ((value + limit) % (4 * limit) + 4 * limit) % (4 * limit);
  return limit - Math.abs(wrapped - 2 * limit);
}

function hotspotPosition(environment: PatrolEnvironment, random: () => number, time: number, moving: boolean): Position {
  const phase = random() * 2 * Math.PI;
  const radius = 0.18 + 0.6 * Math.sqrt(random());
  const angularSpeed = (0.0015 + random() * 0.0035) * (random() < 0.5 ? -1 : 1);
  const angle = phase + (moving ? angularSpeed * time : 0);
  if (environment.shape === 'circle') return {
    x: Math.cos(angle) * radius * environment.width / 2,
    z: Math.sin(angle) * radius * environment.depth / 2,
  };
  const horizontal = (random() - 0.5) * environment.width * 0.76;
  const depth = (random() - 0.5) * environment.depth * 0.76;
  const speed = 0.3 + random() * 0.6;
  return {
    x: reflect(horizontal + (moving ? Math.cos(phase) * speed * time : 0), environment.width * 0.4),
    z: reflect(depth + (moving ? Math.sin(phase) * speed * time : 0), environment.depth * 0.4),
  };
}

export function populationForScenario(scenario: RLScenario, positions: readonly Position[], time: number): number[] {
  if (!Number.isFinite(time) || time < 0) throw new Error('RL population time must be finite and nonnegative.');
  if (!positions.length) return [];
  if (positions.some(position => !Number.isFinite(position.x) || !Number.isFinite(position.z))) throw new Error('Invalid population position.');
  const baseline = Number.isFinite(scenario.config.populationCount) ? Math.max(0, Math.min(POPULATION_LIMITS.maxPopulation, Math.round(scenario.config.populationCount))) : 0;
  if (!baseline) return positions.map(() => 0);
  const random = randomGenerator(scenario.seed);
  const interval = 30 + Math.floor(random() * 61);
  const epoch = Math.floor(time / interval);
  const countRandom = randomGenerator(scenario.seed ^ Math.imul(epoch + 1, 0x9e3779b9));
  const total = Math.max(1, Math.min(POPULATION_LIMITS.maxPopulation, Math.round(baseline * (0.65 + 0.7 * countRandom()))));
  const hotspotCount = 2 + Math.floor(random() * 3);
  const stage = scenario.family === 'surge' ? Math.floor(time / (90 + scenario.seed % 61)) : 0;
  const hotspotRandom = randomGenerator(scenario.seed ^ Math.imul(stage + 1, 0x7f4a7c15));
  const span = Math.min(scenario.environment.width, scenario.environment.depth);
  const hotspots = Array.from({ length: hotspotCount }, () => {
    const position = hotspotPosition(scenario.environment, hotspotRandom, time, scenario.family === 'moving');
    const spread = scenario.family === 'diffuse' ? span * (0.25 + hotspotRandom() * 0.2) : Math.max(18, span * (0.055 + hotspotRandom() * 0.025));
    const phase = hotspotRandom() * 2 * Math.PI;
    const period = 90 + hotspotRandom() * 150;
    return { position, spread, strength: (0.9 + hotspotRandom() * 0.6) * (1 + 0.3 * Math.sin(phase + time * 2 * Math.PI / period)) };
  });
  const weights = positions.map(position => (scenario.family === 'diffuse' ? 0.25 : 0.002) + hotspots.reduce((weight, hotspot) => {
    const squaredDistance = (position.x - hotspot.position.x) ** 2 + (position.z - hotspot.position.z) ** 2;
    return weight + hotspot.strength * Math.exp(-squaredDistance / (2 * hotspot.spread ** 2));
  }, 0));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const allocations = weights.map(weight => weight / weightTotal * total);
  const counts = allocations.map(Math.floor);
  const remaining = total - counts.reduce((sum, count) => sum + count, 0);
  const remainderOrder = allocations.map((allocation, index) => ({ index, remainder: allocation - counts[index] }))
    .sort((first, second) => second.remainder - first.remainder
      || positions[first.index].x - positions[second.index].x || positions[first.index].z - positions[second.index].z || first.index - second.index);
  for (let index = 0; index < remaining; index += 1) counts[remainderOrder[index].index] += 1;
  return counts;
}

export function populationDeadlineForScenario(scenario: RLScenario, population: number): number {
  const revisitSeconds = Math.max(1, Math.min(3600, scenario.config.revisitSeconds));
  const crowdedSeconds = Math.min(revisitSeconds, Math.max(POPULATION_LIMITS.minCrowdedRevisitSeconds, Math.min(POPULATION_LIMITS.maxCrowdedSeconds, scenario.config.crowdedRevisitSeconds)));
  const crowdedPopulation = Math.round(Math.max(POPULATION_LIMITS.minCrowdedCellPopulation, Math.min(POPULATION_LIMITS.maxCrowdedCellPopulation, scenario.config.crowdedCellPopulation)));
  return revisitSeconds + (crowdedSeconds - revisitSeconds) * Math.min(1, Math.max(0, population) / crowdedPopulation);
}
