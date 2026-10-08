import { afterEach, describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { COORDINATED_ACTOR_FEATURE_SIZE, coordinatedActorFeatures } from './patrol-rl-coordination';
import { RL_ACTION_COUNT, RL_DRONE_FEATURES, RL_GRID_CHANNELS, RL_GRID_SIZE,
  RL_HOVER_ACTION, RL_MAX_DRONES, RL_OBSERVATION_SIZE } from './patrol-rl-contract';
import { PPOAgent, maskedCategorical } from './patrol-rl-network';
import type { PPOOptions, PPOTransition } from './patrol-rl-network';

const agents: PPOAgent[] = [];
const DRONE_OFFSET = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS;
const GLOBAL_OFFSET = DRONE_OFFSET + RL_MAX_DRONES * RL_DRONE_FEATURES;

function agent(seed = 42, options: Partial<PPOOptions> = {}): PPOAgent {
  const instance = new PPOAgent(RL_OBSERVATION_SIZE, seed, { actorArchitecture: 'autoregressive',
    epochs: 2, minibatchSize: 8, ...options });
  agents.push(instance);
  return instance;
}

function observation(): number[] {
  const values = Array<number>(RL_OBSERVATION_SIZE).fill(0);
  for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) {
    values.splice(cell * RL_GRID_CHANNELS, RL_GRID_CHANNELS, 1, 0.5, 0.5, 0.5, 1);
  }
  for (let slot = 0; slot < 2; slot += 1) {
    values.splice(DRONE_OFFSET + slot * RL_DRONE_FEATURES, RL_DRONE_FEATURES,
      1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1);
  }
  values.splice(GLOBAL_OFFSET, 18, 0.5, 0.5, 0, 16 / 30, 0.5, 1, 300 / 1800,
    90 / 1800, 0.2, 0.25, 0, 0, 0.95, 120 / 3600, 15 / 120, 0.08, 0.08, 2 / 8);
  return values;
}

function masks(): boolean[][] {
  return Array.from({ length: RL_MAX_DRONES }, (_, slot) => Array.from({ length: RL_ACTION_COUNT },
    (_, action) => slot < 2 ? action === 2 || action === 14 : action === RL_HOVER_ACTION));
}

function conditionalLogits(instance: PPOAgent, observations: number[][], actions: number[][]): number[][] {
  const implementation = instance as unknown as {
    forward: (inputs: tf.Tensor2D, offset: number, actorInputs: tf.Tensor2D) => tf.Tensor2D;
  };
  return tf.tidy(() => {
    const rows = RL_MAX_DRONES * RL_ACTION_COUNT;
    const flattened = new Float32Array(observations.length * rows * COORDINATED_ACTOR_FEATURE_SIZE);
    observations.forEach((state, index) => flattened.set(coordinatedActorFeatures(state, actions[index]), index * rows * COORDINATED_ACTOR_FEATURE_SIZE));
    const inputs = tf.tensor2d(flattened, [observations.length * rows, COORDINATED_ACTOR_FEATURE_SIZE]);
    return implementation.forward(tf.tensor2d(observations), 0, inputs).arraySync() as number[][];
  });
}

function prescribedPolicy(): PPOAgent {
  const checkpoint = agent().exportCheckpoint();
  checkpoint.weights.slice(0, 6).forEach(weight => weight.values.fill(0));
  checkpoint.weights[0].values[75 * 32] = 1;
  checkpoint.weights[2].values[0] = 1;
  checkpoint.weights[4].values[0] = -5;
  const instance = PPOAgent.fromCheckpoint(checkpoint);
  agents.push(instance);
  return instance;
}

afterEach(() => agents.splice(0).forEach(instance => instance.dispose()));

