import type { PatrolCell, PatrolConfig, PatrolDrone, PopulationDynamics, PopulationMetrics } from './patrol-types';

export const DEFAULT_POPULATION_DYNAMICS: Readonly<PopulationDynamics> = Object.freeze({
  enabled: false,
  intervalSeconds: 30,
  redistributionFraction: 0.35,
  countVariation: 0.25,
});

export function validatePopulationDynamics(value: unknown): PopulationDynamics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).length !== 4 || typeof settings.enabled !== 'boolean'
    || typeof settings.intervalSeconds !== 'number' || !Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 5 || settings.intervalSeconds > 600
    || typeof settings.redistributionFraction !== 'number' || !Number.isFinite(settings.redistributionFraction) || settings.redistributionFraction < 0.05 || settings.redistributionFraction > 1
    || typeof settings.countVariation !== 'number' || !Number.isFinite(settings.countVariation) || settings.countVariation < 0 || settings.countVariation > 1) return null;
  return { enabled: settings.enabled, intervalSeconds: settings.intervalSeconds, redistributionFraction: settings.redistributionFraction, countVariation: settings.countVariation };
}

export const POPULATION_DEFAULTS = Object.freeze({
  populationCount: 5000,
  populationSeed: 42,
  crowdedRevisitSeconds: 15,
  crowdedCellPopulation: 80,
});

export const POPULATION_LIMITS = Object.freeze({
  maxPopulation: 50000,
  maxSeed: 2147483647,
  minCrowdedRevisitSeconds: 1,
  maxCrowdedSeconds: 300,
  minCrowdedCellPopulation: 1,
  maxCrowdedCellPopulation: 1000,
});

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 4294967296;
  };
}

function assignPopulation(cells: PatrolCell[], weights: number[], totalPeople: number, config: PatrolConfig, random?: () => number): void {
  const revisitSeconds = bounded(config.revisitSeconds, 120, 1, 3600);
  const crowdedSeconds = Math.min(revisitSeconds, bounded(config.crowdedRevisitSeconds, POPULATION_DEFAULTS.crowdedRevisitSeconds, POPULATION_LIMITS.minCrowdedRevisitSeconds, POPULATION_LIMITS.maxCrowdedSeconds));
  const crowdedPopulation = Math.round(bounded(config.crowdedCellPopulation, POPULATION_DEFAULTS.crowdedCellPopulation, POPULATION_LIMITS.minCrowdedCellPopulation, POPULATION_LIMITS.maxCrowdedCellPopulation));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const allocations = weights.map(weight => totalPeople * weight / totalWeight);
  const counts = allocations.map(Math.floor);
  let remaining = totalPeople - counts.reduce((sum, count) => sum + count, 0);
  if (random && remaining > 0) {
    let threshold = random();
    let cumulative = 0;
    for (let index = 0; index < allocations.length; index += 1) {
      cumulative += allocations[index] - counts[index];
      if (remaining > 0 && threshold < cumulative) {
        counts[index] += 1;
        remaining -= 1;
        threshold += 1;
      }
    }
  }
  const remainderOrder = allocations.map((allocation, index) => ({ index, remainder: allocation - counts[index] }))
    .sort((first, second) => second.remainder - first.remainder || first.index - second.index);
  for (let index = 0; index < remaining; index += 1) counts[remainderOrder[index].index] += 1;
  cells.forEach((cell, index) => {
    cell.population = counts[index];
    cell.targetRevisitSeconds = revisitSeconds + (crowdedSeconds - revisitSeconds) * Math.min(1, cell.population / crowdedPopulation);
  });
}

export function populateCells(cells: PatrolCell[], config: PatrolConfig): void {
  if (!cells.length) return;
  const totalPeople = Math.round(bounded(config.populationCount, POPULATION_DEFAULTS.populationCount, 0, POPULATION_LIMITS.maxPopulation));
  const seed = Math.round(bounded(config.populationSeed, POPULATION_DEFAULTS.populationSeed, 1, POPULATION_LIMITS.maxSeed));
  const random = randomGenerator(seed);
  const horizontal = cells.map(cell => cell.position.x);
  const depth = cells.map(cell => cell.position.z);
  const span = Math.max(40, Math.max(...horizontal) - Math.min(...horizontal), Math.max(...depth) - Math.min(...depth));
  const hotspots = Array.from({ length: 3 + Math.floor(random() * 4) }, () => ({
    position: cells[Math.floor(random() * cells.length)].position,
    spread: span * (0.065 + random() * 0.085),
    strength: 0.5 + random(),
  }));
  const weights = cells.map(cell => 0.025 + hotspots.reduce((weight, hotspot) => {
    const squaredDistance = (cell.position.x - hotspot.position.x) ** 2 + (cell.position.z - hotspot.position.z) ** 2;
    return weight + hotspot.strength * Math.exp(-squaredDistance / (2 * hotspot.spread ** 2));
  }, 0));
  assignPopulation(cells, weights, totalPeople, config);
}

