import { afterEach, describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { calculateGAE, clippedSurrogate, maskedCategorical, PPOAgent, RL_ACTION_COUNT, RL_MAX_DRONES } from './patrol-rl-network';
import type { PPOCheckpoint, PPOTransition } from './patrol-rl-network';

const agents: PPOAgent[] = [];

function agent(seed = 42, options = {}): PPOAgent {
  const instance = new PPOAgent(6, seed, { epochs: 2, minibatchSize: 8, ...options });
  agents.push(instance);
  return instance;
}

function masks(): boolean[][] {
  return Array.from({ length: RL_MAX_DRONES }, (_, droneIndex) => Array.from({ length: RL_ACTION_COUNT }, (_, actionIndex) => actionIndex === 24 || droneIndex < 2 && actionIndex < 3));
}

function rollout(instance: PPOAgent, length = 16): PPOTransition[] {
  return Array.from({ length }, (_, index) => {
    const observation = [index / length, 0.25, -0.5, Math.sin(index), 0.75, -0.1];
    const validActions = masks();
    const action = instance.act(observation, validActions);
    return {
      observation,
      masks: validActions,
      ...action,
      reward: action.actions[0] === 0 ? 2 : -0.25,
      terminated: index === length - 1,
    };
  });
}

afterEach(() => {
  agents.splice(0).forEach(instance => instance.dispose());
});

describe('PPO objective and bootstrapping', () => {
  it('clips the advantageous ratio side and preserves the corrective side', () => {
    expect(clippedSurrogate(2, 1.5)).toBeCloseTo(2.4);
    expect(clippedSurrogate(-2, 1.5)).toBeCloseTo(-3);
    expect(clippedSurrogate(2, 0.5)).toBeCloseTo(1);
    expect(clippedSurrogate(-2, 0.5)).toBeCloseTo(-1.6);
    expect(clippedSurrogate(0, 4)).toBe(0);
  });

  it('computes GAE returns and ignores bootstrap after true termination', () => {
    const result = calculateGAE([
      { value: 10, reward: 1, terminated: false },
      { value: 20, reward: 2, terminated: true },
    ], 999, 0.5, 1);
    expect(result.advantages).toEqual([-8, -18]);
    expect(result.returns).toEqual([2, 2]);
  });

  it('bootstraps rollout cuts and truncations without leaking into a reset episode', () => {
    const truncated = { value: 2, reward: 3, terminated: false, truncated: true, nextValue: 7 };
    const result = calculateGAE([
      truncated,
      { value: 50, reward: 99, terminated: true },
    ], 888, 0.9, 0.95);
    expect(result.advantages[0]).toBeCloseTo(7.3);
    expect(result.returns[0]).toBeCloseTo(9.3);
    expect(result.advantages[1]).toBe(49);
    expect(calculateGAE([{ value: 2, reward: 3, terminated: false }], 7, 0.9, 0.95).advantages[0]).toBeCloseTo(7.3);
    expect(() => calculateGAE([{ ...truncated, nextValue: undefined }], 7)).toThrow(/bootstrap/);
  });

  it('stops GAE recursion at episode boundaries inside a rollout', () => {
    const result = calculateGAE([
      { value: 1, reward: 3, terminated: true },
      { value: 100, reward: 1000, terminated: true },
    ], 0);
    expect(result.advantages).toEqual([2, 900]);
    expect(() => calculateGAE([{ value: NaN, reward: 0, terminated: false }], 0)).toThrow();
    expect(() => calculateGAE([], Infinity)).toThrow();
  });
});

describe('masked categorical action distribution', () => {
  it('normalizes only valid actions and reports the masked entropy', () => {
    const distribution = maskedCategorical([10000, Math.log(1), Math.log(3)], [false, true, true]);
    expect(distribution.probabilities[0]).toBe(0);
    expect(distribution.probabilities[1]).toBeCloseTo(0.25);
    expect(distribution.probabilities[2]).toBeCloseTo(0.75);
    expect(distribution.logProbabilities[0]).toBe(-Infinity);
    expect(distribution.logProbabilities[2]).toBeCloseTo(Math.log(0.75));
    expect(distribution.entropy).toBeCloseTo(-0.25 * Math.log(0.25) - 0.75 * Math.log(0.75));
    expect(maskedCategorical([4, 100], [true, false])).toEqual({ probabilities: [1, 0], logProbabilities: [0, -Infinity], entropy: 0 });
  });

  it('is stable for large logits and rejects malformed masks', () => {
    expect(maskedCategorical([1000, 1001], [true, true]).probabilities[1]).toBeCloseTo(1 / (1 + Math.exp(-1)));
    expect(() => maskedCategorical([0], [false])).toThrow();
    expect(() => maskedCategorical([Infinity], [true])).toThrow();
    expect(() => maskedCategorical([0, 0], [true])).toThrow();
  });
});

describe('centralized neural PPO', () => {
  it('preserves the original global-clipping update weights and random sequence exactly', async () => {
    const instance = agent();
    const transitions = rollout(instance);
    const hashWeights = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(instance.exportCheckpoint().weights)))))
      .map(value => value.toString(16).padStart(2, '0')).join('');
    expect(await hashWeights()).toBe('233f326bfa39550b2310f66d35e88d367f961b4ce60ae25fb4889b9980c3f67c');
    const metrics = instance.update(transitions, 0);
    expect(await hashWeights()).toBe('5cdf66d3697610fece9efcfbe42c1fb2d37a2d9b0d9afb59effe9db562c4f698');
    expect(instance.exportCheckpoint().randomState).toBe(308083832);
    expect(metrics.policyLoss).toBe(-0.001851942390203476);
    expect(metrics.gradientNorm).toBe(3.2472389340400696);
  });

  it('scales only initial critic output weights while preserving actor, raw values, and sampling RNG', () => {
    const original = agent(42);
    const scaled = agent(42, { rewardScale: 0.001, gradientClipping: 'separate' });
    const originalCheckpoint = original.exportCheckpoint();
    const scaledCheckpoint = scaled.exportCheckpoint();
    expect(scaledCheckpoint.version).toBe(5);
    expect(scaledCheckpoint.weights.slice(0, 10)).toEqual(originalCheckpoint.weights.slice(0, 10));
    expect(scaledCheckpoint.randomState).toBe(originalCheckpoint.randomState);
    originalCheckpoint.weights[10].values.forEach((value, index) => {
      expect(scaledCheckpoint.weights[10].values[index]).toBeCloseTo(value * 0.001, 9);
    });
    const observation = [0.2, 0.5, -1, 0, 0.7, 0.3];
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const originalAction = original.act(observation, masks());
      const scaledAction = scaled.act(observation, masks());
      expect(scaledAction.actions).toEqual(originalAction.actions);
      expect(scaledAction.logProbability).toBe(originalAction.logProbability);
      expect(scaledAction.value / 0.001).toBeCloseTo(originalAction.value, 6);
      expect(scaled.value(observation)).toBe(scaledAction.value);
    }
    expect(scaled.exportCheckpoint().randomState).toBe(original.exportCheckpoint().randomState);
  });

  it('scales raw rewards exactly once without rescaling values, rollout cuts, or truncation bootstraps', () => {
    const checkpoint = agent(42, { epochs: 1, minibatchSize: 4, rewardScale: 0.001, gamma: 0.5, gaeLambda: 1 }).exportCheckpoint();
    checkpoint.weights.forEach(weight => weight.values.fill(0));
    const instance = PPOAgent.fromCheckpoint(checkpoint);
    agents.push(instance);
    const transitions: PPOTransition[] = [1, 2, 3, 4].map(value => ({
      observation: Array(6).fill(0), masks: masks(), actions: [0, 0, ...Array(6).fill(24)], logProbability: 2 * Math.log(0.25),
      value, reward: value * 1000, terminated: value === 3, ...(value === 2 ? { truncated: true, nextValue: 6 } : {}),
    }));
    const original = structuredClone(transitions);
    const metrics = instance.update(transitions, 8);
    expect(transitions).toEqual(original);
    expect(metrics.rewardRawMean).toBe(2500);
    expect(metrics.rewardRawMin).toBe(1000);
    expect(metrics.rewardRawMax).toBe(4000);
    expect(metrics.rewardScaledMean).toBe(2.5);
    expect(metrics.rewardScaledMin).toBe(1);
    expect(metrics.rewardScaledMax).toBe(4);
    expect(metrics.returnMean).toBe(4.875);
    expect(metrics.returnMin).toBe(3);
    expect(metrics.returnMax).toBe(8);
    expect(metrics.valueLoss).toBeCloseTo(13.78125, 6);
    expect(metrics.criticRmse).toBeCloseTo(Math.sqrt(27.5625), 6);
    expect(metrics.criticExplainedVariance).toBe(0);
    expect(metrics.criticExplainedVarianceValid).toBe(1);
  });

  it('normalizes only the actor first layer per observation without new weights or initialization randomness', () => {
    const original = agent(73, { rewardScale: 0.001 });
    const normalized = agent(73, { rewardScale: 0.001, actorNormalization: 'layer' });
    expect(normalized.exportCheckpoint().weights).toEqual(original.exportCheckpoint().weights);
    expect(normalized.exportCheckpoint().randomState).toBe(original.exportCheckpoint().randomState);
    const observations = [[0.2, -0.5, 0.8, 0, 1, 0.3], [1, 1, 1, 1, 1, 1], Array(6).fill(0)];
    for (const observation of observations) expect(normalized.value(observation)).toBe(original.value(observation));
    const implementation = normalized as unknown as { forward: (observations: tf.Tensor2D, offset: number) => tf.Tensor2D };
    const weights = normalized.exportCheckpoint().weights;
    const dense = (input: number[], offset: number) => weights[offset + 1].values.map((bias, output) =>
      input.reduce((sum, value, index) => sum + value * weights[offset].values[index * weights[offset + 1].values.length + output], bias));
    const batch = tf.tidy(() => implementation.forward(tf.tensor2d(observations), 0).arraySync()) as number[][];
    for (const [index, observation] of observations.entries()) {
      const preactivation = dense(observation, 0);
      const mean = preactivation.reduce((sum, value) => sum + value, 0) / 32;
      const variance = preactivation.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 32;
      const first = preactivation.map(value => Math.tanh((value - mean) / Math.sqrt(variance + 1e-5)));
      const second = dense(first, 2).map(Math.tanh);
      const expected = dense(second, 4);
      const single = tf.tidy(() => Array.from(implementation.forward(tf.tensor2d([observation]), 0).dataSync()));
      expect(single).toEqual(batch[index]);
      expected.forEach((value, output) => expect(single[output]).toBeCloseTo(value, 7));
    }
  });

  it('measures pre-update actor saturation and state dependence without changing constant-observation choices', () => {
    const checkpoint = agent(42, { epochs: 1 }).exportCheckpoint();
    checkpoint.weights[0].values.fill(0);
    checkpoint.weights[1].values.fill(10);
    const unnormalized = PPOAgent.fromCheckpoint(checkpoint);
    const normalized = PPOAgent.fromCheckpoint({ ...checkpoint, options: { ...checkpoint.options, actorNormalization: 'layer' } });
    agents.push(unnormalized, normalized);
    const originalMetrics = unnormalized.update(rollout(unnormalized), 0);
    const normalizedMetrics = normalized.update(rollout(normalized), 0);
    expect(originalMetrics.actorHidden1PreactivationAbsMean).toBe(10);
    expect(originalMetrics.actorHidden1Saturation).toBe(1);
    expect(normalizedMetrics.actorHidden1PreactivationAbsMean).toBe(10);
    expect(normalizedMetrics.actorHidden1Saturation).toBe(0);
    expect(normalizedMetrics.actorHidden2Saturation).toBe(0);
    for (const metrics of [originalMetrics, normalizedMetrics]) {
      expect(metrics.actorStateTotalVariation).toBe(0);
      expect(metrics.actorStateGreedyAgreement).toBe(1);
      expect(metrics.actorStateDecisionHeads).toBe(32);
      expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
    }
  });

  it('differentiates through actor normalization and releases normalized update tensors', () => {
    const instance = agent(52, { actorNormalization: 'layer', rewardScale: 0.001 });
    const implementation = instance as unknown as { weights: tf.Variable[]; forward: (observations: tf.Tensor2D, offset: number) => tf.Tensor2D };
    const observation = [0.1, 0.2, -0.3, 0.4, -0.5, 0.6];
    const before = instance.exportCheckpoint();
    const gradient = tf.tidy(() => {
      const computed = tf.variableGrads(() => tf.sum(implementation.forward(tf.tensor2d([observation]), 0).slice([0, 0], [1, 1])), [implementation.weights[0]]);
      return Array.from(computed.grads[implementation.weights[0].name].dataSync());
    });
    const output = (checkpoint: PPOCheckpoint) => {
      const restored = PPOAgent.fromCheckpoint(checkpoint);
      try {
        const network = restored as unknown as typeof implementation;
        return tf.tidy(() => network.forward(tf.tensor2d([observation]), 0).dataSync()[0]);
      } finally { restored.dispose(); }
    };
    for (const index of [0, 17, 83, 191]) {
      const plus = structuredClone(before);
      const minus = structuredClone(before);
      plus.weights[0].values[index] += 0.001;
      minus.weights[0].values[index] -= 0.001;
      expect(gradient[index]).toBeCloseTo((output(plus) - output(minus)) / 0.002, 5);
    }
    instance.update(rollout(instance), 0);
    expect(instance.exportCheckpoint().weights[0].values).not.toEqual(before.weights[0].values);
    const tensors = tf.memory().numTensors;
    const metrics = instance.update(rollout(instance), 0);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
    expect(tf.memory().numTensors).toBe(tensors);
  });

  it('measures pre-update critic fit, saturation, masked entropy, and actual update displacements', () => {
    const checkpoint = agent(42, { epochs: 1, minibatchSize: 8, rewardScale: 0.001, gradientClipping: 'separate' }).exportCheckpoint();
    checkpoint.weights.forEach(weight => weight.values.fill(0));
    checkpoint.weights[7].values.fill(10);
    checkpoint.weights[9].values.fill(-10);
    checkpoint.weights[11].values[0] = 2;
    const instance = PPOAgent.fromCheckpoint(checkpoint);
    agents.push(instance);
    const transitions = rollout(instance, 8).map(transition => ({ ...transition, reward: 2000, terminated: true }));
    const metrics = instance.update(transitions, 0);
    expect(metrics.valueMean).toBe(2);
    expect(metrics.valueMin).toBe(2);
    expect(metrics.valueMax).toBe(2);
    expect(metrics.valueStddev).toBe(0);
    expect(metrics.criticRmse).toBe(0);
    expect(metrics.returnStddev).toBe(0);
    expect(metrics.criticExplainedVariance).toBe(0);
    expect(metrics.criticExplainedVarianceValid).toBe(0);
    expect(metrics.criticHidden1Saturation).toBe(1);
    expect(metrics.criticHidden2Saturation).toBe(1);
    expect(metrics.normalizedEntropy).toBeCloseTo(1, 6);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
    const after = instance.exportCheckpoint();
    const stepNorm = (start: number, end: number) => Math.sqrt(after.weights.slice(start, end).reduce((sum, weight, offset) => sum
      + weight.values.reduce((inner, value, index) => inner + (value - checkpoint.weights[start + offset].values[index]) ** 2, 0), 0));
    expect(metrics.actorParameterStepNorm).toBeCloseTo(stepNorm(0, 6), 8);
    expect(metrics.criticParameterStepNorm).toBeCloseTo(stepNorm(6, 12), 8);
  });

  it('clips actor and critic independently rather than shrinking the actor to fit a dominant critic', () => {
    const global = agent(57, { epochs: 1, minibatchSize: 16, maxGradientNorm: 0.05 });
    const separate = agent(57, { epochs: 1, minibatchSize: 16, maxGradientNorm: 0.05, gradientClipping: 'separate' });
    const globalTransitions = rollout(global).map((transition, index) => ({ ...transition, reward: -10000 + index * 100, terminated: true }));
    const separateTransitions = rollout(separate).map((transition, index) => ({ ...transition, reward: -10000 + index * 100, terminated: true }));
    expect(globalTransitions).toEqual(separateTransitions);
    const globalMetrics = global.update(globalTransitions, 0);
    const separateMetrics = separate.update(separateTransitions, 0);
    expect(separateMetrics.actorGradientNorm).toBe(globalMetrics.actorGradientNorm);
    expect(separateMetrics.criticGradientNorm).toBe(globalMetrics.criticGradientNorm);
    expect(separateMetrics.actorClippedGradientNorm).toBeCloseTo(0.05, 6);
    expect(separateMetrics.criticClippedGradientNorm).toBeCloseTo(0.05, 6);
    expect(separateMetrics.actorClippedGradientNorm).toBeGreaterThan(globalMetrics.actorClippedGradientNorm * 100);
    expect(globalMetrics.actorClippedGradientNorm / globalMetrics.actorGradientNorm)
      .toBeCloseTo(globalMetrics.criticClippedGradientNorm / globalMetrics.criticGradientNorm, 8);
    expect(separateMetrics.actorParameterStepNorm).toBeGreaterThan(globalMetrics.actorParameterStepNorm);
    expect(separateMetrics.criticParameterStepNorm).toBeGreaterThan(0);
  });

  it.each(['none', 'layer'] as const)('handles a fully forced action mask with %s normalization without undefined diagnostics or leaked tensors', actorNormalization => {
    const instance = agent(42, { rewardScale: 0.001, gradientClipping: 'separate', actorNormalization });
    const forcedMasks = masks().map(mask => mask.map((_, actionIndex) => actionIndex === 24));
    const forcedRollout = () => Array.from({ length: 8 }, (_, index) => {
      const observation = [index / 8, 0.25, -0.5, 0, 0.75, -0.1];
      return { observation, masks: forcedMasks, ...instance.act(observation, forcedMasks), reward: index * 100, terminated: true };
    });
    const metrics = instance.update(forcedRollout(), 0);
    expect(metrics.normalizedEntropy).toBe(0);
    expect(metrics.entropy).toBe(0);
    expect(metrics.actorGradientNorm).toBe(0);
    expect(metrics.actorParameterStepNorm).toBe(0);
    expect(metrics.actorStateDecisionHeads).toBe(0);
    expect(metrics.actorStateTotalVariation).toBe(0);
    expect(metrics.actorStateGreedyAgreement).toBe(0);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
    const tensors = tf.memory().numTensors;
    instance.update(forcedRollout(), 0);
    expect(tf.memory().numTensors).toBe(tensors);
  });

  it('rejects non-finite normalization intermediates without leaking tensors', () => {
    const checkpoint = agent(42, { actorNormalization: 'layer' }).exportCheckpoint();
    checkpoint.weights[0].values.fill(0);
    checkpoint.weights[1].values = checkpoint.weights[1].values.map((_, index) => index % 2 ? 1e20 : -1e20);
    const instance = PPOAgent.fromCheckpoint(checkpoint);
    agents.push(instance);
    const tensors = tf.memory().numTensors;
    expect(() => instance.act(Array(6).fill(0), masks())).toThrow(/normalization/);
    expect(tf.memory().numTensors).toBe(tensors);
  });

  it('produces reproducible initialization, samples, joint log probability, and values', () => {
    const first = agent();
    const second = agent();
    const different = agent(43);
    expect(first.exportCheckpoint().weights).toEqual(second.exportCheckpoint().weights);
    expect(first.exportCheckpoint().weights).not.toEqual(different.exportCheckpoint().weights);
    const observation = [0.2, 0.5, -1, 0, 0.7, 0.3];
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const action = first.act(observation, masks());
      expect(action).toEqual(second.act(observation, masks()));
      expect(action.actions.slice(2)).toEqual(Array(6).fill(24));
      expect(action.logProbability).toBeCloseTo(2 * Math.log(0.25), 1);
      expect(action.value).toBe(first.value(observation));
    }
  });

  it('keeps deterministic inference from consuming sampling randomness', () => {
    const instance = agent();
    const before = instance.exportCheckpoint().randomState;
    const observation = [0, 0, 0, 0, 0, 0];
    expect(instance.act(observation, masks(), true)).toEqual(instance.act(observation, masks(), true));
    expect(instance.exportCheckpoint().randomState).toBe(before);
  });

  it('applies finite deterministic gradient updates to actor and critic weights', () => {
    const first = agent();
    const second = agent();
    const firstRollout = rollout(first);
    const secondRollout = rollout(second);
    const before = first.exportCheckpoint();
    const metrics = first.update(firstRollout, 0);
    const secondMetrics = second.update(secondRollout, 0);
    expect(metrics).toEqual(secondMetrics);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
    expect(metrics.samples).toBe(16);
    expect(metrics.updates).toBe(4);
    expect(metrics.entropy).toBeGreaterThan(0);
    expect(metrics.entropy).toBeLessThanOrEqual(2 * Math.log(4) + 1e-5);
    expect(metrics.gradientNorm).toBeGreaterThan(0);
    const after = first.exportCheckpoint();
    expect(after.weights).toEqual(second.exportCheckpoint().weights);
    expect(after.weights[4].values).not.toEqual(before.weights[4].values);
    expect(after.weights[10].values).not.toEqual(before.weights[10].values);
    expect(after.weights.every(weight => weight.values.every(Number.isFinite))).toBe(true);
  });

  it('learns a rewarded action instead of only changing arbitrary weights', () => {
    const instance = agent(52, { epochs: 4, learningRate: 0.01, entropyCoefficient: 0, minibatchSize: 64 });
    const observation = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const validActions = masks().map((mask, index) => index === 0 ? mask.map((_, action) => action === 0 || action === 1) : mask.map((_, action) => action === 24));
    for (let update = 0; update < 5; update += 1) {
      const transitions = Array.from({ length: 64 }, () => {
        const action = instance.act(observation, validActions);
        return { observation, masks: validActions, ...action, reward: action.actions[0] === 1 ? 1 : -1, terminated: true };
      });
      instance.update(transitions, 0);
    }
    const action = instance.act(observation, validActions, true);
    expect(action.actions[0]).toBe(1);
    expect(Math.exp(action.logProbability)).toBeGreaterThan(0.85);
  });

  it('matches independent joint PPO losses and finite-difference policy gradients', () => {
    const checkpoint = agent(71, { epochs: 1, minibatchSize: 4, entropyCoefficient: 0.03, maxGradientNorm: 0.05 }).exportCheckpoint();
    checkpoint.weights.forEach(weight => weight.values.fill(0));
    checkpoint.weights[5].values[1] = Math.fround(Math.log(3));
    checkpoint.weights[5].values[RL_ACTION_COUNT] = Math.fround(Math.log(2));
    const instance = PPOAgent.fromCheckpoint(checkpoint);
    agents.push(instance);
    const validActions = Array.from({ length: RL_MAX_DRONES }, (_, droneIndex) => Array.from({ length: RL_ACTION_COUNT }, (_, actionIndex) => droneIndex < 2 ? actionIndex < 2 : actionIndex === 24));
    const rewards = [-2, -1, 1, 2];
    const ratios = [0.6, 1.4, 0.6, 1.4];
    const outputIndices = [0, 1, RL_ACTION_COUNT, RL_ACTION_COUNT + 1];
    const initialBias = outputIndices.map(index => checkpoint.weights[5].values[index]);
    const distributions = (bias: number[]) => [bias.slice(0, 2), bias.slice(2)].map(logits => {
      const exponentials = logits.map(logit => Math.exp(logit));
      const total = exponentials.reduce((sum, value) => sum + value, 0);
      return exponentials.map(value => value / total);
    });
    const initialProbabilities = distributions(initialBias);
    const transitions: PPOTransition[] = rewards.map((reward, index) => {
      const actions = [Math.floor(index / 2), index % 2, ...Array(6).fill(24)];
      const currentLogProbability = Math.log(initialProbabilities[0][actions[0]]) + Math.log(initialProbabilities[1][actions[1]]);
      return {
        observation: Array(6).fill(0),
        masks: validActions,
        actions,
        reward,
        value: 0,
        logProbability: currentLogProbability - Math.log(ratios[index]),
        terminated: true,
      };
    });
    const reference = (bias: number[]) => {
      const probabilities = distributions(bias);
      const entropy = -probabilities.flat().reduce((sum, probability) => sum + probability * Math.log(probability), 0);
      let policyLoss = 0;
      let approximateKl = 0;
      let clipFraction = 0;
      for (const [index, transition] of transitions.entries()) {
        const selectedLog = Math.log(probabilities[0][transition.actions[0]]) + Math.log(probabilities[1][transition.actions[1]]);
        const ratio = Math.exp(selectedLog - transition.logProbability);
        const advantage = rewards[index] / (Math.sqrt(2.5) + 1e-8);
        policyLoss -= advantage * (advantage >= 0 ? Math.min(ratio, 1.2) : Math.max(ratio, 0.8)) / transitions.length;
        approximateKl += (transition.logProbability - selectedLog) / transitions.length;
        clipFraction += Number(Math.abs(ratio - 1) > 0.2) / transitions.length;
      }
      const valueLoss = 0.5 * rewards.reduce((sum, reward) => sum + reward * reward, 0) / rewards.length;
      return { policyLoss, valueLoss, entropy, approximateKl, clipFraction, loss: policyLoss + 0.5 * valueLoss - 0.03 * entropy };
    };
    const expected = reference(initialBias);
    const epsilon = 0.0001;
    const expectedGradients = initialBias.map((_, index) => {
      const plus = [...initialBias];
      const minus = [...initialBias];
      plus[index] += epsilon;
      minus[index] -= epsilon;
      return (reference(plus).loss - reference(minus).loss) / (2 * epsilon);
    });
    const metrics = instance.update(transitions, 0);
    for (const key of ['policyLoss', 'valueLoss', 'entropy', 'approximateKl', 'clipFraction'] as const) expect(metrics[key]).toBeCloseTo(expected[key], 5);
    expect(metrics.gradientNorm).toBeCloseTo(Math.hypot(...expectedGradients), 5);
    expect(metrics.gradientNorm).toBeGreaterThan(instance.options.maxGradientNorm);
    const updatedBias = instance.exportCheckpoint().weights[5].values;
    for (const [index, outputIndex] of outputIndices.entries()) {
      expect(Math.sign(updatedBias[outputIndex] - initialBias[index])).toBe(-Math.sign(expectedGradients[index]));
    }
  });

  it('round-trips policy weights and the sampling RNG through JSON', () => {
    const instance = agent();
    instance.update(rollout(instance), 0);
    const restored = PPOAgent.fromCheckpoint(JSON.parse(JSON.stringify(instance.exportCheckpoint())));
    agents.push(restored);
    const observation = [0.4, -0.2, 0.1, 0.9, 0.5, 0.3];
    expect(restored.act(observation, masks(), true)).toEqual(instance.act(observation, masks(), true));
    expect(restored.act(observation, masks())).toEqual(instance.act(observation, masks()));
    expect(restored.exportCheckpoint()).toEqual(instance.exportCheckpoint());
  });

  it('loads strict legacy dense checkpoints and preserves all version 5 options', () => {
    const original = agent(42).exportCheckpoint();
    const { rewardScale, gradientClipping, actorNormalization, actorArchitecture, criticNormalization, ...legacyOptions } = original.options;
    expect(rewardScale).toBe(1);
    expect(gradientClipping).toBe('global');
    expect(actorNormalization).toBe('none');
    expect(actorArchitecture).toBe('dense');
    expect(criticNormalization).toBe('none');
    const legacy = { ...original, version: 1, options: legacyOptions };
    const restoredLegacy = PPOAgent.fromCheckpoint(legacy);
    agents.push(restoredLegacy);
    expect(restoredLegacy.exportCheckpoint()).toEqual(original);
    const versionTwo = { ...original, version: 2, options: { ...legacyOptions, rewardScale: 0.001, gradientClipping: 'separate' } };
    const restoredTwo = PPOAgent.fromCheckpoint(versionTwo);
    agents.push(restoredTwo);
    expect(restoredTwo.options).toEqual({ ...versionTwo.options, actorNormalization: 'none', actorArchitecture: 'dense', criticNormalization: 'none' });
    const versionThree = { ...original, version: 3, options: { ...versionTwo.options, actorNormalization: 'layer' } };
    const restoredThree = PPOAgent.fromCheckpoint(versionThree);
    agents.push(restoredThree);
    expect(restoredThree.options).toEqual({ ...versionThree.options, actorArchitecture: 'dense', criticNormalization: 'none' });
    const versionFour = { ...original, version: 4, options: { ...versionThree.options, actorArchitecture: 'dense' } };
    const restoredFour = PPOAgent.fromCheckpoint(versionFour);
    agents.push(restoredFour);
    expect(restoredFour.options).toEqual({ ...versionFour.options, criticNormalization: 'none' });
    const scaled = agent(42, { rewardScale: 0.001, gradientClipping: 'separate', actorNormalization: 'layer', criticNormalization: 'layer' });
    scaled.update(rollout(scaled), 0);
    const checkpoint = scaled.exportCheckpoint();
    const restored = PPOAgent.fromCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    agents.push(restored);
    expect(restored.exportCheckpoint()).toEqual(checkpoint);
    expect(restored.act(Array(6).fill(0), masks())).toEqual(scaled.act(Array(6).fill(0), masks()));
    const tensors = tf.memory().numTensors;
    for (const malformed of [
      { ...original, version: 1 },
      { ...original, options: legacyOptions },
      { ...legacy, options: { ...legacyOptions, rewardScale: 1 } },
      { ...legacy, options: { ...legacyOptions, gradientClipping: 'global' } },
      { ...original, version: 2 },
      { ...original, version: 3 },
      { ...original, version: 4 },
      { ...original, options: versionTwo.options },
      { ...versionTwo, options: legacyOptions },
      { ...original, options: { ...original.options, actorNormalization: 'batch' } },
      { ...original, options: { ...original.options, criticNormalization: 'batch' } },
      { ...original, options: versionFour.options },
      { ...versionFour, options: { ...versionFour.options, actorArchitecture: 'autoregressive' } },
      { ...original, options: { ...original.options, actorArchitecture: 'unknown' } },
      { ...original, options: { ...original.options, future: true } },
    ]) {
      expect(() => PPOAgent.fromCheckpoint(malformed)).toThrow(/options|architecture/);
      expect(tf.memory().numTensors).toBe(tensors);
    }
  });

  it('rejects invalid scale/clipping settings and raw or scaled reward overflow before tensor allocation', () => {
    const tensors = tf.memory().numTensors;
    for (const rewardScale of [0, -1, 1e-9, 1e9, NaN, Infinity]) {
      expect(() => new PPOAgent(6, 42, { rewardScale })).toThrow(/option/);
      expect(tf.memory().numTensors).toBe(tensors);
    }
    expect(() => new PPOAgent(6, 42, { gradientClipping: 'unknown' as 'global' })).toThrow(/option/);
    expect(() => new PPOAgent(6, 42, { actorNormalization: 'unknown' as 'none' })).toThrow(/option/);
    expect(() => new PPOAgent(6, 42, { criticNormalization: 'unknown' as 'none' })).toThrow(/option/);
    expect(() => new PPOAgent(6, 42, { actorArchitecture: 'unknown' as 'dense' })).toThrow(/option/);
    expect(() => new PPOAgent(6, 42, { actorArchitecture: 'shared' })).toThrow(/schema/);
    expect(tf.memory().numTensors).toBe(tensors);
    const instance = agent(42, { rewardScale: 1e8 });
    const transitions = rollout(instance, 1);
    const allocated = tf.memory().numTensors;
    for (const reward of [NaN, Infinity, 1e38, '1' as unknown as number]) {
      transitions[0].reward = reward;
      expect(() => instance.update(transitions, 0)).toThrow();
      expect(tf.memory().numTensors).toBe(allocated);
    }
  });

  it('rejects invalid observations, masks, transitions, and hyperparameters', () => {
    const instance = agent();
    expect(() => instance.act([0], masks())).toThrow(/observation/);
    expect(() => instance.value([NaN, 0, 0, 0, 0, 0])).toThrow(/observation/);
    expect(() => instance.act(Array(6).fill(0), [Array(27).fill(false)])).toThrow(/masks/);
    const invalidMask = masks();
    invalidMask[0].fill(false);
    expect(() => instance.act(Array(6).fill(0), invalidMask)).toThrow(/masks/);
    const transitions = rollout(instance);
    transitions[0].actions[2] = 0;
    expect(() => instance.update(transitions, 0)).toThrow(/action/);
    expect(() => instance.update([], 0)).toThrow(/transitions/);
    expect(() => new PPOAgent(0, 42)).toThrow(/size/);
    expect(() => new PPOAgent(6, -1)).toThrow(/seed/);
    expect(() => new PPOAgent(6, 42, { clipRatio: 1 })).toThrow(/range/);
    expect(() => new PPOAgent(6, 42, { epochs: 1.5 })).toThrow(/range/);
  });

  it('rejects incompatible, malformed, extra, and non-finite checkpoint fields before allocating tensors', () => {
    const checkpoint = agent().exportCheckpoint();
    const cases: Array<(value: PPOCheckpoint) => void> = [
      value => { value.version = 6 as 5; },
      value => { value.actionCount = 28; },
      value => { value.maxDrones = 7; },
      value => { value.observationSize = -1; },
      value => { value.hiddenSizes[0] = 999; },
      value => { value.randomState = -1; },
      value => { value.options.learningRate = NaN; },
      value => { value.weights.pop(); },
      value => { value.weights[0].shape[0] += 1; },
      value => { value.weights[0].name = 'unexpected'; },
      value => { value.weights[0].values.pop(); },
      value => { value.weights[0].values[0] = Infinity; },
      value => { value.weights[0].values[0] = 1e300; },
      value => { delete value.weights[0].values[0]; },
      value => { delete value.weights[0].shape[0]; },
      value => { Object.assign(value, { future: true }); },
      value => { Object.assign(value.weights[0], { future: true }); },
    ];
    const tensors = tf.memory().numTensors;
    for (const corrupt of cases) {
      const malformed = structuredClone(checkpoint);
      corrupt(malformed);
      expect(() => PPOAgent.fromCheckpoint(malformed)).toThrow();
      expect(tf.memory().numTensors).toBe(tensors);
    }
    for (const malformed of [null, {}, [], { ...checkpoint, options: null }]) expect(() => PPOAgent.fromCheckpoint(malformed)).toThrow();
  });

  it('releases inference, gradient, and optimizer tensors after disposal', () => {
    const before = tf.memory().numTensors;
    const instance = agent();
    const transitions = rollout(instance);
    instance.update(transitions, 0);
    const trained = tf.memory().numTensors;
    for (let iteration = 0; iteration < 5; iteration += 1) instance.act(transitions[0].observation, masks());
    expect(tf.memory().numTensors).toBe(trained);
    instance.update(rollout(instance), 0);
    expect(tf.memory().numTensors).toBe(trained);
    instance.dispose();
    expect(tf.memory().numTensors).toBe(before);
    expect(() => instance.act(Array(6).fill(0), masks())).toThrow(/disposed/);
    expect(() => instance.exportCheckpoint()).toThrow(/disposed/);
  });
});
