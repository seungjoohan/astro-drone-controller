import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateRLPolicy, summarizeRLEvaluation, trainRLPolicy } from './patrol-rl-experiment';
import { PPOAgent, calculateGAE } from './patrol-rl-network';
import { RLPatrolEnvironment } from './patrol-rl-environment';
import { createRLScenarios } from './patrol-rl-scenarios';
import { RL_MAX_DRONES, RL_OBSERVATION_SIZE } from './patrol-rl-contract';
import type { PPOTransition } from './patrol-rl-network';
import type { RLEpisodeResult } from './patrol-rl-environment';
import type { RLRewardProfile } from './patrol-rl-reward';

const agents: PPOAgent[] = [];
const seed = 123;
const episode = { warmupSeconds: 0, durationSeconds: 5 };
const ppo = { epochs: 1, minibatchSize: 8 };
const trainScenarios = createRLScenarios('train', seed, 2);
const validationScenarios = createRLScenarios('validation', seed, 1);

function agent(observationSize = RL_OBSERVATION_SIZE): PPOAgent {
  const instance = new PPOAgent(observationSize, seed, ppo);
  agents.push(instance);
  return instance;
}

function countSteps(): () => number {
  let count = 0;
  const original = RLPatrolEnvironment.prototype.step;
  vi.spyOn(RLPatrolEnvironment.prototype, 'step').mockImplementation(function (this: RLPatrolEnvironment, actions) {
    const result = original.call(this, actions);
    count += 1;
    return result;
  });
  return () => count;
}

afterEach(() => {
  vi.restoreAllMocks();
  agents.splice(0).forEach(instance => instance.dispose());
});

