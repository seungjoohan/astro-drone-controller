import * as tf from '@tensorflow/tfjs';
import { RL_ACTION_COUNT, RL_MAX_DRONES, RL_OBSERVATION_SIZE } from './patrol-rl-contract';
import { SHARED_ACTOR_FEATURE_SIZE, sharedActorFeatures } from './patrol-rl-shared-features';
import { COORDINATED_ACTOR_FEATURE_SIZE, coordinatedActorFeatures, createCoordinatedActorContext } from './patrol-rl-coordination';

export { RL_ACTION_COUNT, RL_MAX_DRONES } from './patrol-rl-contract';

const HIDDEN_SIZES = [32, 32] as const;
const ACTOR_NORMALIZATION_EPSILON = 1e-5;

export interface PPOOptions {
  gamma: number;
  gaeLambda: number;
  clipRatio: number;
  learningRate: number;
  epochs: number;
  minibatchSize: number;
  valueCoefficient: number;
  entropyCoefficient: number;
  maxGradientNorm: number;
  rewardScale: number;
  gradientClipping: 'global' | 'separate';
  actorNormalization: 'none' | 'layer';
  actorArchitecture: 'dense' | 'shared' | 'autoregressive';
  criticNormalization: 'none' | 'layer';
}

export const DEFAULT_PPO_OPTIONS: Readonly<PPOOptions> = Object.freeze({
  gamma: 0.99,
  gaeLambda: 0.95,
  clipRatio: 0.2,
  learningRate: 0.0003,
  epochs: 4,
  minibatchSize: 64,
  valueCoefficient: 0.5,
  entropyCoefficient: 0.01,
  maxGradientNorm: 0.5,
  rewardScale: 1,
  gradientClipping: 'global',
  actorNormalization: 'none',
  actorArchitecture: 'dense',
  criticNormalization: 'none',
});

export interface PPOTransition {
  observation: number[];
  masks: boolean[][];
  actions: number[];
  logProbability: number;
  value: number;
  reward: number;
  terminated: boolean;
  truncated?: boolean;
  nextValue?: number;
}

export interface PPOAction {
  actions: number[];
  logProbability: number;
  value: number;
}

export interface PPOUpdateMetrics {
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  approximateKl: number;
  clipFraction: number;
  gradientNorm: number;
  normalizedEntropy: number;
  actorGradientNorm: number;
  criticGradientNorm: number;
  actorClippedGradientNorm: number;
  criticClippedGradientNorm: number;
  actorParameterStepNorm: number;
  criticParameterStepNorm: number;
  rewardRawMean: number;
  rewardRawMin: number;
  rewardRawMax: number;
  rewardScaledMean: number;
  rewardScaledMin: number;
  rewardScaledMax: number;
  returnMean: number;
  returnMin: number;
  returnMax: number;
  returnStddev: number;
  valueMean: number;
  valueMin: number;
  valueMax: number;
  valueStddev: number;
  criticExplainedVariance: number;
  criticExplainedVarianceValid: number;
  criticRmse: number;
  criticHidden1Saturation: number;
  criticHidden2Saturation: number;
  actorHidden1PreactivationAbsMean: number;
  actorHidden1Saturation: number;
  actorHidden2Saturation: number;
  actorStateTotalVariation: number;
  actorStateGreedyAgreement: number;
  actorStateDecisionHeads: number;
  updates: number;
  samples: number;
}

interface WeightRecord {
  name: string;
  shape: number[];
  values: number[];
}

export interface PPOCheckpoint {
  format: 'astro-patrol-ppo';
  version: 5;
  observationSize: number;
  actionCount: number;
  maxDrones: number;
  hiddenSizes: number[];
  seed: number;
  randomState: number;
  options: PPOOptions;
  weights: WeightRecord[];
}

interface AdvantageTransition {
  value: number;
  reward: number;
  terminated: boolean;
  truncated?: boolean;
  nextValue?: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateOptions(options: PPOOptions): void {
  if (!record(options) || !exactKeys(options, Object.keys(DEFAULT_PPO_OPTIONS))) throw new Error('Invalid PPO options');
  for (const [key, value] of Object.entries(options)) {
    if (key === 'gradientClipping' || key === 'actorNormalization' || key === 'actorArchitecture' || key === 'criticNormalization') continue;
    if (!finite(value)) throw new Error(`Invalid PPO option: ${key}`);
  }
  if (options.gamma < 0 || options.gamma > 1 || options.gaeLambda < 0 || options.gaeLambda > 1
    || options.clipRatio <= 0 || options.clipRatio >= 1 || options.learningRate <= 0 || options.learningRate > 1
    || !Number.isInteger(options.epochs) || options.epochs < 1 || options.epochs > 100
    || !Number.isInteger(options.minibatchSize) || options.minibatchSize < 1 || options.minibatchSize > 65536
    || options.valueCoefficient < 0 || options.entropyCoefficient < 0 || options.maxGradientNorm <= 0
    || options.rewardScale < 1e-8 || options.rewardScale > 1e8
    || !['global', 'separate'].includes(options.gradientClipping)
    || !['none', 'layer'].includes(options.actorNormalization)
    || !['dense', 'shared', 'autoregressive'].includes(options.actorArchitecture)
    || !['none', 'layer'].includes(options.criticNormalization)) {
    throw new Error('PPO options are out of range');
  }
}

const BATCH_METRIC_KEYS = [
  'policyLoss', 'valueLoss', 'entropy', 'approximateKl', 'clipFraction', 'gradientNorm',
  'normalizedEntropy', 'actorGradientNorm', 'criticGradientNorm', 'actorClippedGradientNorm', 'criticClippedGradientNorm',
] as const;

type PPOBatchMetrics = Pick<PPOUpdateMetrics, typeof BATCH_METRIC_KEYS[number]>;

function distributionStats(values: readonly number[]): { mean: number; min: number; max: number; variance: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    min: values.reduce((minimum, value) => Math.min(minimum, value), Infinity),
    max: values.reduce((maximum, value) => Math.max(maximum, value), -Infinity),
    variance: values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  };
}