describe('autoregressive PPO coordination', () => {
  it.each(['none', 'layer'] as const)('reconstructs sampled and greedy joint log probabilities with %s actor normalization', actorNormalization => {
    const instance = agent(101, { actorNormalization });
    const state = observation();
    const available = masks();
    for (const deterministic of [false, false, true]) {
      const selected = instance.act(state, available, deterministic);
      const replay = conditionalLogits(instance, [state], [selected.actions])[0];
      let jointLogProbability = 0;
      for (let slot = 0; slot < RL_MAX_DRONES; slot += 1) {
        const distribution = maskedCategorical(replay.slice(slot * RL_ACTION_COUNT, (slot + 1) * RL_ACTION_COUNT), available[slot]);
        jointLogProbability += distribution.logProbabilities[selected.actions[slot]];
        expect(available[slot][selected.actions[slot]]).toBe(true);
      }
      expect(selected.logProbability).toBeCloseTo(jointLogProbability, 7);
      expect(selected.value).toBe(instance.value(state));
      expect(selected.actions.slice(2)).toEqual(Array(6).fill(RL_HOVER_ACTION));
    }
  });

  it('changes later distributions when a preceding actual choice changes, without changing the first distribution', () => {
    const instance = prescribedPolicy();
    const state = observation();
    const east = [2, 2, ...Array<number>(6).fill(RL_HOVER_ACTION)];
    const west = [14, 2, ...Array<number>(6).fill(RL_HOVER_ACTION)];
    const [eastLogits, westLogits] = conditionalLogits(instance, [state, state], [east, west]);
    expect(eastLogits.slice(0, RL_ACTION_COUNT)).toEqual(westLogits.slice(0, RL_ACTION_COUNT));
    const eastConditional = maskedCategorical(eastLogits.slice(RL_ACTION_COUNT, 2 * RL_ACTION_COUNT), masks()[1]);
    const westConditional = maskedCategorical(westLogits.slice(RL_ACTION_COUNT, 2 * RL_ACTION_COUNT), masks()[1]);
    expect(eastConditional.probabilities[14]).toBeGreaterThan(0.9);
    expect(westConditional.probabilities[2]).toBeGreaterThan(0.9);
    expect(instance.act(state, masks(), true).actions.slice(0, 2)).toEqual([2, 14]);
    const forced = masks();
    forced[0][2] = false;
    expect(instance.act(state, forced, true).actions.slice(0, 2)).toEqual([14, 2]);
  });

  it('evaluates teacher-forced states independently of batch composition and updates from the matching joint probability', () => {
    const instance = agent(73, { epochs: 1, minibatchSize: 8 });
    const state = observation();
    const changed = [...state];
    changed[DRONE_OFFSET + 1] = -0.5;
    const states = [state, changed];
    const available = masks();
    const selected = states.map(current => instance.act(current, available));
    const joint = conditionalLogits(instance, states, selected.map(action => action.actions));
    states.forEach((current, index) => expect(joint[index]).toEqual(conditionalLogits(instance, [current], [selected[index].actions])[0]));
    const transitions = selected.map((action, index) => ({ observation: states[index], masks: available,
      ...action, reward: index ? 1 : -1, terminated: true }));
    const metrics = instance.update(transitions, 0);
    expect(Math.abs(metrics.approximateKl)).toBeLessThan(1e-6);
    expect(metrics.clipFraction).toBe(0);
    expect(metrics.actorGradientNorm).toBeGreaterThan(0);
    expect(metrics.actorParameterStepNorm).toBeGreaterThan(0);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
  });

  it('learns conditional anti-coordination for two otherwise indistinguishable drones', () => {
    const instance = agent(52, { learningRate: 0.01, epochs: 4, minibatchSize: 32,
      valueCoefficient: 0, entropyCoefficient: 0.01, gradientClipping: 'separate' });
    const state = observation();
    const available = masks();
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const transitions: PPOTransition[] = Array.from({ length: 32 }, () => {
        const selected = instance.act(state, available);
        return { observation: state, masks: available, ...selected,
          reward: selected.actions[0] !== selected.actions[1] ? 1 : -1, terminated: true };
      });
      instance.update(transitions, 0);
    }
    const prefixes = [[2, 2, ...Array<number>(6).fill(RL_HOVER_ACTION)], [14, 2, ...Array<number>(6).fill(RL_HOVER_ACTION)]];
    const logits = conditionalLogits(instance, [state, state], prefixes);
    for (const [index, expected] of [14, 2].entries()) {
      const conditional = maskedCategorical(logits[index].slice(RL_ACTION_COUNT, 2 * RL_ACTION_COUNT), available[1]);
      expect(conditional.probabilities[expected]).toBeGreaterThan(0.85);
    }
    const selected = instance.act(state, available, true);
    expect(selected.actions[0]).not.toBe(selected.actions[1]);
    const restored = PPOAgent.fromCheckpoint(JSON.parse(JSON.stringify(instance.exportCheckpoint())));
    agents.push(restored);
    expect(restored.act(state, available, true)).toEqual(selected);
    expect(conditionalLogits(restored, [state, state], prefixes)).toEqual(logits);
  }, 30000);

  it('preserves the dense and shared control critic initialization and random draw count', () => {
    const dense = agent(73, { actorArchitecture: 'dense', rewardScale: 0.001 });
    const shared = agent(73, { actorArchitecture: 'shared', rewardScale: 0.001 });
    const coordinated = agent(73, { rewardScale: 0.001 });
    const replacement = coordinated.exportCheckpoint();
    expect(replacement.weights[0].shape).toEqual([80, 32]);
    expect(replacement.weights[4].shape).toEqual([32, 1]);
    for (const control of [dense, shared]) {
      expect(replacement.weights.slice(6)).toEqual(control.exportCheckpoint().weights.slice(6));
      expect(replacement.randomState).toBe(control.exportCheckpoint().randomState);
      expect(coordinated.value(observation())).toBe(control.value(observation()));
      control.act(observation(), masks());
    }
    coordinated.act(observation(), masks());
    expect(coordinated.exportCheckpoint().randomState).toBe(dense.exportCheckpoint().randomState);
    expect(coordinated.exportCheckpoint().randomState).toBe(shared.exportCheckpoint().randomState);
  });

  it('does not retain incremental feature, gradient or optimizer tensors across repeated rollouts and updates', () => {
    const before = tf.memory().numTensors;
    const instance = agent(42, { actorNormalization: 'layer', criticNormalization: 'layer', rewardScale: 0.001 });
    const state = observation();
    const available = masks();
    const rollout = () => Array.from({ length: 8 }, (_, index) => ({ observation: state, masks: available,
      ...instance.act(state, available), reward: index, terminated: true }));
    instance.update(rollout(), 0);
    const allocated = tf.memory().numTensors;
    instance.update(rollout(), 0);
    expect(tf.memory().numTensors).toBe(allocated);
    instance.act(state, available, true);
    expect(tf.memory().numTensors).toBe(allocated);
    instance.dispose();
    expect(tf.memory().numTensors).toBe(before);
  });
});
