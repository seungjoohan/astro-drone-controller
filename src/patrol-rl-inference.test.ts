import { afterEach, describe, expect, it } from 'vitest';
import { RL_ACTION_COUNT, RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_PROTOCOL_VERSION, rlRandom } from './patrol-rl-contract';
import { FrozenPatrolPolicy } from './patrol-rl-inference';
import { PPOAgent } from './patrol-rl-network';
import { rewardMetadata } from './patrol-rl-reward';
import type { PPOCheckpoint, PPOOptions } from './patrol-rl-network';

const agents: PPOAgent[] = [];

function agent(seed = 42, options: Partial<PPOOptions> = {}): PPOAgent {
  const instance = new PPOAgent(RL_OBSERVATION_SIZE, seed, options);
  agents.push(instance);
  return instance;
}

function artifact(policy: PPOCheckpoint = agent().exportCheckpoint()) {
  return { format: 'astro-patrol-rl-policy', version: 1, protocolVersion: RL_PROTOCOL_VERSION,
    completedEpisodes: 64, trainingSteps: 18064, policy };
}

function masks(): boolean[][] {
  return Array.from({ length: RL_MAX_DRONES }, () => Array<boolean>(RL_ACTION_COUNT).fill(true));
}

function legacyOptions(options: PPOOptions) {
  return { gamma: options.gamma, gaeLambda: options.gaeLambda, clipRatio: options.clipRatio,
    learningRate: options.learningRate, epochs: options.epochs, minibatchSize: options.minibatchSize,
    valueCoefficient: options.valueCoefficient, entropyCoefficient: options.entropyCoefficient,
    maxGradientNorm: options.maxGradientNorm };
}

function scaledOptions(options: PPOOptions) {
  return { ...legacyOptions(options), rewardScale: options.rewardScale, gradientClipping: options.gradientClipping };
}

function normalizedOptions(options: PPOOptions) {
  return { ...scaledOptions(options), actorNormalization: options.actorNormalization };
}

function architectureOptions(options: PPOOptions) {
  return { ...normalizedOptions(options), actorArchitecture: options.actorArchitecture };
}

function sharedObservation(seed: number, fleetSize = 5): number[] {
  const random = rlRandom(seed);
  const observation = Array<number>(RL_OBSERVATION_SIZE).fill(0);
  for (let cell = 0; cell < 256; cell += 1) {
    observation.splice(cell * 5, 5, 1, random(), random(), random(), Number(random() > 0.5));
  }
  for (let slot = 0; slot < fleetSize; slot += 1) {
    const horizontal = random() * 1.8 - 0.9;
    const depth = random() * 1.8 - 0.9;
    observation.splice(1280 + slot * 14, 14, 1, horizontal, depth, 0.6 + random() * 0.4, random(),
      1, 0, 0, 0, 0, 0, horizontal, depth, 1);
  }
  observation.splice(1392, 18, 1, 1, 0, 0.6, 0.5, 1, 300 / 1800, 120 / 1800, 0.2, 0.25,
    0, 0, 0.95, 120 / 3600, 15 / 120, 0.08, 0.1, fleetSize / 8);
  return observation;
}

function sharedMasks(fleetSize = 5): boolean[][] {
  return masks().map((mask, slot) => mask.map((valid, action) => slot < fleetSize ? valid : action === 24));
}

afterEach(() => agents.splice(0).forEach(instance => instance.dispose()));