export function calculateGAE(
  transitions: readonly AdvantageTransition[],
  bootstrapValue: number,
  gamma = DEFAULT_PPO_OPTIONS.gamma,
  gaeLambda = DEFAULT_PPO_OPTIONS.gaeLambda,
): { advantages: number[]; returns: number[] } {
  if (![bootstrapValue, gamma, gaeLambda].every(finite) || gamma < 0 || gamma > 1 || gaeLambda < 0 || gaeLambda > 1) {
    throw new Error('Invalid GAE parameters');
  }
  const advantages = new Array<number>(transitions.length);
  const returns = new Array<number>(transitions.length);
  let followingAdvantage = 0;
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (!finite(transition.value) || !finite(transition.reward) || typeof transition.terminated !== 'boolean'
      || (transition.truncated !== undefined && typeof transition.truncated !== 'boolean')
      || (transition.nextValue !== undefined && !finite(transition.nextValue))
      || (transition.truncated && !transition.terminated && transition.nextValue === undefined)) {
      throw new Error('Invalid GAE transition or missing truncation bootstrap');
    }
    const nextValue = transition.terminated ? 0 : transition.nextValue ?? transitions[index + 1]?.value ?? bootstrapValue;
    const delta = transition.reward + gamma * nextValue - transition.value;
    const continuation = transition.terminated || transition.truncated ? 0 : 1;
    followingAdvantage = delta + gamma * gaeLambda * continuation * followingAdvantage;
    advantages[index] = followingAdvantage;
    returns[index] = followingAdvantage + transition.value;
    if (!finite(advantages[index]) || !finite(returns[index])) throw new Error('GAE overflow');
  }
  return { advantages, returns };
}

export function clippedSurrogate(advantage: number, ratio: number, clipRatio = DEFAULT_PPO_OPTIONS.clipRatio): number {
  if (![advantage, ratio, clipRatio].every(finite) || ratio < 0 || clipRatio <= 0 || clipRatio >= 1) {
    throw new Error('Invalid clipped surrogate inputs');
  }
  return Math.min(advantage * ratio, advantage * Math.max(1 - clipRatio, Math.min(1 + clipRatio, ratio)));
}

export function maskedCategorical(logits: readonly number[], mask: readonly boolean[]): {
  probabilities: number[];
  logProbabilities: number[];
  entropy: number;
} {
  if (logits.length === 0 || logits.length !== mask.length || !Array.from(logits).every(finite)
    || !Array.from(mask).every(valid => typeof valid === 'boolean') || !mask.some(Boolean)) {
    throw new Error('Invalid categorical logits or mask');
  }
  const maximum = Math.max(...logits.filter((_, index) => mask[index]));
  const exponentials = logits.map((value, index) => mask[index] ? Math.exp(value - maximum) : 0);
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  const probabilities = exponentials.map(value => value / total);
  const logProbabilities = logits.map((value, index) => mask[index] ? value - maximum - Math.log(total) : -Infinity);
  const entropy = probabilities.reduce((sum, probability, index) => probability > 0 ? sum - probability * logProbabilities[index] : sum, 0);
  return { probabilities, logProbabilities, entropy };
}

function weightShapes(observationSize: number, actorArchitecture: PPOOptions['actorArchitecture']): { name: string; shape: number[] }[] {
  const actorInputSize = actorArchitecture === 'autoregressive' ? COORDINATED_ACTOR_FEATURE_SIZE
    : actorArchitecture === 'shared' ? SHARED_ACTOR_FEATURE_SIZE : observationSize;
  return ['actor', 'critic'].flatMap(network => [
    { name: `${network}.hidden1.kernel`, shape: [network === 'actor' ? actorInputSize : observationSize, HIDDEN_SIZES[0]] },
    { name: `${network}.hidden1.bias`, shape: [HIDDEN_SIZES[0]] },
    { name: `${network}.hidden2.kernel`, shape: [HIDDEN_SIZES[0], HIDDEN_SIZES[1]] },
    { name: `${network}.hidden2.bias`, shape: [HIDDEN_SIZES[1]] },
    { name: `${network}.output.kernel`, shape: [HIDDEN_SIZES[1], network === 'actor' && actorArchitecture === 'dense' ? RL_MAX_DRONES * RL_ACTION_COUNT : 1] },
    { name: `${network}.output.bias`, shape: [network === 'actor' && actorArchitecture === 'dense' ? RL_MAX_DRONES * RL_ACTION_COUNT : 1] },
  ]);
}

