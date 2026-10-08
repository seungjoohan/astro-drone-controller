import { RL_ACTION_COUNT, RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_PROTOCOL_VERSION } from './patrol-rl-contract';
import { COORDINATED_ACTOR_FEATURE_SIZE, createCoordinatedActorContext } from './patrol-rl-coordination';
import { validateRewardMetadata } from './patrol-rl-reward';
import { SHARED_ACTOR_FEATURE_SIZE, sharedActorFeatures } from './patrol-rl-shared-features';

const HIDDEN_SIZES = [32, 32] as const;
const CPU_ACCUMULATION_BLOCK = 48;
const LEGACY_OPTION_KEYS = ['gamma', 'gaeLambda', 'clipRatio', 'learningRate', 'epochs', 'minibatchSize',
  'valueCoefficient', 'entropyCoefficient', 'maxGradientNorm'];
const SCALED_OPTION_KEYS = [...LEGACY_OPTION_KEYS, 'rewardScale', 'gradientClipping'];
const NORMALIZED_OPTION_KEYS = [...SCALED_OPTION_KEYS, 'actorNormalization'];
const ARCHITECTURE_OPTION_KEYS = [...NORMALIZED_OPTION_KEYS, 'actorArchitecture'];
const OPTION_KEYS = [...ARCHITECTURE_OPTION_KEYS, 'criticNormalization'];
type ActorArchitecture = 'dense' | 'shared' | 'autoregressive';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function denseArray(value: unknown, length: number, valid: (entry: unknown, index: number) => boolean): value is unknown[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index) || !valid(value[index], index)) return false;
  }
  return true;
}

function validOptions(value: unknown, version: 1 | 2 | 3 | 4 | 5): boolean {
  const keys = version === 1 ? LEGACY_OPTION_KEYS : version === 2 ? SCALED_OPTION_KEYS : version === 3 ? NORMALIZED_OPTION_KEYS
    : version === 4 ? ARCHITECTURE_OPTION_KEYS : OPTION_KEYS;
  if (!record(value) || !exactKeys(value, keys)
    || !LEGACY_OPTION_KEYS.every(key => finite(value[key]))) return false;
  if (version >= 2 && (!finite(value.rewardScale) || value.rewardScale < 1e-8 || value.rewardScale > 1e8
    || (value.gradientClipping !== 'global' && value.gradientClipping !== 'separate'))) return false;
  if (version >= 3 && value.actorNormalization !== 'none' && value.actorNormalization !== 'layer') return false;
  if (version === 4 && value.actorArchitecture !== 'dense' && value.actorArchitecture !== 'shared') return false;
  if (version === 5 && (value.actorArchitecture !== 'dense' && value.actorArchitecture !== 'shared' && value.actorArchitecture !== 'autoregressive'
    || value.criticNormalization !== 'none' && value.criticNormalization !== 'layer')) return false;
  const options = value as Record<string, number>;
  return options.gamma >= 0 && options.gamma <= 1 && options.gaeLambda >= 0 && options.gaeLambda <= 1
    && options.clipRatio > 0 && options.clipRatio < 1 && options.learningRate > 0 && options.learningRate <= 1
    && boundedInteger(options.epochs, 100) && options.epochs >= 1
    && boundedInteger(options.minibatchSize, 65536) && options.minibatchSize >= 1
    && options.valueCoefficient >= 0 && options.entropyCoefficient >= 0 && options.maxGradientNorm > 0;
}

function weightShapes(architecture: ActorArchitecture): { name: string; shape: number[] }[] {
  const actorInputSize = architecture === 'autoregressive' ? COORDINATED_ACTOR_FEATURE_SIZE
    : architecture === 'shared' ? SHARED_ACTOR_FEATURE_SIZE : RL_OBSERVATION_SIZE;
  const actorOutputSize = architecture === 'dense' ? RL_MAX_DRONES * RL_ACTION_COUNT : 1;
  return ['actor', 'critic'].flatMap(network => [
    { name: `${network}.hidden1.kernel`, shape: [network === 'actor' ? actorInputSize : RL_OBSERVATION_SIZE, HIDDEN_SIZES[0]] },
    { name: `${network}.hidden1.bias`, shape: [HIDDEN_SIZES[0]] },
    { name: `${network}.hidden2.kernel`, shape: [HIDDEN_SIZES[0], HIDDEN_SIZES[1]] },
    { name: `${network}.hidden2.bias`, shape: [HIDDEN_SIZES[1]] },
    { name: `${network}.output.kernel`, shape: [HIDDEN_SIZES[1], network === 'actor' ? actorOutputSize : 1] },
    { name: `${network}.output.bias`, shape: [network === 'actor' ? actorOutputSize : 1] },
  ]);
}

