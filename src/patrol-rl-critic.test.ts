import { afterEach, describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { PPOAgent, RL_ACTION_COUNT, RL_MAX_DRONES } from './patrol-rl-network';
import type { PPOCheckpoint, PPOOptions, PPOTransition } from './patrol-rl-network';

interface CriticImplementation {
  weights: tf.Variable[];
  forward: (observations: tf.Tensor2D, offset: number) => tf.Tensor2D;
}

const agents: PPOAgent[] = [];

function agent(options: Partial<PPOOptions> = {}): PPOAgent {
  const instance = new PPOAgent(6, 73, { epochs: 2, minibatchSize: 8, rewardScale: 0.001, ...options });
  agents.push(instance);
  return instance;
}

function masks(): boolean[][] {
  return Array.from({ length: RL_MAX_DRONES }, (_, slot) =>
    Array.from({ length: RL_ACTION_COUNT }, (_, action) => action === 24 || slot < 2 && action < 3));
}

function rollout(instance: PPOAgent): PPOTransition[] {
  return Array.from({ length: 16 }, (_, index) => {
    const observation = [index / 16, Math.sin(index), -0.5, 0.75, 0.2, -0.1];
    const actionMasks = masks();
    return { observation, masks: actionMasks, ...instance.act(observation, actionMasks), reward: index - 8, terminated: index === 15 };
  });
}

afterEach(() => agents.splice(0).forEach(instance => instance.dispose()));

describe('opt-in critic layer normalization', () => {
  it('preserves initialization, actor decisions, sampling randomness, and none as the default', () => {
    const original = agent();
    const explicitNone = agent({ criticNormalization: 'none' });
    const normalized = agent({ criticNormalization: 'layer' });
    expect(original.options.criticNormalization).toBe('none');
    expect(explicitNone.exportCheckpoint()).toEqual(original.exportCheckpoint());
    expect(normalized.exportCheckpoint().weights).toEqual(original.exportCheckpoint().weights);
    expect(normalized.exportCheckpoint().randomState).toBe(original.exportCheckpoint().randomState);
    for (const observation of [[0.2, -0.5, 0.8, 0, 1, 0.3], Array(6).fill(1), Array(6).fill(0)]) {
      const originalAction = original.act(observation, masks());
      const normalizedAction = normalized.act(observation, masks());
      expect(normalizedAction.actions).toEqual(originalAction.actions);
      expect(normalizedAction.logProbability).toBe(originalAction.logProbability);
      expect(normalized.value(observation)).toBe(normalizedAction.value);
      expect(explicitNone.act(observation, masks())).toEqual(originalAction);
    }
    expect(normalized.exportCheckpoint().randomState).toBe(original.exportCheckpoint().randomState);
  });

  it('matches independent per-observation normalization in individual and batch value inference', () => {
    const instance = agent({ criticNormalization: 'layer', rewardScale: 1 });
    const implementation = instance as unknown as CriticImplementation;
    const weights = instance.exportCheckpoint().weights;
    const dense = (inputs: number[], offset: number) => weights[offset + 1].values.map((bias, output) =>
      inputs.reduce((sum, value, index) => sum + value * weights[offset].values[index * weights[offset + 1].values.length + output], bias));
    const observations = [[0.2, -0.5, 0.8, 0, 1, 0.3], Array(6).fill(1), Array(6).fill(0)];
    const batched = tf.tidy(() => Array.from(implementation.forward(tf.tensor2d(observations), 6).dataSync()));
    for (const [index, observation] of observations.entries()) {
      const preactivation = dense(observation, 6);
      const mean = preactivation.reduce((sum, value) => sum + value, 0) / 32;
      const variance = preactivation.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 32;
      const first = preactivation.map(value => Math.tanh((value - mean) / Math.sqrt(variance + 1e-5)));
      const expected = dense(dense(first, 8).map(Math.tanh), 10)[0];
      expect(instance.value(observation)).toBeCloseTo(expected, 6);
      expect(instance.value(observation)).toBe(batched[index]);
    }
  });

  it('measures the normalized critic actually used for values instead of the legacy path', () => {
    const checkpoint = agent({ epochs: 1 }).exportCheckpoint();
    checkpoint.weights[6].values.fill(0);
    checkpoint.weights[7].values.fill(10);
    const original = PPOAgent.fromCheckpoint(checkpoint);
    const normalized = PPOAgent.fromCheckpoint({ ...checkpoint, options: { ...checkpoint.options, criticNormalization: 'layer' } });
    agents.push(original, normalized);
    const originalMetrics = original.update(rollout(original), 0);
    const normalizedTransitions = rollout(normalized);
    const values = normalizedTransitions.map(transition => normalized.value(transition.observation));
    const normalizedMetrics = normalized.update(normalizedTransitions, 0);
    expect(originalMetrics.criticHidden1Saturation).toBe(1);
    expect(normalizedMetrics.criticHidden1Saturation).toBe(0);
    expect(normalizedMetrics.criticHidden2Saturation).toBe(0);
    expect(normalizedMetrics.valueMean).toBe(values.reduce((sum, value) => sum + value, 0) / values.length);
    expect(Object.values(normalizedMetrics).every(Number.isFinite)).toBe(true);
  });

  it('backpropagates normalized critic gradients and releases update tensors', () => {
    const instance = agent({ criticNormalization: 'layer', rewardScale: 1 });
    const implementation = instance as unknown as CriticImplementation;
    const observation = [0.1, 0.2, -0.3, 0.4, -0.5, 0.6];
    const before = instance.exportCheckpoint();
    const gradient = tf.tidy(() => {
      const computed = tf.variableGrads(() => tf.sum(implementation.forward(tf.tensor2d([observation]), 6)), [implementation.weights[6]]);
      return Array.from(computed.grads[implementation.weights[6].name].dataSync());
    });
    const output = (checkpoint: PPOCheckpoint) => {
      const restored = PPOAgent.fromCheckpoint(checkpoint);
      try { return restored.value(observation); } finally { restored.dispose(); }
    };
    for (const index of [0, 17, 83, 191]) {
      const plus = structuredClone(before);
      const minus = structuredClone(before);
      plus.weights[6].values[index] += 0.001;
      minus.weights[6].values[index] -= 0.001;
      expect(gradient[index]).toBeCloseTo((output(plus) - output(minus)) / 0.002, 4);
    }
    instance.update(rollout(instance), 0);
    expect(instance.exportCheckpoint().weights[6].values).not.toEqual(before.weights[6].values);
    const tensors = tf.memory().numTensors;
    const metrics = instance.update(rollout(instance), 0);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
    expect(tf.memory().numTensors).toBe(tensors);
  });
});