function validateObservationSize(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 16384) throw new Error('Invalid observation size');
}

function validateSeed(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) throw new Error('Invalid PPO seed');
}

export class PPOAgent {
  readonly observationSize: number;
  readonly seed: number;
  readonly options: Readonly<PPOOptions>;
  private randomState: number;
  private readonly weights: tf.Variable[];
  private readonly optimizer: tf.AdamOptimizer;
  private disposed = false;

  constructor(observationSize: number, seed: number, options: Partial<PPOOptions> = {}) {
    validateObservationSize(observationSize);
    validateSeed(seed);
    this.observationSize = observationSize;
    this.seed = seed;
    this.randomState = seed;
    this.options = Object.freeze({ ...DEFAULT_PPO_OPTIONS, ...options });
    validateOptions(this.options);
    if (this.options.actorArchitecture !== 'dense' && observationSize !== RL_OBSERVATION_SIZE) throw new Error('Shared actor requires the patrol observation schema');
    this.weights = weightShapes(observationSize, this.options.actorArchitecture).map(({ shape, name }, index) => {
      if (index === 6 && this.options.actorArchitecture !== 'dense') {
        this.randomState = seed;
        const legacyActorDraws = observationSize * HIDDEN_SIZES[0] + HIDDEN_SIZES[0] * HIDDEN_SIZES[1]
          + HIDDEN_SIZES[1] * RL_MAX_DRONES * RL_ACTION_COUNT;
        for (let draw = 0; draw < legacyActorDraws; draw += 1) this.random();
      }
      const size = shape.reduce((product, dimension) => product * dimension, 1);
      const bound = shape.length === 2 ? Math.sqrt(6 / (shape[0] + shape[1])) : 0;
      const outputScale = name === 'actor.output.kernel' ? 0.01 : name.startsWith('critic.output.') ? this.options.rewardScale : 1;
      const values = Array.from({ length: size }, () => bound === 0 ? 0 : (this.random() * 2 - 1) * bound * outputScale);
      return tf.tidy(() => tf.variable(tf.tensor(values, shape, 'float32')));
    });
    this.optimizer = tf.train.adam(this.options.learningRate);
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }

  private checkActive(): void {
    if (this.disposed) throw new Error('PPO agent is disposed');
  }

  private validateObservation(observation: number[]): void {
    if (!Array.isArray(observation) || observation.length !== this.observationSize || !Array.from(observation).every(finite)) {
      throw new Error('Invalid PPO observation');
    }
  }

  private validateMasks(masks: boolean[][]): void {
    if (!Array.isArray(masks) || masks.length !== RL_MAX_DRONES || !Array.from(masks).every(mask => Array.isArray(mask)
      && mask.length === RL_ACTION_COUNT && Array.from(mask).every(valid => typeof valid === 'boolean') && mask.some(Boolean))) {
      throw new Error('Invalid PPO action masks');
    }
  }

  private sharedInputs(features: readonly Float32Array[]): tf.Tensor2D {
    const featureSize = this.options.actorArchitecture === 'autoregressive' ? COORDINATED_ACTOR_FEATURE_SIZE : SHARED_ACTOR_FEATURE_SIZE;
    const width = RL_MAX_DRONES * RL_ACTION_COUNT * featureSize;
    const flattened = new Float32Array(features.length * width);
    features.forEach((values, index) => flattened.set(values, index * width));
    return tf.tensor2d(flattened, [features.length * RL_MAX_DRONES * RL_ACTION_COUNT, featureSize]);
  }

  private hiddenLayers(observations: tf.Tensor2D, offset: number, sharedInputs?: tf.Tensor2D): { preactivation: tf.Tensor2D; first: tf.Tensor2D; second: tf.Tensor2D } {
    if (offset === 0 && this.options.actorArchitecture === 'autoregressive' && !sharedInputs) throw new Error('Autoregressive actor requires conditional features');
    const inputs = offset === 0 && this.options.actorArchitecture !== 'dense'
      ? sharedInputs ?? this.sharedInputs((observations.arraySync() as number[][]).map(sharedActorFeatures)) : observations;
    const preactivation = tf.add(tf.matMul(inputs, this.weights[offset]), this.weights[offset + 1]) as tf.Tensor2D;
    let normalized = preactivation;
    if (offset === 0 && this.options.actorNormalization === 'layer' || offset === 6 && this.options.criticNormalization === 'layer') {
      const centered = tf.sub(preactivation, tf.mean(preactivation, 1, true));
      const variance = tf.mean(tf.square(centered), 1, true);
      if (!Array.from(variance.dataSync()).every(finite)) throw new Error('Non-finite network normalization variance');
      normalized = tf.div(centered, tf.sqrt(tf.add(variance, ACTOR_NORMALIZATION_EPSILON))) as tf.Tensor2D;
    }
    const first = tf.tanh(normalized) as tf.Tensor2D;
    const second = tf.tanh(tf.add(tf.matMul(first as tf.Tensor2D, this.weights[offset + 2]), this.weights[offset + 3]));
    return { preactivation, first, second: second as tf.Tensor2D };
  }