function dense(inputs: Float32Array, kernel: Float32Array, bias: Float32Array, activate: boolean): Float32Array {
  const output = new Float32Array(bias.length);
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    for (let blockStart = 0; blockStart < inputs.length; blockStart += CPU_ACCUMULATION_BLOCK) {
      let sum = 0;
      const blockEnd = Math.min(blockStart + CPU_ACCUMULATION_BLOCK, inputs.length);
      for (let inputIndex = blockStart; inputIndex < blockEnd; inputIndex += 1) {
        sum += inputs[inputIndex] * kernel[inputIndex * output.length + outputIndex];
      }
      output[outputIndex] += sum;
    }
    output[outputIndex] += bias[outputIndex];
    if (!Number.isFinite(output[outputIndex])) throw new Error('Non-finite frozen policy activation');
    if (activate) output[outputIndex] = Math.tanh(output[outputIndex]);
  }
  return output;
}

function normalizedActivation(inputs: Float32Array): Float32Array {
  const mean = Math.fround(inputs.reduce((sum, value) => sum + Math.fround(value / inputs.length), 0));
  const centered = inputs.map(value => value - mean);
  const variance = Math.fround(centered.reduce((sum, value) => sum + Math.fround(Math.fround(value * value) / inputs.length), 0));
  const deviation = Math.fround(Math.sqrt(Math.fround(variance + Math.fround(1e-5))));
  if (!Number.isFinite(deviation)) throw new Error('Non-finite frozen policy normalization');
  return centered.map(value => Math.tanh(Math.fround(value / deviation)));
}

function greedyAction(logits: Float32Array, mask: boolean[], offset = 0): number {
  const maximum = Math.max(...mask.map((valid, index) => valid ? logits[offset + index] : -Infinity));
  const exponentials = mask.map((valid, index) => valid ? Math.exp(logits[offset + index] - maximum) : 0);
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  const probabilities = exponentials.map(value => value / total);
  let action = mask.findIndex(Boolean);
  for (let index = action + 1; index < RL_ACTION_COUNT; index += 1) {
    if (probabilities[index] > probabilities[action]) action = index;
  }
  return action;
}

export class FrozenPatrolPolicy {
  readonly seed: number;
  readonly completedEpisodes: number;
  readonly trainingSteps: number;
  readonly #weights: readonly Float32Array[];
  readonly #normalizeActor: boolean;
  readonly #architecture: ActorArchitecture;

  private constructor(seed: number, completedEpisodes: number, trainingSteps: number, weights: Float32Array[], normalizeActor: boolean, architecture: ActorArchitecture) {
    this.seed = seed;
    this.completedEpisodes = completedEpisodes;
    this.trainingSteps = trainingSteps;
    this.#weights = weights;
    this.#normalizeActor = normalizeActor;
    this.#architecture = architecture;
    Object.freeze(this);
  }

