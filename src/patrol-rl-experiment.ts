import { PPOAgent } from './patrol-rl-network';
import { RL_MAX_DRONES, RL_OBSERVATION_SIZE, rlRandom } from './patrol-rl-contract';
import { RLPatrolEnvironment, selectValidatedRLFleet } from './patrol-rl-environment';
import { DEFAULT_RL_REWARD_PROFILE, rewardMetadata } from './patrol-rl-reward';
import type { PPOOptions, PPOTransition, PPOUpdateMetrics } from './patrol-rl-network';
import type { RLEnvironmentOptions, RLEpisodeResult } from './patrol-rl-environment';
import type { RLScenario } from './patrol-rl-scenarios';
import type { RLRewardProfile } from './patrol-rl-reward';

export interface RLTrainingOptions {
  seed: number;
  episodes: number;
  rolloutSteps?: number;
  ppo?: Partial<PPOOptions>;
  rewardProfile?: RLRewardProfile;
  episode?: Pick<RLEnvironmentOptions, 'warmupSeconds' | 'durationSeconds'>;
  onEpisode?: (result: RLEpisodeResult, episode: number) => void | Promise<void>;
  onUpdate?: (metrics: PPOUpdateMetrics) => void;
  cancelled?: () => boolean;
}

export interface RLTrainingResult {
  agent: PPOAgent;
  rewardProfile: RLRewardProfile;
  episodes: RLEpisodeResult[];
  updates: PPOUpdateMetrics[];
  steps: number;
  cancelled: boolean;
}

export interface RLEvaluationOptions {
  rewardProfile?: RLRewardProfile;
  episode?: Pick<RLEnvironmentOptions, 'warmupSeconds' | 'durationSeconds'>;
  onEpisode?: (result: RLEpisodeResult) => void | Promise<void>;
  cancelled?: () => boolean;
}

function shuffle(values: number[], random: () => number): number[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [values[index], values[selected]] = [values[selected], values[index]];
  }
  return values;
}

const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function trainRLPolicy(scenarios: readonly RLScenario[], options: RLTrainingOptions): Promise<RLTrainingResult> {
  const rewardProfile = rewardMetadata(options.rewardProfile ?? DEFAULT_RL_REWARD_PROFILE).profile;
  if (!scenarios.length || scenarios.some(scenario => scenario.split !== 'train')) throw new Error('Only training scenarios may update the policy.');
  if (!Number.isInteger(options.episodes) || options.episodes < RL_MAX_DRONES || options.episodes % RL_MAX_DRONES !== 0) throw new Error('Train in blocks of 8 episodes so every fleet size is included.');
  const rolloutSteps = options.rolloutSteps ?? 64;
  if (!Number.isInteger(rolloutSteps) || rolloutSteps < 2 || rolloutSteps > 4096) throw new Error('Invalid RL rollout length.');
  const random = rlRandom(options.seed);
  const agent = new PPOAgent(RL_OBSERVATION_SIZE, options.seed, options.ppo);
  const episodes: RLEpisodeResult[] = [];
  const updates: PPOUpdateMetrics[] = [];
  let transitions: PPOTransition[] = [];
  let steps = 0;
  let fleetOrder: number[] = [];
  let scenarioOrder: number[] = [];
  const update = (bootstrapValue: number) => {
    if (!transitions.length) return;
    const metrics = agent.update(transitions, bootstrapValue);
    updates.push(metrics);
    options.onUpdate?.(metrics);
    transitions = [];
  };
  try {
    for (let episode = 0; episode < options.episodes && !options.cancelled?.(); episode += 1) {
      if (episode % RL_MAX_DRONES === 0) fleetOrder = shuffle(Array.from({ length: RL_MAX_DRONES }, (_, index) => index + 1), random);
      if (episode % scenarios.length === 0) scenarioOrder = shuffle(scenarios.map((_scenario, index) => index), random);
      const scenario = scenarios[scenarioOrder[episode % scenarios.length]];
      const environment = new RLPatrolEnvironment(scenario, fleetOrder[episode % RL_MAX_DRONES],
        { ...options.episode, rewardProfile, slotSeed: 1 + Math.floor(random() * 2147483647) });
      while (!environment.done && !options.cancelled?.()) {
        const { observation, masks } = environment.observation();
        const action = agent.act(observation, masks);
        const outcome = environment.step(action.actions);
        const nextValue = agent.value(environment.observation().observation);
        transitions.push({ observation, masks, ...action, ...outcome, nextValue });
        steps += 1;
        if (transitions.length >= rolloutSteps) update(nextValue);
        if (steps % 16 === 0) await yieldTask();
      }
      if (!environment.done) break;
      const result = environment.result();
      episodes.push(result);
      await options.onEpisode?.(result, episode + 1);
    }
    if (!options.cancelled?.()) update(0);
    return { agent, rewardProfile, episodes, updates, steps, cancelled: options.cancelled?.() ?? false };
  } catch (error) {
    agent.dispose();
    throw error;
  }
}