  private forward(observations: tf.Tensor2D, offset: number, sharedInputs?: tf.Tensor2D): tf.Tensor2D {
    const { second } = this.hiddenLayers(observations, offset, sharedInputs);
    const output = tf.add(tf.matMul(second as tf.Tensor2D, this.weights[offset + 4]), this.weights[offset + 5]) as tf.Tensor2D;
    return offset === 0 && this.options.actorArchitecture !== 'dense'
      ? output.reshape([observations.shape[0], RL_MAX_DRONES * RL_ACTION_COUNT]) : output;
  }

  act(observation: number[], masks: boolean[][], deterministic = false): PPOAction {
    this.checkActive();
    this.validateObservation(observation);
    this.validateMasks(masks);
    if (this.options.actorArchitecture === 'autoregressive') return this.actAutoregressive(observation, masks, deterministic);
    return tf.tidy(() => {
      const observations = tf.tensor2d([observation], [1, this.observationSize]);
      const logits = Array.from(this.forward(observations, 0).dataSync());
      const value = this.forward(observations, 6).dataSync()[0];
      if (!finite(value)) throw new Error('Non-finite PPO value');
      let logProbability = 0;
      const actions = masks.map((mask, droneIndex) => {
        const distribution = maskedCategorical(logits.slice(droneIndex * RL_ACTION_COUNT, (droneIndex + 1) * RL_ACTION_COUNT), mask);
        let action = mask.findIndex(Boolean);
        if (deterministic) {
          for (let index = action + 1; index < RL_ACTION_COUNT; index += 1) {
            if (distribution.probabilities[index] > distribution.probabilities[action]) action = index;
          }
        } else {
          const sample = this.random();
          let cumulative = 0;
          for (let index = 0; index < RL_ACTION_COUNT; index += 1) {
            if (!mask[index]) continue;
            action = index;
            cumulative += distribution.probabilities[index];
            if (sample < cumulative) break;
          }
        }
        logProbability += distribution.logProbabilities[action];
        return action;
      });
      return { actions, logProbability, value };
    });
  }

  private actAutoregressive(observation: number[], masks: boolean[][], deterministic: boolean): PPOAction {
    const context = createCoordinatedActorContext(observation);
    return tf.tidy(() => {
      const observations = tf.tensor2d([observation], [1, this.observationSize]);
      const value = this.forward(observations, 6).dataSync()[0];
      if (!finite(value)) throw new Error('Non-finite PPO value');
      const actions = Array<number>(RL_MAX_DRONES).fill(-1);
      let logProbability = 0;
      for (const slot of context.order) {
        const inputs = tf.tensor2d(context.features(slot, actions), [RL_ACTION_COUNT, COORDINATED_ACTOR_FEATURE_SIZE]);
        const { second } = this.hiddenLayers(observations, 0, inputs);
        const logits = Array.from(tf.add(tf.matMul(second, this.weights[4]), this.weights[5]).dataSync());
        const mask = masks[slot];
        const distribution = maskedCategorical(logits, mask);
        let action = mask.findIndex(Boolean);
        if (deterministic) {
          for (let index = action + 1; index < RL_ACTION_COUNT; index += 1) {
            if (distribution.probabilities[index] > distribution.probabilities[action]) action = index;
          }
        } else {
          const sample = this.random();
          let cumulative = 0;
          for (let index = 0; index < RL_ACTION_COUNT; index += 1) {
            if (!mask[index]) continue;
            action = index;
            cumulative += distribution.probabilities[index];
            if (sample < cumulative) break;
          }
        }
        actions[slot] = action;
        logProbability += distribution.logProbabilities[action];
      }
      return { actions, logProbability, value };
    });
  }

  value(observation: number[]): number {
    this.checkActive();
    this.validateObservation(observation);
    const value = tf.tidy(() => this.forward(tf.tensor2d([observation], [1, this.observationSize]), 6).dataSync()[0]);
    if (!finite(value)) throw new Error('Non-finite PPO value');
    return value;
  }