  static fromArtifact(source: unknown): FrozenPatrolPolicy {
    if (!record(source) || source.format !== 'astro-patrol-rl-policy' || (source.version !== 1 && source.version !== 2)
      || source.protocolVersion !== RL_PROTOCOL_VERSION || !boundedInteger(source.completedEpisodes, Number.MAX_SAFE_INTEGER)
      || !boundedInteger(source.trainingSteps, Number.MAX_SAFE_INTEGER)) {
      throw new Error('Invalid or incompatible patrol RL policy artifact');
    }
    const rewardProfile = source.version === 2 ? validateRewardMetadata(source.reward) : 'legacy-v1';
    if (source.version === 1 && Object.hasOwn(source, 'reward') && validateRewardMetadata(source.reward) !== rewardProfile
      || source.version === 2 && source.settings !== undefined && !record(source.settings)
      || record(source.settings) && Object.hasOwn(source.settings, 'rewardProfile') && source.settings.rewardProfile !== rewardProfile) {
      throw new Error('Inconsistent patrol RL reward metadata');
    }
    const policy = source.policy;
    if (!record(policy) || !exactKeys(policy, ['format', 'version', 'observationSize', 'actionCount', 'maxDrones',
      'hiddenSizes', 'seed', 'randomState', 'options', 'weights']) || policy.format !== 'astro-patrol-ppo'
      || (policy.version !== 1 && policy.version !== 2 && policy.version !== 3 && policy.version !== 4 && policy.version !== 5)
      || policy.observationSize !== RL_OBSERVATION_SIZE || policy.actionCount !== RL_ACTION_COUNT || policy.maxDrones !== RL_MAX_DRONES
      || !denseArray(policy.hiddenSizes, HIDDEN_SIZES.length, (size, index) => size === HIDDEN_SIZES[index])
      || !boundedInteger(policy.seed, 0xffffffff) || !boundedInteger(policy.randomState, 0xffffffff)
      || !validOptions(policy.options, policy.version)) {
      throw new Error('Invalid frozen PPO checkpoint format or architecture');
    }
    const architecture: ActorArchitecture = record(policy.options) && policy.options.actorArchitecture === 'autoregressive' ? 'autoregressive'
      : record(policy.options) && policy.options.actorArchitecture === 'shared' ? 'shared' : 'dense';
    const expectedShapes = weightShapes(architecture);
    if (!denseArray(policy.weights, expectedShapes.length, (weight, index) => {
      const expected = expectedShapes[index];
      return record(weight) && exactKeys(weight, ['name', 'shape', 'values']) && weight.name === expected.name
        && denseArray(weight.shape, expected.shape.length, (size, axis) => size === expected.shape[axis])
        && denseArray(weight.values, expected.shape.reduce((product, size) => product * size, 1), finite);
    })) throw new Error('Invalid frozen PPO checkpoint weights');
    const weights = policy.weights.slice(0, 6).map(weight => new Float32Array((weight as { values: number[] }).values));
    return new FrozenPatrolPolicy(policy.seed, source.completedEpisodes, source.trainingSteps, weights,
      record(policy.options) && policy.options.actorNormalization === 'layer', architecture);
  }

  private logits(inputs: Float32Array): Float32Array {
    const preactivation = dense(inputs, this.#weights[0], this.#weights[1], !this.#normalizeActor);
    const first = this.#normalizeActor ? normalizedActivation(preactivation) : preactivation;
    const second = dense(first, this.#weights[2], this.#weights[3], true);
    return dense(second, this.#weights[4], this.#weights[5], false);
  }

  act(observation: number[], masks: boolean[][]): number[] {
    if (!denseArray(observation, RL_OBSERVATION_SIZE, finite)) throw new Error('Invalid frozen policy observation');
    if (!denseArray(masks, RL_MAX_DRONES, mask => denseArray(mask, RL_ACTION_COUNT, valid => typeof valid === 'boolean')
      && mask.some(Boolean))) throw new Error('Invalid frozen policy action masks');
    const inputs = new Float32Array(observation);
    if (this.#architecture === 'autoregressive') {
      const context = createCoordinatedActorContext(inputs);
      const actions = Array<number>(RL_MAX_DRONES).fill(-1);
      for (const slot of context.order) {
        const features = context.features(slot, actions);
        const logits = new Float32Array(RL_ACTION_COUNT);
        for (let action = 0; action < RL_ACTION_COUNT; action += 1) {
          logits[action] = this.logits(features.subarray(action * COORDINATED_ACTOR_FEATURE_SIZE, (action + 1) * COORDINATED_ACTOR_FEATURE_SIZE))[0];
        }
        actions[slot] = greedyAction(logits, masks[slot]);
      }
      return actions;
    }
    let logits: Float32Array;
    if (this.#architecture === 'shared') {
      const features = sharedActorFeatures(inputs);
      logits = new Float32Array(RL_MAX_DRONES * RL_ACTION_COUNT);
      for (let index = 0; index < logits.length; index += 1) {
        logits[index] = this.logits(features.subarray(index * SHARED_ACTOR_FEATURE_SIZE, (index + 1) * SHARED_ACTOR_FEATURE_SIZE))[0];
      }
    } else logits = this.logits(inputs);
    return masks.map((mask, droneIndex) => greedyAction(logits, mask, droneIndex * RL_ACTION_COUNT));
  }
}