describe('neural patrol training orchestration', () => {
  it('propagates explicit reward profiles and rejects unknown profiles before updating', async () => {
    for (const rewardProfile of ['legacy-v1', 'coverage-v2'] as const) {
      const result = await trainRLPolicy(trainScenarios, { seed, episodes: 8, rolloutSteps: 8, ppo, episode, rewardProfile });
      agents.push(result.agent);
      expect(result.rewardProfile).toBe(rewardProfile);
      expect(result.episodes.every(row => row.rewardProfile === rewardProfile)).toBe(true);
      expect(result.episodes.every(row => Object.values(row.rewardComponents).every(Number.isFinite))).toBe(true);
    }
    const update = vi.spyOn(PPOAgent.prototype, 'update');
    await expect(trainRLPolicy(trainScenarios, { seed, episodes: 8, ppo, episode, rewardProfile: 'unknown' as RLRewardProfile }))
      .rejects.toThrow(/reward profile/);
    expect(update).not.toHaveBeenCalled();
  });

  it('includes every fleet size in the first block and balances subsequent blocks', async () => {
    const callback = vi.fn();
    const result = await trainRLPolicy(trainScenarios, { seed, episodes: 16, rolloutSteps: 8, ppo, episode, onEpisode: callback });
    agents.push(result.agent);
    expect(result.cancelled).toBe(false);
    expect(result.steps).toBe(16);
    expect(result.episodes).toHaveLength(16);
    expect(result.updates).toHaveLength(2);
    for (let offset = 0; offset < 16; offset += 8) {
      expect(result.episodes.slice(offset, offset + 8).map(item => item.fleetSize).sort((first, second) => first - second))
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
    for (let offset = 0; offset < 16; offset += trainScenarios.length) {
      expect(new Set(result.episodes.slice(offset, offset + trainScenarios.length).map(item => item.scenarioId)).size).toBe(trainScenarios.length);
    }
    expect(result.episodes.every(item => item.controller === 'neural' && item.split === 'train')).toBe(true);
    expect(callback.mock.calls.map(call => call[1])).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    expect(result.updates.every(metrics => Object.values(metrics).every(Number.isFinite))).toBe(true);
  });

  it('reproduces training and checkpoints while genuinely updating neural weights', async () => {
    const before = agent().exportCheckpoint();
    const options = { seed, episodes: 8, rolloutSteps: 8, ppo, episode };
    const first = await trainRLPolicy(trainScenarios, options);
    const second = await trainRLPolicy(trainScenarios, options);
    agents.push(first.agent, second.agent);
    expect(first.episodes).toEqual(second.episodes);
    expect(first.updates).toEqual(second.updates);
    const checkpoint = first.agent.exportCheckpoint();
    expect(checkpoint).toEqual(second.agent.exportCheckpoint());
    expect(checkpoint.weights).not.toEqual(before.weights);
    const restored = PPOAgent.fromCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    agents.push(restored);
    const environment = new RLPatrolEnvironment(validationScenarios[0], 3, episode);
    const { observation, masks } = environment.observation();
    expect(restored.act(observation, masks, true)).toEqual(first.agent.act(observation, masks, true));
  });

  it('never allows held-out scenarios or incomplete fleet blocks into training', async () => {
    const update = vi.spyOn(PPOAgent.prototype, 'update');
    const options = { seed, episodes: 8, rolloutSteps: 8, ppo, episode };
    for (const scenarios of [[], validationScenarios, createRLScenarios('final', seed, 1), [...trainScenarios, ...validationScenarios]]) {
      await expect(trainRLPolicy(scenarios, options)).rejects.toThrow(/training scenarios/);
    }
    for (const episodes of [0, 1, 7, 9, 15, 8.5]) await expect(trainRLPolicy(trainScenarios, { ...options, episodes })).rejects.toThrow(/blocks of 8/);
    for (const rolloutSteps of [0, 1, 4097, 2.5]) await expect(trainRLPolicy(trainScenarios, { ...options, rolloutSteps })).rejects.toThrow(/rollout length/);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps environment rewards raw while storing scaled critic units and optimization settings', async () => {
    const captured: Array<{ transitions: PPOTransition[]; bootstrapValue: number }> = [];
    const original = PPOAgent.prototype.update;
    vi.spyOn(PPOAgent.prototype, 'update').mockImplementation(function (this: PPOAgent, transitions, bootstrapValue) {
      captured.push({ transitions: structuredClone(transitions), bootstrapValue });
      return original.call(this, transitions, bootstrapValue);
    });
    const options = { seed, episodes: 8, rolloutSteps: 8, ppo, episode };
    const raw = await trainRLPolicy(trainScenarios, options);
    const scaled = await trainRLPolicy(trainScenarios, { ...options, ppo: { ...ppo, rewardScale: 0.001, gradientClipping: 'separate' } });
    agents.push(raw.agent, scaled.agent);
    expect(raw.episodes).toEqual(scaled.episodes);
    expect(captured).toHaveLength(2);
    expect(captured[1].transitions.map(transition => transition.reward)).toEqual(captured[0].transitions.map(transition => transition.reward));
    for (const [index, transition] of captured[1].transitions.entries()) {
      expect(transition.value).toBeCloseTo(captured[0].transitions[index].value * 0.001, 6);
      expect(transition.nextValue).toBeCloseTo(captured[0].transitions[index].nextValue! * 0.001, 6);
    }
    expect(scaled.agent.exportCheckpoint().options).toMatchObject({ rewardScale: 0.001, gradientClipping: 'separate' });
    expect(scaled.updates[0].rewardRawMean).toBeCloseTo(raw.updates[0].rewardRawMean, 10);
    expect(scaled.updates[0].rewardScaledMean).toBeCloseTo(raw.updates[0].rewardRawMean * 0.001, 10);
  });

  it('carries final-state values across truncated episodes without leaking reset rewards', async () => {
    const captured: Array<{ transitions: PPOTransition[]; bootstrapValue: number }> = [];
    const original = PPOAgent.prototype.update;
    vi.spyOn(PPOAgent.prototype, 'update').mockImplementation(function (this: PPOAgent, transitions, bootstrapValue) {
      captured.push({ transitions: structuredClone(transitions), bootstrapValue });
      return original.call(this, transitions, bootstrapValue);
    });
    const result = await trainRLPolicy(trainScenarios, { seed, episodes: 8, rolloutSteps: 8, ppo, episode });
    agents.push(result.agent);
    expect(captured).toHaveLength(1);
    const batch = captured[0];
    expect(batch.transitions).toHaveLength(8);
    expect(batch.transitions.every(transition => transition.truncated && !transition.terminated && Number.isFinite(transition.nextValue))).toBe(true);
    const { advantages, returns } = calculateGAE(batch.transitions, batch.bootstrapValue, result.agent.options.gamma, result.agent.options.gaeLambda);
    for (const [index, transition] of batch.transitions.entries()) {
      const expectedReturn = transition.reward + result.agent.options.gamma * transition.nextValue!;
      expect(returns[index]).toBeCloseTo(expectedReturn, 10);
      expect(advantages[index]).toBeCloseTo(expectedReturn - transition.value, 10);
    }
  });

  it('returns only completed training episodes when cancellation occurs mid-episode', async () => {
    const steps = countSteps();
    const onEpisode = vi.fn();
    const result = await trainRLPolicy(trainScenarios, {
      seed, episodes: 8, rolloutSteps: 8, ppo, episode: { ...episode, durationSeconds: 10 },
      cancelled: () => steps() >= 5, onEpisode,
    });
    agents.push(result.agent);
    expect(result.cancelled).toBe(true);
    expect(result.steps).toBe(5);
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes.every(item => item.durationSeconds === 10)).toBe(true);
    expect(onEpisode).toHaveBeenCalledTimes(2);
    expect(result.updates).toEqual([]);
    expect(result.agent.exportCheckpoint().weights).toEqual(agent().exportCheckpoint().weights);
  });

  it('handles cancellation before training without manufacturing episodes or updates', async () => {
    const result = await trainRLPolicy(trainScenarios, { seed, episodes: 8, ppo, episode, cancelled: () => true });
    agents.push(result.agent);
    expect(result.cancelled).toBe(true);
    expect(result.steps).toBe(0);
    expect(result.episodes).toEqual([]);
    expect(result.updates).toEqual([]);
  });
});