  private criticDiagnostics(transitions: PPOTransition[]): { values: number[]; firstSaturation: number; secondSaturation: number } {
    const values: number[] = [];
    let firstSaturated = 0;
    let secondSaturated = 0;
    for (let start = 0; start < transitions.length; start += 256) {
      const batch = transitions.slice(start, start + 256);
      tf.tidy(() => {
        const observations = tf.tensor2d(batch.map(transition => transition.observation), [batch.length, this.observationSize]);
        const { first, second } = this.hiddenLayers(observations, 6);
        values.push(...tf.add(tf.matMul(second, this.weights[10]), this.weights[11]).dataSync());
        firstSaturated += tf.sum(tf.cast(tf.greaterEqual(tf.abs(first), 0.99), 'float32')).dataSync()[0];
        secondSaturated += tf.sum(tf.cast(tf.greaterEqual(tf.abs(second), 0.99), 'float32')).dataSync()[0];
      });
    }
    if (!values.every(finite)) throw new Error('Non-finite PPO critic diagnostics');
    return {
      values,
      firstSaturation: firstSaturated / (transitions.length * HIDDEN_SIZES[0]),
      secondSaturation: secondSaturated / (transitions.length * HIDDEN_SIZES[1]),
    };
  }

  private actorDiagnostics(transitions: PPOTransition[], actorFeatures?: readonly Float32Array[]): Pick<PPOUpdateMetrics,
    'actorHidden1PreactivationAbsMean' | 'actorHidden1Saturation' | 'actorHidden2Saturation'
    | 'actorStateTotalVariation' | 'actorStateGreedyAgreement' | 'actorStateDecisionHeads'> {
    let preactivationAbsSum = 0;
    let firstSaturated = 0;
    let secondSaturated = 0;
    let referenceLogits: number[] | undefined;
    let totalVariation = 0;
    let greedyAgreements = 0;
    let decisionHeads = 0;
    for (let start = 0; start < transitions.length; start += 256) {
      const batch = transitions.slice(start, start + 256);
      tf.tidy(() => {
        const observations = tf.tensor2d(batch.map(transition => transition.observation), [batch.length, this.observationSize]);
        const inputs = actorFeatures ? this.sharedInputs(actorFeatures.slice(start, start + batch.length)) : undefined;
        const { preactivation, first, second } = this.hiddenLayers(observations, 0, inputs);
        preactivationAbsSum += tf.sum(tf.abs(preactivation)).dataSync()[0];
        firstSaturated += tf.sum(tf.cast(tf.greaterEqual(tf.abs(first), 0.99), 'float32')).dataSync()[0];
        secondSaturated += tf.sum(tf.cast(tf.greaterEqual(tf.abs(second), 0.99), 'float32')).dataSync()[0];
        const logits = tf.add(tf.matMul(second, this.weights[4]), this.weights[5])
          .reshape([batch.length, RL_MAX_DRONES * RL_ACTION_COUNT]).arraySync() as number[][];
        referenceLogits ??= logits[0];
        for (const [index, transition] of batch.entries()) {
          for (const [slot, mask] of transition.masks.entries()) {
            if (mask.filter(Boolean).length <= 1) continue;
            const offset = slot * RL_ACTION_COUNT;
            const current = maskedCategorical(logits[index].slice(offset, offset + RL_ACTION_COUNT), mask).probabilities;
            const reference = maskedCategorical(referenceLogits.slice(offset, offset + RL_ACTION_COUNT), mask).probabilities;
            totalVariation += current.reduce((sum, probability, action) => sum + Math.abs(probability - reference[action]), 0) / 2;
            greedyAgreements += Number(current.indexOf(Math.max(...current)) === reference.indexOf(Math.max(...reference)));
            decisionHeads += 1;
          }
        }
      });
    }
    const activationRows = transitions.length * (this.options.actorArchitecture !== 'dense' ? RL_MAX_DRONES * RL_ACTION_COUNT : 1);
    return {
      actorHidden1PreactivationAbsMean: preactivationAbsSum / (activationRows * HIDDEN_SIZES[0]),
      actorHidden1Saturation: firstSaturated / (activationRows * HIDDEN_SIZES[0]),
      actorHidden2Saturation: secondSaturated / (activationRows * HIDDEN_SIZES[1]),
      actorStateTotalVariation: decisionHeads ? totalVariation / decisionHeads : 0,
      actorStateGreedyAgreement: decisionHeads ? greedyAgreements / decisionHeads : 0,
      actorStateDecisionHeads: decisionHeads,
    };
  }