export function updatePopulation(cells: PatrolCell[], config: PatrolConfig, epoch: number): void {
  const dynamics = config.populationDynamics;
  if (!dynamics?.enabled || !cells.length) return;
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Population update epoch must be a positive integer.');
  let epochSeed = config.populationSeed ^ Math.imul(epoch, 0x9e3779b9);
  epochSeed = Math.imul(epochSeed ^ epochSeed >>> 16, 0x85ebca6b);
  epochSeed = Math.imul(epochSeed ^ epochSeed >>> 13, 0xc2b2ae35);
  const random = randomGenerator((epochSeed ^ epochSeed >>> 16) >>> 0);
  const basePopulation = Math.round(bounded(config.populationCount, POPULATION_DEFAULTS.populationCount, 0, POPULATION_LIMITS.maxPopulation));
  const totalPeople = basePopulation === 0 ? 0 : Math.max(1, Math.min(POPULATION_LIMITS.maxPopulation,
    Math.round(basePopulation * (1 + dynamics.countVariation * (2 * random() - 1)))));
  const populationSeed = 1 + Math.floor(random() * POPULATION_LIMITS.maxSeed);
  const targets = cells.map(cell => ({ ...cell }));
  populateCells(targets, { ...config, populationCount: totalPeople, populationSeed });
  const currentTotal = cells.reduce((total, cell) => total + cell.population, 0);
  const weights = cells.map((cell, index) =>
    (1 - dynamics.redistributionFraction) * (currentTotal ? cell.population / currentTotal : 1 / cells.length)
      + dynamics.redistributionFraction * (totalPeople ? targets[index].population / totalPeople : 1 / cells.length));
  assignPopulation(cells, weights, totalPeople, config, random);
}

export function evaluatePopulation(cells: PatrolCell[], time: number, config: PatrolConfig, drones: PatrolDrone[], sensorRadius: number): PopulationMetrics {
  const metrics: PopulationMetrics = {
    totalPeople: 0,
    onTimePeople: 0,
    onTimeCoverage: null,
    inViewPeople: 0,
    inViewCoverage: null,
    unseenPeople: 0,
    meanAgeSeconds: null,
    normalizedGapCost: null,
    hotspotCells: 0,
    hotspotOnTimeCells: 0,
  };
  const missionTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  const crowdedPopulation = Math.round(bounded(config.crowdedCellPopulation, POPULATION_DEFAULTS.crowdedCellPopulation, POPULATION_LIMITS.minCrowdedCellPopulation, POPULATION_LIMITS.maxCrowdedCellPopulation));
  const active = drones.filter(drone => drone.status === 'patrolling' && drone.fault === null && (!drone.serviceState || drone.serviceState === 'patrol'));
  const radius = Number.isFinite(sensorRadius) ? Math.max(0, sensorRadius) : 0;
  let weightedAge = 0;
  let weightedGap = 0;
  for (const cell of cells) {
    const people = Math.round(bounded(cell.population, 0, 0, POPULATION_LIMITS.maxPopulation));
    if (!people) continue;
    const target = bounded(cell.targetRevisitSeconds, 120, 1, 3600);
    const observed = cell.lastVisited !== null && Number.isFinite(cell.lastVisited);
    const age = observed ? Math.max(0, missionTime - cell.lastVisited!) : missionTime + target;
    const onTime = observed && age <= target + 1e-8;
    const inView = active.some(drone => Math.hypot(cell.position.x - drone.position.x, cell.position.z - drone.position.z) <= radius + 1e-8);
    metrics.totalPeople += people;
    if (onTime) metrics.onTimePeople += people;
    if (inView) metrics.inViewPeople += people;
    if (!observed) metrics.unseenPeople += people;
    if (people >= crowdedPopulation) {
      metrics.hotspotCells += 1;
      if (onTime) metrics.hotspotOnTimeCells += 1;
    }
    weightedAge += people * age;
    weightedGap += people * (age / target) ** 2;
  }
  if (metrics.totalPeople) {
    metrics.onTimeCoverage = 100 * metrics.onTimePeople / metrics.totalPeople;
    metrics.inViewCoverage = 100 * metrics.inViewPeople / metrics.totalPeople;
    metrics.meanAgeSeconds = weightedAge / metrics.totalPeople;
    metrics.normalizedGapCost = weightedGap / metrics.totalPeople;
  }
  return metrics;
}
