import { afterEach, describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { PPOAgent, maskedCategorical } from './patrol-rl-network';
import { RL_ACTION_COUNT, RL_DRONE_FEATURES, RL_GRID_CHANNELS, RL_GRID_SIZE, RL_MAX_DRONES, RL_OBSERVATION_SIZE } from './patrol-rl-contract';
import { RLPatrolEnvironment } from './patrol-rl-environment';
import { createRLScenarios } from './patrol-rl-scenarios';
import type { PPOOptions, PPOTransition } from './patrol-rl-network';

const agents: PPOAgent[] = [];
const droneOffset = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS;
const globalOffset = droneOffset + RL_MAX_DRONES * RL_DRONE_FEATURES;

function agent(seed = 42, options: Partial<PPOOptions> = {}): PPOAgent {
  const instance = new PPOAgent(RL_OBSERVATION_SIZE, seed, { actorArchitecture: 'shared', epochs: 2, minibatchSize: 8, ...options });
  agents.push(instance);
  return instance;
}

function logits(instance: PPOAgent, observations: number[][]): number[][] {
  const implementation = instance as unknown as { forward: (inputs: tf.Tensor2D, offset: number) => tf.Tensor2D };
  return tf.tidy(() => implementation.forward(tf.tensor2d(observations), 0).arraySync()) as number[][];
}

function demandObservation(side: number, population = 0.9): number[] {
  const observation = Array<number>(RL_OBSERVATION_SIZE).fill(0);
  for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) {
    const horizontal = ((cell % RL_GRID_SIZE + 0.5) / RL_GRID_SIZE - 0.5) * 240;
    const vertical = ((Math.floor(cell / RL_GRID_SIZE) + 0.5) / RL_GRID_SIZE - 0.5) * 240;
    observation[cell * RL_GRID_CHANNELS] = 1;
    observation[cell * RL_GRID_CHANNELS + 1] = Math.hypot(horizontal - side * 90, vertical) < 35 ? population : 0;
    observation[cell * RL_GRID_CHANNELS + 2] = 0.8;
    observation[cell * RL_GRID_CHANNELS + 3] = 0.5;
  }
  observation.splice(droneOffset, RL_DRONE_FEATURES, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1);
  observation.splice(globalOffset, 18, 240 / 640, 240 / 640, 0, 18 / 30, 32 / 64, 1,
    300 / 1800, 90 / 1800, 0.2, 2 / 8, 0, 0, 0.95, 120 / 3600, 15 / 120, 80 / 1000, 4000 / 50000, 1 / 8);
  return observation;
}

const directionMasks = () => Array.from({ length: RL_MAX_DRONES }, (_, slot) =>
  Array.from({ length: RL_ACTION_COUNT }, (_, action) => slot === 0 ? action === 2 || action === 14 : action === 24));

afterEach(() => agents.splice(0).forEach(instance => instance.dispose()));