  update(transitions: PPOTransition[], bootstrapValue: number): PPOUpdateMetrics {
    this.checkActive();
    if (!Array.isArray(transitions) || transitions.length === 0) throw new Error('PPO update requires transitions');
    for (const transition of transitions) {
      this.validateObservation(transition.observation);
      this.validateMasks(transition.masks);
      if (!Array.isArray(transition.actions) || transition.actions.length !== RL_MAX_DRONES
        || !Array.from(transition.actions).every((action, index) => Number.isInteger(action) && action >= 0 && action < RL_ACTION_COUNT && transition.masks[index][action])
        || !finite(transition.logProbability) || transition.logProbability > 0) throw new Error('Invalid PPO transition action or probability');
      if (!finite(transition.reward)) throw new Error('Invalid PPO transition reward');
    }
    const scaledTransitions = transitions.map(transition => ({ ...transition, reward: transition.reward * this.options.rewardScale }));
    const { advantages, returns } = calculateGAE(scaledTransitions, bootstrapValue, this.options.gamma, this.options.gaeLambda);
    const advantageMean = advantages.reduce((sum, value) => sum + value, 0) / advantages.length;
    const advantageDeviation = Math.sqrt(advantages.reduce((sum, value) => sum + (value - advantageMean) ** 2, 0) / advantages.length);
    const normalizedAdvantages = advantages.map(value => (value - advantageMean) / (advantageDeviation + 1e-8));
    const rawRewards = distributionStats(transitions.map(transition => transition.reward));
    const scaledRewards = distributionStats(scaledTransitions.map(transition => transition.reward));
    const targets = distributionStats(returns);
    const critic = this.criticDiagnostics(transitions);
    const predictions = distributionStats(critic.values);
    const errors = returns.map((value, index) => value - critic.values[index]);
    const errorStats = distributionStats(errors);
    const explainedVariance = targets.variance > 0 ? 1 - errorStats.variance / targets.variance : NaN;
    const actorFeatures = this.options.actorArchitecture === 'autoregressive'
      ? transitions.map(transition => coordinatedActorFeatures(transition.observation, transition.actions))
      : this.options.actorArchitecture === 'shared' ? transitions.map(transition => sharedActorFeatures(transition.observation)) : undefined;
    const totals: PPOUpdateMetrics = {
      policyLoss: 0, valueLoss: 0, entropy: 0, approximateKl: 0, clipFraction: 0, gradientNorm: 0,
      normalizedEntropy: 0, actorGradientNorm: 0, criticGradientNorm: 0,
      actorClippedGradientNorm: 0, criticClippedGradientNorm: 0, actorParameterStepNorm: 0, criticParameterStepNorm: 0,
      rewardRawMean: rawRewards.mean, rewardRawMin: rawRewards.min, rewardRawMax: rawRewards.max,
      rewardScaledMean: scaledRewards.mean, rewardScaledMin: scaledRewards.min, rewardScaledMax: scaledRewards.max,
      returnMean: targets.mean, returnMin: targets.min, returnMax: targets.max, returnStddev: Math.sqrt(targets.variance),
      valueMean: predictions.mean, valueMin: predictions.min, valueMax: predictions.max, valueStddev: Math.sqrt(predictions.variance),
      criticExplainedVariance: Number.isFinite(explainedVariance) ? explainedVariance : 0,
      criticExplainedVarianceValid: Number(Number.isFinite(explainedVariance)),
      criticRmse: Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length),
      criticHidden1Saturation: critic.firstSaturation, criticHidden2Saturation: critic.secondSaturation,
      ...this.actorDiagnostics(transitions, actorFeatures),
      updates: 0, samples: transitions.length,
    };
    const initialWeights = this.weights.map(weight => weight.clone());
    try {
      let sampledCount = 0;
      for (let epoch = 0; epoch < this.options.epochs; epoch += 1) {
        const indices = transitions.map((_, index) => index);
        for (let index = indices.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.floor(this.random() * (index + 1));
          [indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]];
        }
        for (let start = 0; start < indices.length; start += this.options.minibatchSize) {
          const batch = indices.slice(start, start + this.options.minibatchSize);
          const metrics = this.updateBatch(batch, transitions, normalizedAdvantages, returns, actorFeatures);
          for (const key of BATCH_METRIC_KEYS) totals[key] += metrics[key] * batch.length;
          totals.updates += 1;
          sampledCount += batch.length;
        }
      }
      for (const key of BATCH_METRIC_KEYS) totals[key] /= sampledCount;
      tf.tidy(() => {
        const differences = this.weights.map((weight, index) => tf.sum(tf.square(tf.sub(weight, initialWeights[index]))));
        totals.actorParameterStepNorm = tf.sqrt(tf.addN(differences.slice(0, 6))).dataSync()[0];
        totals.criticParameterStepNorm = tf.sqrt(tf.addN(differences.slice(6))).dataSync()[0];
      });
      if (!Object.values(totals).every(Number.isFinite)) throw new Error('Non-finite PPO update metrics');
      return totals;
    } finally {
      initialWeights.forEach(weight => weight.dispose());
    }
  }

  private updateBatch(indices: number[], transitions: PPOTransition[], advantages: number[], returns: number[], actorFeatures?: readonly Float32Array[]): PPOBatchMetrics {
    return tf.tidy(() => {
      const observations = tf.tensor2d(indices.map(index => transitions[index].observation), [indices.length, this.observationSize]);
      const actorInputs = actorFeatures ? this.sharedInputs(indices.map(index => actorFeatures[index])) : undefined;
      const masks = tf.tensor3d(indices.map(index => transitions[index].masks.map(mask => mask.map(valid => valid ? 1 : 0))), [indices.length, RL_MAX_DRONES, RL_ACTION_COUNT]);
      const actions = tf.oneHot(tf.tensor2d(indices.map(index => transitions[index].actions), [indices.length, RL_MAX_DRONES], 'int32'), RL_ACTION_COUNT);
      const oldLogProbabilities = tf.tensor1d(indices.map(index => transitions[index].logProbability));
      const advantageTensor = tf.tensor1d(indices.map(index => advantages[index]));
      const returnTensor = tf.tensor1d(indices.map(index => returns[index]));
      const availableChoices = indices.map(index => transitions[index].masks.map(mask => mask.filter(Boolean).length));
      const decisionHeads = availableChoices.flat().filter(count => count > 1).length;
      const entropyWeights = tf.tensor2d(availableChoices.map(counts => counts.map(count => count > 1 ? 1 / (Math.log(count) * decisionHeads) : 0)));
      let measured: PPOBatchMetrics = {
        policyLoss: 0, valueLoss: 0, entropy: 0, approximateKl: 0, clipFraction: 0, gradientNorm: 0,
        normalizedEntropy: 0, actorGradientNorm: 0, criticGradientNorm: 0, actorClippedGradientNorm: 0, criticClippedGradientNorm: 0,
      };
      const gradients = tf.variableGrads(() => {
        const logits = this.forward(observations, 0, actorInputs).reshape([indices.length, RL_MAX_DRONES, RL_ACTION_COUNT]);
        const maskedLogits = tf.add(logits, tf.mul(tf.sub(1, masks), -1e9));
        const logProbabilities = tf.logSoftmax(maskedLogits, -1);
        const probabilities = tf.softmax(maskedLogits, -1);
        const selectedLogs = tf.sum(tf.mul(logProbabilities, actions), [1, 2]);
        const ratios = tf.exp(tf.sub(selectedLogs, oldLogProbabilities));
        const clippedRatios = tf.clipByValue(ratios, 1 - this.options.clipRatio, 1 + this.options.clipRatio);
        const policyLoss = tf.neg(tf.mean(tf.minimum(tf.mul(ratios, advantageTensor), tf.mul(clippedRatios, advantageTensor))));
        const values = this.forward(observations, 6).reshape([indices.length]);
        const valueLoss = tf.mul(tf.mean(tf.square(tf.sub(values, returnTensor))), 0.5);
        const entropy = tf.neg(tf.mean(tf.sum(tf.mul(probabilities, logProbabilities), [1, 2])));
        const approximateKl = tf.mean(tf.sub(oldLogProbabilities, selectedLogs));
        const clipFraction = tf.mean(tf.cast(tf.greater(tf.abs(tf.sub(ratios, 1)), this.options.clipRatio), 'float32'));
        measured = {
          ...measured,
          policyLoss: policyLoss.dataSync()[0],
          valueLoss: valueLoss.dataSync()[0],
          entropy: entropy.dataSync()[0],
          approximateKl: approximateKl.dataSync()[0],
          clipFraction: clipFraction.dataSync()[0],
          gradientNorm: 0,
          normalizedEntropy: Math.max(0, Math.min(1, tf.neg(tf.sum(tf.mul(tf.sum(tf.mul(probabilities, logProbabilities), 2), entropyWeights))).dataSync()[0])),
        };
        if (!Object.values(measured).every(finite)) throw new Error('Non-finite PPO loss');
        return tf.sub(tf.add(policyLoss, tf.mul(valueLoss, this.options.valueCoefficient)), tf.mul(entropy, this.options.entropyCoefficient)) as tf.Scalar;
      }, this.weights);
      const gradientNorm = tf.sqrt(tf.addN(Object.values(gradients.grads).map(gradient => tf.sum(tf.square(gradient)))));
      measured.gradientNorm = gradientNorm.dataSync()[0];
      if (!finite(measured.gradientNorm)) throw new Error('Non-finite PPO gradient');
      const actorNorm = tf.sqrt(tf.addN(this.weights.slice(0, 6).map(weight => tf.sum(tf.square(gradients.grads[weight.name])))));
      const criticNorm = tf.sqrt(tf.addN(this.weights.slice(6).map(weight => tf.sum(tf.square(gradients.grads[weight.name])))));
      measured.actorGradientNorm = actorNorm.dataSync()[0];
      measured.criticGradientNorm = criticNorm.dataSync()[0];
      const globalScale = tf.minimum(1, tf.div(this.options.maxGradientNorm, tf.add(gradientNorm, 1e-8)));
      const actorScale = this.options.gradientClipping === 'global' ? globalScale : tf.minimum(1, tf.div(this.options.maxGradientNorm, tf.add(actorNorm, 1e-8)));
      const criticScale = this.options.gradientClipping === 'global' ? globalScale : tf.minimum(1, tf.div(this.options.maxGradientNorm, tf.add(criticNorm, 1e-8)));
      const actorNames = new Set(this.weights.slice(0, 6).map(weight => weight.name));
      const clippedGradients = Object.fromEntries(Object.entries(gradients.grads).map(([name, gradient]) => [name, tf.mul(gradient, actorNames.has(name) ? actorScale : criticScale)]));
      measured.actorClippedGradientNorm = tf.sqrt(tf.addN(this.weights.slice(0, 6).map(weight => tf.sum(tf.square(clippedGradients[weight.name]))))).dataSync()[0];
      measured.criticClippedGradientNorm = tf.sqrt(tf.addN(this.weights.slice(6).map(weight => tf.sum(tf.square(clippedGradients[weight.name]))))).dataSync()[0];
      if (!Object.values(measured).every(finite)) throw new Error('Non-finite PPO gradient diagnostics');
      this.optimizer.applyGradients(clippedGradients);
      return measured;
    });
  }

  exportCheckpoint(): PPOCheckpoint {
    this.checkActive();
    return {
      format: 'astro-patrol-ppo',
      version: 5,
      observationSize: this.observationSize,
      actionCount: RL_ACTION_COUNT,
      maxDrones: RL_MAX_DRONES,
      hiddenSizes: [...HIDDEN_SIZES],
      seed: this.seed,
      randomState: this.randomState,
      options: { ...this.options },
      weights: weightShapes(this.observationSize, this.options.actorArchitecture).map(({ name, shape }, index) => ({ name, shape, values: Array.from(this.weights[index].dataSync()) })),
    };
  }

  static fromCheckpoint(source: unknown): PPOAgent {
    if (!record(source) || !exactKeys(source, ['format', 'version', 'observationSize', 'actionCount', 'maxDrones', 'hiddenSizes', 'seed', 'randomState', 'options', 'weights'])
      || source.format !== 'astro-patrol-ppo' || ![1, 2, 3, 4, 5].includes(source.version as number) || source.actionCount !== RL_ACTION_COUNT || source.maxDrones !== RL_MAX_DRONES
      || !Array.isArray(source.hiddenSizes) || source.hiddenSizes.length !== HIDDEN_SIZES.length || !Array.from(source.hiddenSizes).every((size, index) => size === HIDDEN_SIZES[index])) {
      throw new Error('Invalid PPO checkpoint format or architecture');
    }
    validateObservationSize(source.observationSize);
    validateSeed(source.seed);
    validateSeed(source.randomState);
    let options = source.options;
    if (source.version !== 5) {
      const legacyKeys = Object.keys(DEFAULT_PPO_OPTIONS).filter(key => key !== 'criticNormalization'
        && (source.version === 4 || key !== 'actorArchitecture')
        && (source.version === 3 || source.version === 4 || key !== 'actorNormalization')
        && (source.version !== 1 || key !== 'rewardScale' && key !== 'gradientClipping'));
      if (!record(options) || !exactKeys(options, legacyKeys)) throw new Error('Invalid legacy PPO options');
      if (source.version === 4 && options.actorArchitecture !== 'dense' && options.actorArchitecture !== 'shared') throw new Error('Invalid legacy PPO actor architecture');
      options = { ...options, ...(source.version === 1 ? { rewardScale: 1, gradientClipping: 'global' } : {}),
        ...(source.version === 1 || source.version === 2 ? { actorNormalization: 'none' } : {}),
        ...(source.version !== 4 ? { actorArchitecture: 'dense' } : {}), criticNormalization: 'none' };
    }
    validateOptions(options as PPOOptions);
    const expectedShapes = weightShapes(source.observationSize, (options as PPOOptions).actorArchitecture);
    if (!Array.isArray(source.weights) || source.weights.length !== expectedShapes.length) throw new Error('Invalid PPO checkpoint weights');
    const suppliedWeights = source.weights;
    for (const [index, expected] of expectedShapes.entries()) {
      const supplied = suppliedWeights[index];
      if (!record(supplied) || !exactKeys(supplied, ['name', 'shape', 'values']) || supplied.name !== expected.name
        || !Array.isArray(supplied.shape) || supplied.shape.length !== expected.shape.length || !Array.from(supplied.shape).every((size, axis) => size === expected.shape[axis])
        || !Array.isArray(supplied.values) || supplied.values.length !== expected.shape.reduce((product, size) => product * size, 1) || !Array.from(supplied.values).every(finite)) {
        throw new Error(`Invalid PPO checkpoint weight: ${expected.name}`);
      }
    }
    const agent = new PPOAgent(source.observationSize, source.seed, options as PPOOptions);
    tf.tidy(() => {
      for (const [index, expected] of expectedShapes.entries()) agent.weights[index].assign(tf.tensor(suppliedWeights[index].values, expected.shape, 'float32'));
    });
    agent.randomState = source.randomState;
    return agent;
  }

  dispose(): void {
    if (this.disposed) return;
    this.optimizer.dispose();
    this.weights.forEach(weight => weight.dispose());
    this.disposed = true;
  }
}