describe('dependency-free frozen patrol inference', () => {
  it.each((['legacy-v1', 'coverage-v2'] as const).flatMap(rewardProfile => (['dense', 'shared', 'autoregressive'] as const)
    .flatMap(actorArchitecture => (['none', 'layer'] as const).map(actorNormalization => ({ rewardProfile, actorArchitecture, actorNormalization })))))
    ('validates outer v2 $rewardProfile metadata without changing $actorArchitecture $actorNormalization actions', options => {
      const instance = agent(101, { actorArchitecture: options.actorArchitecture, actorNormalization: options.actorNormalization });
      const source = { ...artifact(instance.exportCheckpoint()), version: 2, reward: rewardMetadata(options.rewardProfile),
        settings: { rewardProfile: options.rewardProfile } };
      const before = structuredClone(source);
      const frozen = FrozenPatrolPolicy.fromArtifact(source);
      const withoutSettings = FrozenPatrolPolicy.fromArtifact({ ...source, settings: undefined });
      const legacy = FrozenPatrolPolicy.fromArtifact(artifact(instance.exportCheckpoint()));
      for (const fleetSize of [1, 5, 8]) {
        const observation = sharedObservation(101 + fleetSize, fleetSize);
        const validActions = sharedMasks(fleetSize);
        const expected = instance.act(observation, validActions, true).actions;
        expect(frozen.act(observation, validActions)).toEqual(expected);
        expect(withoutSettings.act(observation, validActions)).toEqual(expected);
        expect(legacy.act(observation, validActions)).toEqual(expected);
      }
      expect(source).toEqual(before);
      expect(Object.keys(frozen).sort()).toEqual(['completedEpisodes', 'seed', 'trainingSteps']);
    });

  it('rejects missing, malformed, or inconsistent outer reward metadata', () => {
    const source = { ...artifact(), version: 2, reward: rewardMetadata('coverage-v2'), settings: { rewardProfile: 'coverage-v2' } };
    const missingField: Record<string, unknown> = { ...source.reward };
    delete missingField[Object.keys(missingField)[0]];
    for (const reward of [undefined, null, [], {}, 'coverage-v2', missingField, { ...source.reward, extra: true },
      { ...source.reward, profile: 'unknown' }, { ...source.reward, version: 2 },
      { ...source.reward, weights: { ...source.reward.weights, geographicAge: 0 } },
      { ...source.reward, weights: { ...source.reward.weights, overlap: NaN } },
      { ...source.reward, weights: { ...source.reward.weights, overlap: Infinity } },
      { ...source.reward, weights: { ...source.reward.weights, extra: 1 } }]) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, reward })).toThrow();
    }
    for (const rewardProfile of [undefined, null, 1, '', 'unknown', 'legacy-v1']) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, settings: { rewardProfile } })).toThrow(/reward/i);
    }
    for (const settings of [null, [], 1, 'coverage-v2']) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, settings })).toThrow(/reward/i);
    }
    expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, reward: rewardMetadata('legacy-v1') })).toThrow(/reward/i);
    expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, version: 1 })).toThrow(/reward/i);
    expect(() => FrozenPatrolPolicy.fromArtifact({ ...artifact(), settings: { rewardProfile: 'coverage-v2' } })).toThrow(/reward/i);
    expect(() => FrozenPatrolPolicy.fromArtifact({ ...artifact(), reward: rewardMetadata('legacy-v1'),
      settings: { rewardProfile: 'legacy-v1' } })).not.toThrow();
  });

  it.each([42, 73, 101].flatMap(seed => (['none', 'layer'] as const).map(actorNormalization => ({ seed, actorNormalization }))))(
    'matches v5 dense CPU PPO actions for seed $seed with $actorNormalization normalization and changing masks', ({ seed, actorNormalization }) => {
    const instance = agent(seed, { actorNormalization });
    expect(instance.exportCheckpoint().version).toBe(5);
    const frozen = FrozenPatrolPolicy.fromArtifact(artifact(instance.exportCheckpoint()));
    const random = rlRandom(seed);
    for (let sample = 0; sample < 20; sample += 1) {
      const observation = Array.from({ length: RL_OBSERVATION_SIZE }, () => random() * 2 - 1);
      const validActions = masks().map(mask => mask.map((_, index) => index === 24 || random() > 0.5));
      expect(frozen.act(observation, validActions)).toEqual(instance.act(observation, validActions, true).actions);
    }
  });

  it.each((['dense', 'shared'] as const).flatMap(actorArchitecture => (['none', 'layer'] as const)
    .map(actorNormalization => ({ actorArchitecture, actorNormalization }))))(
    'keeps authentic v4 $actorArchitecture checkpoints compatible with $actorNormalization actor normalization', options => {
      const instance = agent(73, options);
      const checkpoint = instance.exportCheckpoint();
      const source = { ...artifact(checkpoint), policy: { ...checkpoint, version: 4, options: architectureOptions(instance.options) } };
      const frozen = FrozenPatrolPolicy.fromArtifact(source);
      for (const fleetSize of [1, 5, 8]) {
        const observation = sharedObservation(73 + fleetSize, fleetSize);
        const validActions = sharedMasks(fleetSize);
        expect(frozen.act(observation, validActions)).toEqual(instance.act(observation, validActions, true).actions);
      }
    });

  it.each(['none', 'layer'] as const)('keeps v3 dense checkpoints compatible with %s normalization', actorNormalization => {
    const instance = agent(73, { actorNormalization });
    const checkpoint = instance.exportCheckpoint();
    const frozen = FrozenPatrolPolicy.fromArtifact({ ...artifact(checkpoint),
      policy: { ...checkpoint, version: 3, options: normalizedOptions(instance.options) } });
    const observation = sharedObservation(73);
    expect(frozen.act(observation, masks())).toEqual(instance.act(observation, masks(), true).actions);
  });

  it.each([42, 73, 101].flatMap(seed => (['none', 'layer'] as const).map(actorNormalization => ({ seed, actorNormalization }))))(
    'matches shared CPU PPO actions for seed $seed with $actorNormalization normalization', ({ seed, actorNormalization }) => {
    const instance = agent(seed, { actorArchitecture: 'shared', actorNormalization });
    const frozen = FrozenPatrolPolicy.fromArtifact(artifact(instance.exportCheckpoint()));
    const random = rlRandom(seed);
    for (let sample = 0; sample < 12; sample += 1) {
      const fleetSize = 1 + sample % 8;
      const observation = sharedObservation(seed + sample, fleetSize);
      const validActions = sharedMasks(fleetSize).map(mask => mask.map((valid, action) => valid && (action === 24 || random() > 0.5)));
      expect(frozen.act(observation, validActions)).toEqual(instance.act(observation, validActions, true).actions);
    }
  });

  it.each(['none', 'layer'] as const)('matches shared %s inference after batched gradient updates', actorNormalization => {
    const instance = agent(73, { actorArchitecture: 'shared', actorNormalization, rewardScale: 0.001,
      gradientClipping: 'separate', epochs: 2, minibatchSize: 4 });
    const transitions = Array.from({ length: 8 }, (_, sample) => {
      const observation = sharedObservation(73 + sample, 1 + sample);
      const validActions = sharedMasks(1 + sample);
      return { observation, masks: validActions, ...instance.act(observation, validActions), reward: sample - 3, terminated: true };
    });
    instance.update(transitions, 0);
    const frozen = FrozenPatrolPolicy.fromArtifact(artifact(instance.exportCheckpoint()));
    for (const { observation, masks: validActions } of transitions) {
      expect(frozen.act(observation, validActions)).toEqual(instance.act(observation, validActions, true).actions);
    }
  });

  it.each((['none', 'layer'] as const).flatMap(actorNormalization => (['none', 'layer'] as const)
    .map(criticNormalization => ({ actorNormalization, criticNormalization }))))(
    'matches trained autoregressive CPU actions with $actorNormalization actor and $criticNormalization critic normalization', options => {
      const instance = agent(73, { actorArchitecture: 'autoregressive', ...options, rewardScale: 0.001,
        gradientClipping: 'separate', epochs: 2, minibatchSize: 4 });
      const transitions = Array.from({ length: 8 }, (_, sample) => {
        const fleetSize = sample + 1;
        const observation = sharedObservation(73 + sample, fleetSize);
        const validActions = sharedMasks(fleetSize).map((mask, slot) => mask.map((valid, action) => valid
          && (action === 24 || (action + sample + slot) % 3 !== 0)));
        if (fleetSize > 3) {
          const slot = fleetSize - 2;
          observation[1280 + slot * 14 + 5] = 0;
          observation[1280 + slot * 14 + 8] = 1;
          observation[1280 + slot * 14 + 13] = 0;
          validActions[slot] = validActions[slot].map((_valid, action) => action === 24);
        }
        return { observation, masks: validActions, ...instance.act(observation, validActions), reward: sample - 3, terminated: true };
      });
      instance.update(transitions, 0);
      const source = artifact(instance.exportCheckpoint());
      const frozen = FrozenPatrolPolicy.fromArtifact(source);
      const permutation = [7, 2, 6, 0, 5, 1, 4, 3];
      for (const { observation, masks: validActions } of transitions) {
        const before = structuredClone({ observation, validActions });
        const actions = frozen.act(observation, validActions);
        expect(actions).toEqual(instance.act(observation, validActions, true).actions);
        expect(actions.every((action, slot) => validActions[slot][action])).toBe(true);
        expect({ observation, validActions }).toEqual(before);
        const permuted = [...observation];
        for (const [destination, sourceSlot] of permutation.entries()) {
          permuted.splice(1280 + destination * 14, 14, ...observation.slice(1280 + sourceSlot * 14, 1280 + (sourceSlot + 1) * 14));
        }
        expect(frozen.act(permuted, permutation.map(slot => validActions[slot]))).toEqual(permutation.map(slot => actions[slot]));
      }
      const original = frozen.act(transitions[0].observation, transitions[0].masks);
      source.policy.options.criticNormalization = options.criticNormalization === 'layer' ? 'none' : 'layer';
      expect(FrozenPatrolPolicy.fromArtifact(source).act(transitions[0].observation, transitions[0].masks)).toEqual(original);
      source.policy.weights[0].values.fill(NaN);
      expect(frozen.act(transitions[0].observation, transitions[0].masks)).toEqual(original);
    });

  it('keeps coordinated padding inert and accepts forced service-state actions without inventing sensing peers', () => {
    const frozen = FrozenPatrolPolicy.fromArtifact(artifact(agent(101, { actorArchitecture: 'autoregressive' }).exportCheckpoint()));
    const observation = sharedObservation(101, 5);
    const validActions = sharedMasks(5);
    for (const [slot, serviceFeature] of [[1, 6], [2, 7], [3, 8], [4, 10]]) {
      observation[1280 + slot * 14 + 5] = 0;
      observation[1280 + slot * 14 + serviceFeature] = 1;
      observation[1280 + slot * 14 + 13] = 0;
      validActions[slot] = validActions[slot].map((_valid, action) => action === 24);
    }
    const original = frozen.act(observation, validActions);
    expect(original.slice(1)).toEqual(Array<number>(7).fill(24));
    for (let slot = 5; slot < 8; slot += 1) {
      for (let feature = 1; feature < 14; feature += 1) observation[1280 + slot * 14 + feature] = 999;
    }
    expect(frozen.act(observation, validActions)).toEqual(original);
  });

  it.each(['none', 'layer'] as const)('preserves shared %s actions under full slot relabeling with padded peers', actorNormalization => {
    const source = artifact(agent(101, { actorArchitecture: 'shared', actorNormalization }).exportCheckpoint());
    const frozen = FrozenPatrolPolicy.fromArtifact(source);
    const observation = sharedObservation(101);
    const validActions = sharedMasks();
    const original = frozen.act(observation, validActions);
    const permutation = [7, 2, 6, 0, 5, 1, 4, 3];
    const permuted = [...observation];
    for (const [destination, sourceSlot] of permutation.entries()) {
      for (let feature = 0; feature < 14; feature += 1) permuted[1280 + destination * 14 + feature] = observation[1280 + sourceSlot * 14 + feature];
    }
    expect(frozen.act(permuted, permutation.map(slot => validActions[slot]))).toEqual(permutation.map(slot => original[slot]));
    for (let slot = 5; slot < 8; slot += 1) {
      for (let feature = 1; feature < 14; feature += 1) observation[1280 + slot * 14 + feature] = 999;
    }
    expect(frozen.act(observation, validActions)).toEqual(original);
    source.policy.options.actorArchitecture = 'dense';
    expect(frozen.act(observation, validActions)).toEqual(original);
  });

  it('keeps legacy v1 checkpoints compatible without requiring v2 options', () => {
    const instance = agent();
    const source = artifact(instance.exportCheckpoint());
    const policy = { ...source.policy, version: 1, options: legacyOptions(instance.options) };
    const frozen = FrozenPatrolPolicy.fromArtifact({ ...source, policy });
    const observation = Array.from({ length: RL_OBSERVATION_SIZE }, (_, index) => Math.sin(index));
    expect(frozen.act(observation, masks())).toEqual(instance.act(observation, masks(), true).actions);
  });

  it.each([
    { rewardScale: 1e-8, gradientClipping: 'global' as const },
    { rewardScale: 0.001, gradientClipping: 'global' as const },
    { rewardScale: 0.001, gradientClipping: 'separate' as const },
    { rewardScale: 1e8, gradientClipping: 'separate' as const },
  ])('matches v2 actor actions with $rewardScale reward scaling and $gradientClipping clipping', options => {
    const instance = agent(101, options);
    const checkpoint = instance.exportCheckpoint();
    expect(checkpoint.options).toMatchObject(options);
    const frozen = FrozenPatrolPolicy.fromArtifact({ ...artifact(checkpoint),
      policy: { ...checkpoint, version: 2, options: scaledOptions(instance.options) } });
    const random = rlRandom(101);
    for (let sample = 0; sample < 10; sample += 1) {
      const observation = Array.from({ length: RL_OBSERVATION_SIZE }, () => random() * 2 - 1);
      const validActions = masks().map(mask => mask.map((_, index) => index === 24 || random() > 0.5));
      expect(frozen.act(observation, validActions)).toEqual(instance.act(observation, validActions, true).actions);
    }
  });

  it.each(['none', 'layer'] as const)('matches trained PPO weights after a gradient update with %s normalization', actorNormalization => {
    const instance = agent(73, { rewardScale: 0.001, gradientClipping: 'separate', actorNormalization });
    const transitions = Array.from({ length: 8 }, (_, sample) => {
      const observation = Array.from({ length: RL_OBSERVATION_SIZE }, (_, index) => Math.sin(index + sample));
      const validActions = masks();
      return { observation, masks: validActions, ...instance.act(observation, validActions), reward: sample - 3, terminated: true };
    });
    instance.update(transitions, 0);
    const frozen = FrozenPatrolPolicy.fromArtifact(artifact(instance.exportCheckpoint()));
    for (const { observation, masks: validActions } of transitions) {
      expect(frozen.act(observation, validActions)).toEqual(instance.act(observation, validActions, true).actions);
    }
  });

  it.each([
    { bias: Array<number>(32).fill(0) },
    { bias: Array<number>(32).fill(3) },
    { bias: Array.from({ length: 32 }, (_, index) => 3 + index * 1e-6) },
    { bias: Array.from({ length: 32 }, (_, index) => 100000 + index * 0.1) },
  ])('matches CPU normalization for constant or nearly constant first-layer activations %#', ({ bias }) => {
    const source = artifact(agent(101, { actorNormalization: 'layer' }).exportCheckpoint());
    source.policy.weights[0].values.fill(0);
    source.policy.weights[1].values = bias;
    const instance = PPOAgent.fromCheckpoint(source.policy);
    agents.push(instance);
    const frozen = FrozenPatrolPolicy.fromArtifact(source);
    const observation = Array<number>(RL_OBSERVATION_SIZE).fill(0);
    expect(frozen.act(observation, masks())).toEqual(instance.act(observation, masks(), true).actions);
    if (new Set(bias).size === 1) expect(frozen.act(observation, masks())).toEqual(Array(8).fill(0));
    source.policy.options.actorNormalization = 'none';
    expect(frozen.act(observation, masks())).toEqual(instance.act(observation, masks(), true).actions);
  });

  it('chooses the first legal tied action and does not mutate inputs or keep source weights', () => {
    const source = artifact();
    source.policy.weights.forEach(weight => weight.values.fill(0));
    const before = structuredClone(source);
    const frozen = FrozenPatrolPolicy.fromArtifact(source);
    const observation = Array<number>(RL_OBSERVATION_SIZE).fill(0.1);
    const validActions = masks().map(mask => mask.map((_, action) => action === 7 || action === 26));
    const inputs = structuredClone({ observation, validActions });
    expect(frozen.act(observation, validActions)).toEqual(Array(8).fill(7));
    expect({ observation, validActions }).toEqual(inputs);
    expect(source).toEqual(before);
    source.policy.weights[5].values[26] = 100;
    source.policy.weights[0].values.fill(NaN);
    source.completedEpisodes = 1;
    expect(frozen.act(observation, validActions)).toEqual(Array(8).fill(7));
    expect(frozen.seed).toBe(42);
    expect(frozen.completedEpisodes).toBe(64);
    expect(frozen.trainingSteps).toBe(18064);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('does not expose artifact approval claims as policy properties', () => {
    const frozen = FrozenPatrolPolicy.fromArtifact({ ...artifact(), approved: true, promotionEligible: true, evaluation: 'passed' });
    expect(Object.keys(frozen).sort()).toEqual(['completedEpisodes', 'seed', 'trainingSteps']);
  });

  it('matches CPU categorical rounding ties rather than only comparing raw logits', () => {
    const source = artifact();
    source.policy.weights.forEach(weight => weight.values.fill(0));
    source.policy.weights[5].values[7] = 1e-30;
    const instance = PPOAgent.fromCheckpoint(source.policy);
    agents.push(instance);
    const frozen = FrozenPatrolPolicy.fromArtifact(source);
    const observation = Array<number>(RL_OBSERVATION_SIZE).fill(0);
    expect(frozen.act(observation, masks())).toEqual(instance.act(observation, masks(), true).actions);
    expect(frozen.act(observation, masks())[0]).toBe(0);
  });

  it('rejects incompatible artifacts and malformed or unbounded metadata', () => {
    const source = artifact();
    for (const value of [null, [], {}, { ...source, format: 'different' }, { ...source, version: 2 },
      { ...source, protocolVersion: 'previous' }, { ...source, completedEpisodes: -1 },
      { ...source, completedEpisodes: 0.5 }, { ...source, trainingSteps: Infinity },
      { ...source, trainingSteps: Number.MAX_SAFE_INTEGER + 1 }, { ...source, trainingSteps: '10' }]) {
      expect(() => FrozenPatrolPolicy.fromArtifact(value)).toThrow();
    }
  });

  it('rejects incompatible architecture, checkpoint options, and seeds', () => {
    const source = artifact();
    for (const patch of [{ format: 'different' }, { version: 6 }, { observationSize: 1000000000 },
      { actionCount: 28 }, { maxDrones: 9 }, { hiddenSizes: [64, 32] }, { hiddenSizes: new Array(2) },
      { seed: -1 }, { seed: 0x100000000 }, { randomState: NaN }, { options: {} },
      { options: { ...source.policy.options, epochs: 0 } },
      { options: { ...source.policy.options, learningRate: NaN } }, { extra: true }]) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, policy: { ...source.policy, ...patch } })).toThrow();
    }
  });

  it('enforces exact version-specific option schemas and bounded scaling', () => {
    const source = artifact();
    const options = agent().options;
    const legacy = legacyOptions(options);
    const scaled = scaledOptions(options);
    const normalized = normalizedOptions(options);
    const architecture = architectureOptions(options);
    for (const policy of [
      { ...source.policy, version: 1, options: { ...legacy, rewardScale: 0.001 } },
      { ...source.policy, version: 1, options: { ...legacy, gradientClipping: 'global' } },
      { ...source.policy, version: 1, options: source.policy.options },
      { ...source.policy, version: 2, options: legacy },
      { ...source.policy, version: 2, options: { ...legacy, rewardScale: 0.001 } },
      { ...source.policy, version: 2, options: { ...legacy, gradientClipping: 'global' } },
      { ...source.policy, version: 2, options: { ...source.policy.options, extra: true } },
      { ...source.policy, version: 1, options: { ...legacy, actorNormalization: 'none' } },
      { ...source.policy, version: 2, options: source.policy.options },
      { ...source.policy, version: 3, options: scaled },
      { ...source.policy, version: 3, options: { ...legacy, actorNormalization: 'layer' } },
      { ...source.policy, version: 3, options: { ...source.policy.options, extra: true } },
      { ...source.policy, version: 1, options: { ...legacy, actorArchitecture: 'dense' } },
      { ...source.policy, version: 2, options: { ...scaled, actorArchitecture: 'dense' } },
      { ...source.policy, version: 3, options: { ...normalized, actorArchitecture: 'dense' } },
      { ...source.policy, version: 4, options: normalized },
      { ...source.policy, version: 4, options: { ...scaled, actorArchitecture: 'shared' } },
      { ...source.policy, version: 4, options: { ...source.policy.options, extra: true } },
      { ...source.policy, version: 4, options: { ...architecture, actorArchitecture: 'autoregressive' } },
      { ...source.policy, version: 5, options: architecture },
      ...[1, 2, 3, 4].flatMap(version => ['none', 'layer'].map(criticNormalization => ({ ...source.policy, version,
        options: { ...[legacy, scaled, normalized, architecture][version - 1], criticNormalization } }))),
    ]) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, policy })).toThrow();
    }
    for (const version of [2, 3, 4, 5]) {
      const versionOptions = version === 2 ? scaled : version === 3 ? normalized : version === 4 ? architecture : source.policy.options;
      for (const rewardScale of [undefined, null, '0.001', 0, -1, 1e-9, 1e9, NaN, Infinity]) {
        expect(() => FrozenPatrolPolicy.fromArtifact({ ...source,
          policy: { ...source.policy, version, options: { ...versionOptions, rewardScale } } })).toThrow();
      }
      for (const gradientClipping of [undefined, null, 1, false, '', 'actor', 'GLOBAL']) {
        expect(() => FrozenPatrolPolicy.fromArtifact({ ...source,
          policy: { ...source.policy, version, options: { ...versionOptions, gradientClipping } } })).toThrow();
      }
    }
    for (const version of [3, 4, 5]) for (const actorNormalization of [undefined, null, 1, false, '', 'batch', 'LAYER']) {
      const versionOptions = version === 3 ? normalized : version === 4 ? architecture : source.policy.options;
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source,
        policy: { ...source.policy, version, options: { ...versionOptions, actorNormalization } } })).toThrow();
    }
    for (const version of [4, 5]) for (const actorArchitecture of [undefined, null, 1, false, '', 'per-drone', 'SHARED']) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source,
        policy: { ...source.policy, version, options: { ...(version === 4 ? architecture : source.policy.options), actorArchitecture } } })).toThrow();
    }
    for (const criticNormalization of [undefined, null, 1, false, '', 'batch', 'LAYER']) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source,
        policy: { ...source.policy, options: { ...source.policy.options, criticNormalization } } })).toThrow();
    }
  });

  it('validates architecture-specific actor shapes while preserving the centralized critic', () => {
    const shared = artifact(agent(42, { actorArchitecture: 'shared' }).exportCheckpoint());
    const dense = artifact();
    const coordinated = artifact(agent(42, { actorArchitecture: 'autoregressive' }).exportCheckpoint());
    expect(shared.policy.weights[0].shape).toEqual([68, 32]);
    expect(shared.policy.weights[4].shape).toEqual([32, 1]);
    expect(shared.policy.weights[6].shape).toEqual([RL_OBSERVATION_SIZE, 32]);
    expect(coordinated.policy.weights[0].shape).toEqual([80, 32]);
    expect(coordinated.policy.weights[4].shape).toEqual([32, 1]);
    expect(coordinated.policy.weights[6].shape).toEqual([RL_OBSERVATION_SIZE, 32]);
    for (const [source, actorArchitecture] of [[shared, 'dense'], [dense, 'shared'], [coordinated, 'shared'],
      [coordinated, 'dense'], [shared, 'autoregressive'], [dense, 'autoregressive']] as const) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source,
        policy: { ...source.policy, options: { ...source.policy.options, actorArchitecture } } })).toThrow(/weights/);
    }
    for (const index of [0, 4, 6, 11]) {
      const weights = shared.policy.weights.map((weight, current) => current === index ? { ...weight, shape: [2] } : weight);
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...shared, policy: { ...shared.policy, weights } })).toThrow(/weights/);
    }
  });

  it('validates all weights including the unused critic without accepting sparse or oversized arrays', () => {
    const source = artifact();
    for (const invalid of [[], new Array(12), [...source.policy.weights, source.policy.weights[0]]]) {
      expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, policy: { ...source.policy, weights: invalid } })).toThrow();
    }
    for (const index of [0, 6, 11]) {
      const weight = source.policy.weights[index];
      for (const patch of [{ name: 'unexpected' }, { shape: [1000000000] }, { shape: new Array(weight.shape.length) },
        { values: new Array(weight.values.length) }, { values: [...weight.values, 0] },
        { values: [Infinity, ...weight.values.slice(1)] }, { values: [NaN, ...weight.values.slice(1)] },
        { values: [1e100, ...weight.values.slice(1)] }, { extra: true }]) {
        const weights = source.policy.weights.map((entry, current) => current === index ? { ...entry, ...patch } : entry);
        expect(() => FrozenPatrolPolicy.fromArtifact({ ...source, policy: { ...source.policy, weights } })).toThrow();
      }
    }
  });

  it('rejects malformed observations and masks before inference', () => {
    const frozen = FrozenPatrolPolicy.fromArtifact(artifact());
    const observation = Array<number>(RL_OBSERVATION_SIZE).fill(0);
    const validActions = masks();
    for (const invalid of [[], new Array(RL_OBSERVATION_SIZE), [...observation, 0],
      [NaN, ...observation.slice(1)], [Infinity, ...observation.slice(1)], [1e100, ...observation.slice(1)]]) {
      expect(() => frozen.act(invalid, validActions)).toThrow(/observation/);
    }
    for (const invalid of [[], new Array(8), [...validActions, validActions[0]],
      [new Array(27), ...validActions.slice(1)], [Array(27).fill(false), ...validActions.slice(1)],
      [Array(27).fill(1), ...validActions.slice(1)], [Array(28).fill(true), ...validActions.slice(1)]]) {
      expect(() => frozen.act(observation, invalid)).toThrow(/masks/);
    }
  });

  it('fails explicitly when finite inputs and weights overflow during inference', () => {
    const source = artifact();
    source.policy.weights[0].values.fill(3e38);
    const frozen = FrozenPatrolPolicy.fromArtifact(source);
    expect(() => frozen.act(Array(RL_OBSERVATION_SIZE).fill(3e38), masks())).toThrow(/activation/);
  });

  it('fails explicitly when finite first-layer activations overflow the normalization variance', () => {
    const source = artifact(agent(101, { actorNormalization: 'layer' }).exportCheckpoint());
    source.policy.weights[0].values.fill(0);
    source.policy.weights[1].values = Array.from({ length: 32 }, (_, index) => index % 2 ? 1e20 : -1e20);
    const frozen = FrozenPatrolPolicy.fromArtifact(source);
    expect(() => frozen.act(Array(RL_OBSERVATION_SIZE).fill(0), masks())).toThrow(/normalization/);
  });
});