export async function evaluateRLPolicy(agent: PPOAgent, scenarios: readonly RLScenario[], options: RLEvaluationOptions = {}): Promise<RLEpisodeResult[]> {
  const rewardProfile = rewardMetadata(options.rewardProfile ?? DEFAULT_RL_REWARD_PROFILE).profile;
  if (!scenarios.length || scenarios.some(scenario => scenario.split === 'train')) throw new Error('Evaluation requires held-out scenarios.');
  if (agent.observationSize !== RL_OBSERVATION_SIZE) throw new Error('Policy observation schema does not match the patrol environment.');
  const results: RLEpisodeResult[] = [];
  for (const scenario of scenarios) {
    for (let fleetSize = 1; fleetSize <= RL_MAX_DRONES; fleetSize += 1) {
      for (const controller of ['uniform', 'adaptive', 'neural'] as const) {
        const environment = new RLPatrolEnvironment(scenario, fleetSize, { ...options.episode, controller, rewardProfile });
        let steps = 0;
        while (!environment.done) {
          if (options.cancelled?.()) return results;
          if (controller === 'neural') {
            const { observation, masks } = environment.observation();
            environment.step(agent.act(observation, masks, true).actions);
          } else environment.step();
          steps += 1;
          if (steps % 16 === 0) await yieldTask();
        }
        const result = environment.result();
        results.push(result);
        await options.onEpisode?.(result);
      }
    }
  }
  return results;
}

export function summarizeRLEvaluation(results: readonly RLEpisodeResult[], scenarios: readonly RLScenario[]) {
  const rewardProfiles = new Set(results.map(result => rewardMetadata(result.rewardProfile).profile));
  if (rewardProfiles.size > 1) throw new Error('Cannot summarize mixed RL reward profiles');
  const healthyIds = scenarios.filter(scenario => !scenario.fault).map(scenario => scenario.id);
  const complete = scenarios.length > 0 && new Set(scenarios.map(scenario => scenario.id)).size === scenarios.length
    && results.length === scenarios.length * RL_MAX_DRONES * 3
    && scenarios.every(scenario => Array.from({ length: RL_MAX_DRONES }, (_, index) => index + 1).every(fleetSize =>
      ['uniform', 'adaptive', 'neural'].every(controller => results.filter(result => result.scenarioId === scenario.id && result.fleetSize === fleetSize && result.controller === controller).length === 1)));
  const smallestValidatedFleet = complete ? selectValidatedRLFleet(results, healthyIds) : null;
  const paired = results.filter(result => result.controller === 'neural').map(neural => {
    const uniform = results.find(result => result.scenarioId === neural.scenarioId && result.fleetSize === neural.fleetSize && result.controller === 'uniform');
    const adaptive = results.find(result => result.scenarioId === neural.scenarioId && result.fleetSize === neural.fleetSize && result.controller === 'adaptive');
    const comparable = !!uniform && !!adaptive && (!neural.fault || neural.faultApplied && uniform.faultApplied && adaptive.faultApplied);
    return {
      scenarioId: neural.scenarioId, fleetSize: neural.fleetSize, fault: neural.fault,
      comparable, faultApplied: { neural: neural.faultApplied, uniform: uniform?.faultApplied ?? false, adaptive: adaptive?.faultApplied ?? false },
      gapReductionVsUniformPercent: comparable && uniform?.metrics.gapCost && neural.metrics.gapCost !== null ? 100 * (1 - neural.metrics.gapCost / uniform.metrics.gapCost) : null,
      gapReductionVsAdaptivePercent: comparable && adaptive?.metrics.gapCost && neural.metrics.gapCost !== null ? 100 * (1 - neural.metrics.gapCost / adaptive.metrics.gapCost) : null,
      unobservedFraction: neural.unobservedFraction,
      areaMinimum: neural.metrics.auditAreaMinimum,
      hotspotOnTime: neural.metrics.hotspotOnTime,
    };
  });
  return { complete, smallestValidatedFleet, promotionEligible: false,
    note: 'Experimental learned controller. A finite healthy-suite fleet result is not an optimality, resilience, or deployment guarantee. No automatic promotion.', paired };
}