describe('matched held-out evaluation', () => {
  it('keeps matched controllers on one explicit reward profile and rejects mixed summaries', async () => {
    const instance = agent();
    const legacy = await evaluateRLPolicy(instance, validationScenarios, { episode, rewardProfile: 'legacy-v1' });
    const coverage = await evaluateRLPolicy(instance, validationScenarios, { episode, rewardProfile: 'coverage-v2' });
    const serviceOnly = (rows: RLEpisodeResult[]) => rows.map(({ reward: _reward, rewardProfile: _profile, rewardComponents: _components, ...rest }) => rest);
    expect(serviceOnly(coverage)).toEqual(serviceOnly(legacy));
    expect(legacy.every(row => row.rewardProfile === 'legacy-v1')).toBe(true);
    expect(coverage.every(row => row.rewardProfile === 'coverage-v2')).toBe(true);
    expect(() => summarizeRLEvaluation([coverage[0], ...legacy.slice(1)], validationScenarios)).toThrow(/mixed RL reward profiles/);
    await expect(evaluateRLPolicy(instance, validationScenarios, { episode, rewardProfile: 'unknown' as RLRewardProfile }))
      .rejects.toThrow(/reward profile/);
  });

  it('evaluates all three controllers at sizes 1–8 without changing weights or sampling state', async () => {
    const instance = agent();
    const before = instance.exportCheckpoint();
    const update = vi.spyOn(instance, 'update');
    const first = await evaluateRLPolicy(instance, validationScenarios, { episode });
    const second = await evaluateRLPolicy(instance, validationScenarios, { episode });
    expect(first).toHaveLength(RL_MAX_DRONES * 3);
    expect(first).toEqual(second);
    expect(instance.exportCheckpoint()).toEqual(before);
    expect(update).not.toHaveBeenCalled();
    for (let fleetSize = 1; fleetSize <= RL_MAX_DRONES; fleetSize += 1) {
      const paired = first.filter(result => result.fleetSize === fleetSize);
      expect(paired.map(result => result.controller)).toEqual(['uniform', 'adaptive', 'neural']);
      expect(new Set(paired.map(result => result.scenarioId))).toEqual(new Set([validationScenarios[0].id]));
      expect(new Set(paired.map(result => result.personSeconds)).size).toBe(1);
      expect(paired.every(result => result.warmupSeconds === 0 && result.durationSeconds === 5 && !result.qualifyingProtocol)).toBe(true);
    }
  });

  it('rejects training splits and incompatible policies while allowing the final split', async () => {
    const instance = agent();
    for (const scenarios of [[], trainScenarios, [...validationScenarios, ...trainScenarios]]) {
      await expect(evaluateRLPolicy(instance, scenarios, { episode })).rejects.toThrow(/held-out/);
    }
    await expect(evaluateRLPolicy(agent(6), validationScenarios, { episode })).rejects.toThrow(/schema/);
    const finalResults = await evaluateRLPolicy(instance, createRLScenarios('final', seed, 1), { episode });
    expect(finalResults).toHaveLength(RL_MAX_DRONES * 3);
    expect(finalResults.every(result => result.split === 'final')).toBe(true);
    expect(summarizeRLEvaluation(finalResults, createRLScenarios('final', seed, 1)).smallestValidatedFleet).toBeNull();
  });

  it('excludes a partially evaluated controller on cancellation', async () => {
    const steps = countSteps();
    const onEpisode = vi.fn();
    const results = await evaluateRLPolicy(agent(), validationScenarios, {
      episode: { ...episode, durationSeconds: 10 }, cancelled: () => steps() >= 5, onEpisode,
    });
    expect(steps()).toBe(5);
    expect(results.map(result => result.controller)).toEqual(['uniform', 'adaptive']);
    expect(results.every(result => result.durationSeconds === 10 && result.fleetSize === 1)).toBe(true);
    expect(onEpisode).toHaveBeenCalledTimes(2);
    const summary = summarizeRLEvaluation(results, validationScenarios);
    expect(summary.complete).toBe(false);
    expect(summary.smallestValidatedFleet).toBeNull();
    expect(summary.promotionEligible).toBe(false);
  });

  it('never qualifies smoke runs, incomplete suites, duplicates, or empty suites', async () => {
    const smoke = await evaluateRLPolicy(agent(), validationScenarios, { episode });
    const success = (result: RLEpisodeResult): RLEpisodeResult => ({
      ...result,
      metrics: { ...result.metrics, geographicFeasible: true, hotspotFeasible: true, neverObservedPeople: 0, energyViolations: 0, reserveViolations: 0 },
      forcedReturns: 0, rejectedCommands: 0,
    });
    const smokeSummary = summarizeRLEvaluation(smoke.map(success), validationScenarios);
    expect(smokeSummary.complete).toBe(true);
    expect(smokeSummary.smallestValidatedFleet).toBeNull();
    expect(smokeSummary.promotionEligible).toBe(false);
    expect(smokeSummary.paired).toHaveLength(RL_MAX_DRONES);
    const full = smoke.map(result => ({ ...success(result), qualifyingProtocol: true,
      warmupSeconds: validationScenarios[0].warmupSeconds, durationSeconds: validationScenarios[0].durationSeconds }));
    const fullSummary = summarizeRLEvaluation(full, validationScenarios);
    expect(fullSummary.complete).toBe(true);
    expect(fullSummary.smallestValidatedFleet).toBe(1);
    expect(fullSummary.promotionEligible).toBe(false);
    for (const incomplete of [full.slice(1), [...full.slice(1), full[1]], []]) {
      const summary = summarizeRLEvaluation(incomplete, validationScenarios);
      expect(summary.complete).toBe(false);
      expect(summary.smallestValidatedFleet).toBeNull();
      expect(summary.promotionEligible).toBe(false);
    }
    expect(summarizeRLEvaluation([], []).complete).toBe(false);
  });
});
