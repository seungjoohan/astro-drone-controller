import { describe, expect, it } from 'vitest';
import { PatrolSystem } from './patrol';
import { evaluatePopulation } from './population';
import { calculatePatrolReward, DEFAULT_RL_REWARD_PROFILE, patrolReward, rewardMetadata, validateRewardMetadata } from './patrol-rl-reward';
import type { RLRewardAuditMetrics, RLRewardProfile } from './patrol-rl-reward';
import type { PatrolSnapshot } from './patrol-types';

function snapshot(): PatrolSnapshot {
  const system = new PatrolSystem({ populationCount: 100, fleetSize: 2 });
  system.enableExternalControl();
  const state = system.snapshot();
  state.time = 120;
  state.config.coverageTarget = 95;
  state.cells = state.cells.slice(0, 2).map((cell, index) => ({ ...cell, population: index ? 25 : 75,
    lastVisited: 110, targetRevisitSeconds: index ? 120 : 15 }));
  state.population = evaluatePopulation(state.cells, state.time, state.config, state.drones, state.environment.sensorRadius);
  return state;
}

const audit: RLRewardAuditMetrics = { coverage: 50, meanAgeCost: 0.4, overlapFraction: 0 };

function score(state: PatrolSnapshot, metrics = audit, profile: RLRewardProfile = DEFAULT_RL_REWARD_PROFILE) {
  return calculatePatrolReward(state, metrics, { ...state, time: state.time - 5 }, profile);
}

function originalReward(state: PatrolSnapshot, coverage: number, previous: PatrolSnapshot): number {
  let populationCost = 0;
  for (const cell of state.cells) {
    const age = cell.lastVisited === null ? state.time + cell.targetRevisitSeconds : Math.max(0, state.time - cell.lastVisited);
    const relativeAge = age / cell.targetRevisitSeconds;
    populationCost += cell.population / Math.max(1, state.config.populationCount) * (relativeAge + Math.max(0, relativeAge - 1) ** 2);
  }
  const unseen = (state.population.totalPeople - state.population.inViewPeople) / Math.max(1, state.config.populationCount);
  const deficit = Math.max(0, (state.config.coverageTarget - coverage) / 100);
  const geography = 1 - coverage / 100 + 10 * deficit ** 2;
  return -(populationCost + unseen + geography + 0.02 * state.drones.length) * (state.time - previous.time) / 5
    - 20 * (state.energy.reserveViolations - previous.energy.reserveViolations)
    - 50 * (state.energy.strandedDrones - previous.energy.strandedDrones)
    - ((state.externalControl?.forcedReturns ?? 0) - (previous.externalControl?.forcedReturns ?? 0));
}

describe('versioned patrol reward metadata', () => {
  it('defaults to the coverage profile and returns isolated auditable specifications', () => {
    expect(DEFAULT_RL_REWARD_PROFILE).toBe('coverage-v2');
    for (const profile of ['legacy-v1', 'coverage-v2'] as const) {
      const metadata = rewardMetadata(profile);
      expect(validateRewardMetadata(JSON.parse(JSON.stringify(metadata)))).toBe(profile);
      metadata.weights.geographicAge = 999;
      expect(rewardMetadata(profile).weights.geographicAge).not.toBe(999);
    }
    expect(rewardMetadata('coverage-v2').weights).toMatchObject({ geographicAge: 4, geographicUncovered: 4,
      geographicDeficit: 8, populationRevisit: 2, unobservedPeople: 1, overlap: 0.25 });
  });

  it('rejects unknown, incomplete, extra and tampered metadata', () => {
    const metadata = rewardMetadata('coverage-v2');
    const { overlap: _overlap, ...missing } = metadata;
    for (const invalid of [null, [], {}, missing, { ...metadata, version: 2 }, { ...metadata, profile: 'unknown' },
      { ...metadata, extra: 1 }, { ...metadata, weights: { ...metadata.weights, overlap: 5 } },
      { ...metadata, weights: { ...metadata.weights, hidden: 0 } }, { ...metadata, auditSpacingMeters: 40 }]) {
      expect(() => validateRewardMetadata(invalid)).toThrow(/reward metadata/);
    }
    expect(() => rewardMetadata('unknown' as RLRewardProfile)).toThrow(/reward profile/);
  });
});

