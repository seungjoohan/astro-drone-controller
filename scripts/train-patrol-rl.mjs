import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  smoke: { type: 'boolean', default: false },
  evaluate: { type: 'boolean', default: false },
  checkpoint: { type: 'string' },
  split: { type: 'string', default: 'validation' },
  seeds: { type: 'string', default: '42,73,101' },
  episodes: { type: 'string' },
  'scenario-seed': { type: 'string', default: '20261006' },
  'train-scenarios': { type: 'string', default: '8' },
  'validation-scenarios': { type: 'string', default: '4' },
  'reward-profile': { type: 'string' },
  'reward-scale': { type: 'string' },
  'gradient-clipping': { type: 'string' },
  'actor-normalization': { type: 'string' },
  'actor-architecture': { type: 'string' },
  'critic-normalization': { type: 'string' },
  output: { type: 'string' },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  process.stdout.write(`Patrol neural PPO experiment (headless, no live mission changes)

npm run train:patrol:rl -- --smoke
npm run train:patrol:rl -- --episodes 32 --seeds 42,73,101
npm run train:patrol:rl -- --episodes 64 --reward-scale 0.001 --gradient-clipping separate
npm run train:patrol:rl -- --episodes 64 --actor-normalization layer
npm run train:patrol:rl -- --episodes 64 --actor-architecture shared --reward-scale 0.001
npm run train:patrol:rl -- --episodes 64 --actor-architecture autoregressive --critic-normalization layer --reward-scale 0.001
npm run train:patrol:rl -- --episodes 64 --reward-profile legacy-v1
npm run benchmark:patrol:rl -- --checkpoint <policy.json>
npm run benchmark:patrol:rl -- --checkpoint <policy.json> --split final

--smoke                   Short plumbing check; never qualifies a fleet
--episodes N              Training episodes per seed, positive multiple of 8
--seeds N,N,...           Independent optimizer seeds (default 42,73,101)
--scenario-seed N         Scenario suite seed (default 20261006)
--train-scenarios N       Training cases (default 8, minimum 4)
--validation-scenarios N  Held-out cases (default 4, minimum 4)
--reward-profile PROFILE coverage-v2 (default) or legacy-v1 task reward
--reward-scale N          Positive reward/value unit conversion (default 1, 1e-8–1e8)
--gradient-clipping MODE  global (default) or separate actor/critic clipping
--actor-normalization MODE none (default) or layer normalization before actor hidden1 tanh
--actor-architecture MODE dense (default), shared, or autoregressive learned conditional scorer
--critic-normalization MODE none (default) or layer before critic hidden1 tanh
--output DIRECTORY       New local output directory (must not exist)
--evaluate               Evaluate a saved policy without updating weights
--checkpoint FILE        Versioned policy artifact from a previous run
--split validation|final Final split is evaluated only on explicit request

Full episodes include 120s warmup and three nominal battery/recharge periods.
Ctrl-C retains completed work and marks the report cancelled.
`);
  process.exit(0);
}

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}: expected integer ${minimum}–${maximum}.`);
  return parsed;
}

if (!['validation', 'final'].includes(values.split)) throw new Error('Split must be validation or final.');
if (!values.evaluate && values.split !== 'validation') throw new Error('Final tests require --evaluate with a frozen --checkpoint.');
if (values.evaluate !== !!values.checkpoint) throw new Error('Use --evaluate and --checkpoint together.');
if (values.evaluate && (values['reward-profile'] !== undefined || values['reward-scale'] !== undefined || values['gradient-clipping'] !== undefined
  || values['actor-normalization'] !== undefined || values['actor-architecture'] !== undefined
  || values['critic-normalization'] !== undefined)) throw new Error('Evaluation uses checkpoint reward and optimization settings; training overrides are not allowed.');
if (values['reward-profile'] !== undefined && !['legacy-v1', 'coverage-v2'].includes(values['reward-profile'])) throw new Error('Reward profile must be legacy-v1 or coverage-v2.');
const rewardScale = Number(values['reward-scale'] ?? '1');
if (!Number.isFinite(rewardScale) || rewardScale < 1e-8 || rewardScale > 1e8) throw new Error('Reward scale must be between 1e-8 and 1e8.');
const gradientClipping = values['gradient-clipping'] ?? 'global';
if (!['global', 'separate'].includes(gradientClipping)) throw new Error('Gradient clipping must be global or separate.');
const actorNormalization = values['actor-normalization'] ?? 'none';
if (!['none', 'layer'].includes(actorNormalization)) throw new Error('Actor normalization must be none or layer.');
const actorArchitecture = values['actor-architecture'] ?? 'dense';
if (!['dense', 'shared', 'autoregressive'].includes(actorArchitecture)) throw new Error('Actor architecture must be dense, shared or autoregressive.');
const criticNormalization = values['critic-normalization'] ?? 'none';
if (!['none', 'layer'].includes(criticNormalization)) throw new Error('Critic normalization must be none or layer.');
const episodes = integer(values.episodes ?? (values.smoke ? '8' : '32'), 'episodes', 8, 100000);
if (episodes % 8) throw new Error('Episodes must be a multiple of 8.');
const seeds = values.seeds.split(',').map(seed => integer(seed, 'optimizer seed', 1, 2147483647));
if (!seeds.length || seeds.length > 20 || new Set(seeds).size !== seeds.length) throw new Error('Use 1–20 distinct optimizer seeds.');
const scenarioSeed = integer(values['scenario-seed'], 'scenario seed', 1, 2147483647);
const trainCount = integer(values['train-scenarios'], 'training scenarios', 4, 4096);
const validationCount = integer(values['validation-scenarios'], 'validation scenarios', 4, 4096);
const directory = resolve(values.output ?? `test-results/patrol-rl-${new Date().toISOString().replaceAll(':', '-')}`);
const sourcePaths = ['src/patrol.ts', 'src/patrol-external.ts', 'src/patrol-environment.ts', 'src/population.ts',
  'src/patrol-policy.ts', 'src/patrol-audit.ts', 'src/patrol-evaluator.ts', 'src/patrol-rl-contract.ts',
  'src/patrol-rl-environment.ts', 'src/patrol-rl-reward.ts', 'src/patrol-rl-scenarios.ts', 'src/patrol-rl-network.ts', 'src/patrol-rl-shared-features.ts', 'src/patrol-rl-coordination.ts', 'src/patrol-rl-experiment.ts',
  'scripts/train-patrol-rl.mjs', 'package.json', 'package-lock.json'];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const save = async (name, value) => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
let directoryCreated = false;
let cancelled = false;
const stop = () => { cancelled = true; process.stdout.write('\nStopping after the current simulation step/update.\n'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let activeAgent;

try {
  const { RL_PROTOCOL_VERSION, RL_OBSERVATION_SIZE } = await server.ssrLoadModule('/src/patrol-rl-contract.ts');
  const { createRLScenarios } = await server.ssrLoadModule('/src/patrol-rl-scenarios.ts');
  const { PPOAgent } = await server.ssrLoadModule('/src/patrol-rl-network.ts');
  const { trainRLPolicy, evaluateRLPolicy, summarizeRLEvaluation } = await server.ssrLoadModule('/src/patrol-rl-experiment.ts');
  const { DEFAULT_RL_REWARD_PROFILE, rewardMetadata, validateRewardMetadata } = await server.ssrLoadModule('/src/patrol-rl-reward.ts');
  const shorten = scenario => values.smoke && scenario.fault ? { ...scenario, fault: { ...scenario.fault, atSeconds: 40 } } : scenario;
  const trainingScenarios = createRLScenarios('train', scenarioSeed, trainCount).map(shorten);
  const evaluationScenarios = createRLScenarios(values.split, scenarioSeed, validationCount).map(shorten);
  const episode = values.smoke ? { warmupSeconds: 20, durationSeconds: 60 } : undefined;
  const settings = { episodes, seeds, scenarioSeed, trainCount, validationCount, smoke: values.smoke, split: values.split, episode,
    rewardProfile: values['reward-profile'] ?? DEFAULT_RL_REWARD_PROFILE,
    optimization: { rewardScale, gradientClipping, actorNormalization, actorArchitecture, criticNormalization } };
  const provenance = { gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), sourceHashes };
  let artifact;
  let inputPolicy;
  if (values.evaluate) {
    const serialized = await readFile(resolve(values.checkpoint), 'utf8');
    artifact = JSON.parse(serialized);
    if (artifact.format !== 'astro-patrol-rl-policy' || ![1, 2].includes(artifact.version) || artifact.protocolVersion !== RL_PROTOCOL_VERSION
      || artifact.policy?.observationSize !== RL_OBSERVATION_SIZE) throw new Error('Incompatible RL policy artifact.');
    if (artifact.version === 2) {
      settings.rewardProfile = validateRewardMetadata(artifact.reward);
      if (artifact.settings?.rewardProfile !== settings.rewardProfile) throw new Error('Policy reward profile settings do not match reward metadata.');
    } else {
      settings.rewardProfile = 'legacy-v1';
      if (artifact.settings?.rewardProfile !== undefined && artifact.settings.rewardProfile !== settings.rewardProfile
        || artifact.reward !== undefined && validateRewardMetadata(artifact.reward) !== settings.rewardProfile) throw new Error('Version 1 policy artifacts require the legacy-v1 reward profile.');
    }
    if (sourcePaths.some(path => artifact.provenance?.sourceHashes?.[path] !== sourceHashes[path])) throw new Error('Policy source fingerprint differs from this implementation. Evaluate using its original code/dependency versions.');
    const restored = PPOAgent.fromCheckpoint(artifact.policy);
    settings.optimization = { rewardScale: restored.options.rewardScale, gradientClipping: restored.options.gradientClipping,
      actorNormalization: restored.options.actorNormalization, actorArchitecture: restored.options.actorArchitecture,
      criticNormalization: restored.options.criticNormalization };
    restored.dispose();
    inputPolicy = { path: resolve(values.checkpoint), sha256: createHash('sha256').update(serialized).digest('hex'),
      seed: artifact.policy.seed, trainingSettings: artifact.settings, completedEpisodes: artifact.completedEpisodes };
  }
  const reward = rewardMetadata(settings.rewardProfile);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  directoryCreated = true;
  await save('protocol.json', { protocolVersion: RL_PROTOCOL_VERSION, settings, reward, provenance, inputPolicy,
    note: 'Neural PPO controls motion targets/speed/return/standby, without ownership or urgency-score routing. The versioned reward profile defines task rewards independently of optimization settings. Reward scaling converts critic units only; task rewards and service metrics remain raw. Shared actors learn candidate scores; autoregressive actors additionally condition on earlier actions in canonical observed-drone order, replayed with teacher forcing during PPO updates. Neither applies a fixed route ranking. Actor and critic layer normalization independently normalize first-layer preactivations with epsilon 1e-5 and no learned affine terms. Safety and action space are unchanged. CPU training only; live app unchanged. Smoke results are not qualification evidence.' });
  await save('scenarios.json', { training: values.evaluate ? [] : trainingScenarios, evaluation: evaluationScenarios,
    finalTestUsed: values.split === 'final', note: 'Fault schedules and scenario identities are not policy observations. Final scenarios are never generated by training runs.' });
  process.stdout.write(`Artifacts: ${directory}\n${values.smoke ? 'SMOKE: short episodes, no fleet qualification.' : 'Full battery-cycle protocol.'}\n`);
  const runs = [];
  const runSeeds = values.evaluate ? [seeds[0]] : seeds;
  for (const seed of runSeeds) {
    if (cancelled) break;
    let training = null;
    if (values.evaluate) {
      activeAgent = PPOAgent.fromCheckpoint(artifact.policy);
    } else {
      training = await trainRLPolicy(trainingScenarios, { seed, episodes, episode, rewardProfile: settings.rewardProfile, cancelled: () => cancelled,
        ppo: { rewardScale, gradientClipping, actorNormalization, actorArchitecture, criticNormalization, ...(values.smoke ? { epochs: 2, minibatchSize: 32 } : {}) },
        onEpisode: (result, number) => process.stdout.write(`Seed ${seed}: episode ${number}/${episodes}, fleet ${result.fleetSize}, ${result.family}, gap ${result.metrics.gapCost?.toFixed(3) ?? 'N/A'}\n`) });
      activeAgent = training.agent;
      await save(`policy-${seed}.json`, { format: 'astro-patrol-rl-policy', version: 2, protocolVersion: RL_PROTOCOL_VERSION,
        createdAt: new Date().toISOString(), settings, reward, provenance, completedEpisodes: training.episodes.length,
        trainingSteps: training.steps, cancelled: training.cancelled, policy: activeAgent.exportCheckpoint(),
        note: 'Experimental weights, not approved for automatic application. Inference/warm-start artifact, not exact optimizer resume.' });
      await save(`training-${seed}.json`, { episodes: training.episodes, updates: training.updates, steps: training.steps, cancelled: training.cancelled });
    }
    const results = cancelled ? [] : await evaluateRLPolicy(activeAgent, evaluationScenarios, { episode, rewardProfile: settings.rewardProfile, cancelled: () => cancelled,
      onEpisode: result => {
        if (result.controller === 'neural') process.stdout.write(`Evaluate seed ${activeAgent.seed}: ${result.scenarioId}, fleet ${result.fleetSize}, crowded ${result.metrics.hotspotOnTime?.toFixed(1) ?? 'N/A'}%, audit ${result.metrics.auditAreaMinimum.toFixed(1)}%\n`);
      } });
    const summary = summarizeRLEvaluation(results, evaluationScenarios);
    const evaluatedSeed = activeAgent.seed;
    await save(`evaluation-${evaluatedSeed}.json`, { seed: evaluatedSeed, rewardProfile: settings.rewardProfile, reward, results, summary });
    runs.push({ seed: evaluatedSeed, episodes: training?.episodes.length ?? null, steps: training?.steps ?? null, ...summary });
    activeAgent.dispose();
    activeAgent = undefined;
  }
  const report = { createdAt: new Date().toISOString(), protocolVersion: RL_PROTOCOL_VERSION, settings, reward, provenance, inputPolicy,
    status: cancelled ? 'cancelled' : 'completed', runs, promotionEligible: false,
    note: values.smoke ? 'Plumbing smoke test only. Short episodes cannot qualify fleet size or demonstrate robust learning.'
      : 'Compare per-scenario paired results and independent optimizer seeds. No automatic live-policy changes. Healthy fleet qualification does not establish resilience or global optimality.' };
  await save('report.json', report);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: directory, runs: runs.map(run => ({ seed: run.seed,
    complete: run.complete, smallestValidatedFleet: run.smallestValidatedFleet, steps: run.steps })), promotionEligible: false }, null, 2)}\n`);
  if (cancelled) process.exitCode = 130;
} catch (error) {
  if (directoryCreated) await save('error.json', { message: error instanceof Error ? error.message : String(error), cancelled });
  throw error;
} finally {
  activeAgent?.dispose();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await server.close();
}