describe('shared state-conditioned actor', () => {
  it('preserves the dense control critic and sampling initialization despite different actor shapes', () => {
    const dense = agent(73, { actorArchitecture: 'dense', rewardScale: 0.001 });
    const shared = agent(73, { rewardScale: 0.001 });
    const original = dense.exportCheckpoint();
    const replacement = shared.exportCheckpoint();
    expect(replacement.weights[0].shape).toEqual([68, 32]);
    expect(replacement.weights[4].shape).toEqual([32, 1]);
    expect(replacement.weights.slice(6)).toEqual(original.weights.slice(6));
    expect(replacement.randomState).toBe(original.randomState);
    const observation = demandObservation(1);
    expect(shared.value(observation)).toBe(dense.value(observation));
    dense.act(observation, directionMasks());
    shared.act(observation, directionMasks());
    expect(shared.exportCheckpoint().randomState).toBe(dense.exportCheckpoint().randomState);
  });

  it.each(['none', 'layer'] as const)('is exactly drone-slot equivariant with %s normalization, including padded slots', actorNormalization => {
    const instance = agent(101, { actorNormalization });
    const scenario = createRLScenarios('validation', 20261006, 4)[0];
    const environment = new RLPatrolEnvironment(scenario, 4);
    const { observation, masks } = environment.observation();
    const permutation = [3, 7, 0, 5, 2, 6, 1, 4];
    const relabeled = [...observation];
    permutation.forEach((source, destination) => {
      for (let feature = 0; feature < RL_DRONE_FEATURES; feature += 1) {
        relabeled[droneOffset + destination * RL_DRONE_FEATURES + feature] = observation[droneOffset + source * RL_DRONE_FEATURES + feature];
      }
    });
    const original = logits(instance, [observation])[0];
    const changed = logits(instance, [relabeled])[0];
    const actions = instance.act(observation, masks, true).actions;
    const relabeledActions = instance.act(relabeled, permutation.map(source => masks[source]), true).actions;
    for (const [destination, source] of permutation.entries()) {
      expect(changed.slice(destination * RL_ACTION_COUNT, (destination + 1) * RL_ACTION_COUNT))
        .toEqual(original.slice(source * RL_ACTION_COUNT, (source + 1) * RL_ACTION_COUNT));
      expect(relabeledActions[destination]).toBe(actions[source]);
    }
  });

  it('evaluates each observation independently of batch composition and distinguishes demand placement', () => {
    const instance = agent();
    const east = demandObservation(1);
    const west = demandObservation(-1);
    const batch = logits(instance, [east, west]);
    expect(batch[0]).toEqual(logits(instance, [east])[0]);
    expect(batch[1]).toEqual(logits(instance, [west])[0]);
    expect(Math.abs(batch[0][2] - batch[0][14])).toBeGreaterThan(1e-6);
    expect(batch[0][2]).toBeCloseTo(batch[1][14], 7);
    expect(batch[0][14]).toBeCloseTo(batch[1][2], 7);
  });

  it('learns opposite actions for opposite demand states, not a fixed direction preference', () => {
    const instance = agent(52, { learningRate: 0.01, epochs: 4, minibatchSize: 32, valueCoefficient: 0, entropyCoefficient: 0 });
    const before = instance.exportCheckpoint();
    const masks = directionMasks();
    const states = [demandObservation(1), demandObservation(-1)];
    const expected = [2, 14];
    let metrics;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const transitions: PPOTransition[] = Array.from({ length: 32 }, (_, index) => {
        const state = index % states.length;
        const action = instance.act(states[state], masks);
        return { observation: states[state], masks, ...action, reward: action.actions[0] === expected[state] ? 1 : -1, terminated: true };
      });
      metrics = instance.update(transitions, 0);
    }
    const outputs = logits(instance, states);
    for (const [index, observation] of states.entries()) {
      expect(instance.act(observation, masks, true).actions[0]).toBe(expected[index]);
      const distribution = maskedCategorical(outputs[index].slice(0, RL_ACTION_COUNT), masks[0]);
      expect(distribution.probabilities[expected[index]]).toBeGreaterThan(0.8);
    }
    expect(instance.exportCheckpoint().weights[0].values).not.toEqual(before.weights[0].values);
    expect(Object.values(metrics!).every(Number.isFinite)).toBe(true);
    const restored = PPOAgent.fromCheckpoint(JSON.parse(JSON.stringify(instance.exportCheckpoint())));
    agents.push(restored);
    expect(logits(restored, states)).toEqual(outputs);
  }, 30000);

  it('preserves masks and releases candidate feature, gradient, and optimizer tensors', () => {
    const before = tf.memory().numTensors;
    const instance = agent(42, { actorNormalization: 'layer', rewardScale: 0.001 });
    const observation = demandObservation(1);
    const masks = directionMasks();
    const rollout = () => Array.from({ length: 8 }, (_, index) => ({ observation, masks,
      ...instance.act(observation, masks), reward: index, terminated: true }));
    instance.update(rollout(), 0);
    const allocated = tf.memory().numTensors;
    const metrics = instance.update(rollout(), 0);
    expect(tf.memory().numTensors).toBe(allocated);
    expect(metrics.actorHidden1Saturation).toBeGreaterThanOrEqual(0);
    expect(metrics.actorHidden1Saturation).toBeLessThanOrEqual(1);
    const action = instance.act(observation, masks, true);
    expect(action.actions.every((chosen, slot) => masks[slot][chosen])).toBe(true);
    expect(action.actions.slice(1)).toEqual(Array(7).fill(24));
    instance.dispose();
    expect(tf.memory().numTensors).toBe(before);
  });
});