describe('coverage-priority patrol reward', () => {
  it('preserves the legacy reward arithmetic exactly, including safety and unseen cells', () => {
    const previous = snapshot();
    for (const seconds of [0.5, 5, 123]) {
      const state = structuredClone(previous);
      state.time += seconds;
      state.cells[0].lastVisited = null;
      state.population.totalPeople *= 2;
      state.energy.reserveViolations += 1;
      state.energy.strandedDrones += 1;
      state.externalControl!.forcedReturns += 1;
      for (const coverage of [0, 37.5, 95, 100]) {
        const expected = originalReward(state, coverage, previous);
        expect(patrolReward(state, coverage, previous)).toBe(expected);
        expect(calculatePatrolReward(state, { ...audit, coverage }, previous, 'legacy-v1').reward).toBe(expected);
      }
    }
  });

  it('makes geographic costs substantial even in an empty city', () => {
    const state = snapshot();
    state.cells.forEach(cell => { cell.population = 0; });
    state.population.totalPeople = 0;
    state.population.inViewPeople = 0;
    const result = score(state, { coverage: 0, meanAgeCost: 1, overlapFraction: 0 });
    expect(result.components).toMatchObject({ geographicAge: -4, geographicUncovered: -4, geographicDeficit: -8,
      populationRevisit: -0, unobservedPeople: -0, overlap: -0, fleet: -0.04 });
    expect(result.reward).toBe(-16.04);
    expect(score(state, { coverage: 100, meanAgeCost: 0, overlapFraction: 0 }).reward).toBe(-0.04);
  });

  it('keeps population urgency bounded, continuous before deadlines, and population-weighted', () => {
    const state = snapshot();
    const recent = score(state).components.populationRevisit;
    state.cells[0].lastVisited = 100;
    expect(score(state).components.populationRevisit).toBeLessThan(recent);
    const crowdedDeadline = score(state).components.populationRevisit;
    state.cells[0].targetRevisitSeconds = 120;
    expect(score(state).components.populationRevisit).toBeGreaterThan(crowdedDeadline);
    state.time = 1e8;
    state.cells.forEach(cell => { cell.lastVisited = 0; });
    expect(score(state).components.populationRevisit).toBeGreaterThan(-2);
    state.cells.forEach(cell => { cell.lastVisited = null; });
    expect(score(state).components.populationRevisit).toBe(-2);
    state.cells[0].lastVisited = state.time;
    expect(score(state).components.populationRevisit).toBe(-0.5);
  });

  it('normalizes population shifts and preserves geometric proportions across map sizes', () => {
    const state = snapshot();
    const original = score(state);
    const changed = structuredClone(state);
    changed.cells.forEach(cell => { cell.population *= 10; });
    changed.population.totalPeople *= 10;
    changed.population.inViewPeople *= 10;
    changed.environment.width *= 2;
    changed.environment.depth *= 2;
    expect(score(changed)).toEqual(original);
  });

  it('retains pressure immediately below the geographic target and rewards fresher area', () => {
    const state = snapshot();
    const atTarget = score(state, { ...audit, coverage: 95 });
    const below = score(state, { ...audit, coverage: 94.9 });
    expect(below.components.geographicDeficit).toBeCloseTo(-8 * 0.1 / 95, 12);
    expect(below.reward).toBeLessThan(atTarget.reward);
    expect(score(state, { ...audit, coverage: 95, meanAgeCost: 0.2 }).reward).toBeGreaterThan(atTarget.reward);
    state.config.coverageTarget = 0;
    expect(score(state, { ...audit, coverage: 0 }).components.geographicDeficit).toBe(-0);
  });

  it('adds only a small bounded overlap cost without rewarding additional cameras', () => {
    const state = snapshot();
    const noOverlap = score(state);
    const halfOverlap = score(state, { ...audit, overlapFraction: 0.5 });
    const fullOverlap = score(state, { ...audit, overlapFraction: 1 });
    expect(halfOverlap.components.overlap).toBe(-0.125);
    expect(fullOverlap.reward).toBeCloseTo(noOverlap.reward - 0.25, 12);
    expect({ ...halfOverlap.components, overlap: 0 }).toEqual({ ...noOverlap.components, overlap: 0 });
    expect(score(state, { ...audit, overlapFraction: 1 }, 'legacy-v1').reward).toBe(score(state, audit, 'legacy-v1').reward);
    state.population.inViewPeople = state.population.totalPeople;
    expect(score(state).components.unobservedPeople).toBe(-0);
  });

  it('integrates costs over elapsed time and keeps safety penalties event-based', () => {
    const state = snapshot();
    const whole = score(state, { ...audit, overlapFraction: 0.5 });
    const halfSecond = calculatePatrolReward(state, { ...audit, overlapFraction: 0.5 }, { ...state, time: state.time - 0.5 });
    expect(halfSecond.reward).toBeCloseTo(whole.reward / 10, 12);
    for (const profile of ['legacy-v1', 'coverage-v2'] as const) {
      const previous = structuredClone(state);
      const before = calculatePatrolReward(state, audit, previous, profile).reward;
      const unsafe = structuredClone(state);
      unsafe.energy.reserveViolations += 1;
      unsafe.energy.strandedDrones += 1;
      unsafe.externalControl!.forcedReturns += 1;
      const result = calculatePatrolReward(unsafe, audit, previous, profile);
      expect(result.reward).toBe(before - 71);
      expect(result.components).toMatchObject({ reserve: -20, stranded: -50, forcedReturn: -1 });
    }
  });

  it('reports raw components whose sum reconciles to the reward', () => {
    for (const profile of ['legacy-v1', 'coverage-v2'] as const) {
      const result = score(snapshot(), { ...audit, overlapFraction: 0.6 }, profile);
      expect(Object.values(result.components).reduce((total, value) => total + value, 0)).toBeCloseTo(result.reward, 12);
    }
  });

  it('rejects invalid audit metrics and negative elapsed time', () => {
    const state = snapshot();
    for (const invalid of [{ ...audit, coverage: NaN }, { ...audit, coverage: -1 }, { ...audit, coverage: 101 },
      { ...audit, meanAgeCost: Infinity }, { ...audit, meanAgeCost: -1 }, { ...audit, meanAgeCost: 1.01 },
      { ...audit, overlapFraction: -0.1 }, { ...audit, overlapFraction: 1.1 }]) {
      expect(() => score(state, invalid)).toThrow(/reward audit/);
    }
    expect(() => calculatePatrolReward(state, audit, { ...state, time: state.time + 1 })).toThrow(/elapsed time/);
  });
});
