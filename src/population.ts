import type { PatrolCell, PatrolConfig, PatrolDrone, PopulationMetrics } from './patrol-types';

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

export function populateCells(cells: PatrolCell[], config: PatrolConfig): void {
  if (!cells.length) return;
  const totalPeople = Math.round(bounded(config.populationCount, POPULATION_DEFAULTS.populationCount, 0, POPULATION_LIMITS.maxPopulation));
  const seed = Math.round(bounded(config.populationSeed, POPULATION_DEFAULTS.populationSeed, 1, POPULATION_LIMITS.maxSeed));
  const revisitSeconds = bounded(config.revisitSeconds, 120, 1, 3600);
  const crowdedSeconds = Math.min(revisitSeconds, bounded(config.crowdedRevisitSeconds, POPULATION_DEFAULTS.crowdedRevisitSeconds, POPULATION_LIMITS.minCrowdedRevisitSeconds, POPULATION_LIMITS.maxCrowdedSeconds));
  const crowdedPopulation = Math.round(bounded(config.crowdedCellPopulation, POPULATION_DEFAULTS.crowdedCellPopulation, POPULATION_LIMITS.minCrowdedCellPopulation, POPULATION_LIMITS.maxCrowdedCellPopulation));
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
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const allocations = weights.map(weight => totalPeople * weight / totalWeight);
  const counts = allocations.map(Math.floor);
  const remaining = totalPeople - counts.reduce((sum, count) => sum + count, 0);
  const remainderOrder = allocations.map((allocation, index) => ({ index, remainder: allocation - counts[index] }))
    .sort((first, second) => second.remainder - first.remainder || first.index - second.index);
  for (let index = 0; index < remaining; index += 1) counts[remainderOrder[index].index] += 1;
  cells.forEach((cell, index) => {
    cell.population = counts[index];
    cell.targetRevisitSeconds = revisitSeconds + (crowdedSeconds - revisitSeconds) * Math.min(1, cell.population / crowdedPopulation);
  });
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
