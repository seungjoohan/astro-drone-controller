import { createServer } from 'vite';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  run: { type: 'string' },
  'default-seed': { type: 'string', default: '101' },
  help: { type: 'boolean', default: false },
} });
if (values.help || !values.run) {
  process.stdout.write('node scripts/prepare-patrol-preview.mjs --run test-results/<completed-training-run> [--default-seed 101]\nModels remain in ignored .local/ and are served only by the Vite development server.\n');
  process.exit(values.help ? 0 : 1);
}
const defaultSeed = Number(values['default-seed']);
if (!Number.isInteger(defaultSeed) || defaultSeed < 1 || defaultSeed > 2147483647) throw new Error('Invalid default policy seed.');
const source = resolve(values.run);
const readJson = async name => JSON.parse(await readFile(resolve(source, name), 'utf8'));
const report = await readJson('report.json');
const scenarios = await readJson('scenarios.json');
if (report.status !== 'completed' || !Array.isArray(report.runs) || !report.runs.length || report.runs.length > 20
  || report.runs.some(run => !run.complete || !Number.isInteger(run.seed) || run.seed < 1 || run.seed > 2147483647)
  || new Set(report.runs.map(run => run.seed)).size !== report.runs.length || !report.runs.some(run => run.seed === defaultSeed)
  || !Array.isArray(scenarios.evaluation) || !scenarios.evaluation.length || scenarios.evaluation.length > 4096) throw new Error('A complete training/evaluation run with the requested seed is required.');

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let staging;
try {
  const { FrozenPatrolPolicy } = await server.ssrLoadModule('/src/patrol-rl-inference.ts');
  const { validateRewardMetadata } = await server.ssrLoadModule('/src/patrol-rl-reward.ts');
  const { RL_PROTOCOL_VERSION } = await server.ssrLoadModule('/src/patrol-rl-contract.ts');
  const { validateEnvironment } = await server.ssrLoadModule('/src/patrol-environment.ts');
  const { createRLScenarios } = await server.ssrLoadModule('/src/patrol-rl-scenarios.ts');
  if (report.protocolVersion !== RL_PROTOCOL_VERSION || scenarios.finalTestUsed
    || scenarios.evaluation.some(scenario => scenario.split !== 'validation' || !validateEnvironment(scenario.environment))) throw new Error('Only compatible validation scenarios can be published in this experimental preview.');
  const expectedScenarios = createRLScenarios('validation', report.settings?.scenarioSeed, report.settings?.validationCount)
    .map(scenario => report.settings.smoke && scenario.fault ? { ...scenario, fault: { ...scenario.fault, atSeconds: 40 } } : scenario);
  if (JSON.stringify(scenarios.evaluation) !== JSON.stringify(expectedScenarios)) throw new Error('Saved validation scenarios do not match this run and scenario generator.');
  const runtimePaths = ['src/patrol.ts', 'src/patrol-external.ts', 'src/patrol-environment.ts', 'src/population.ts',
    'src/patrol-policy.ts', 'src/patrol-audit.ts', 'src/patrol-evaluator.ts', 'src/patrol-rl-contract.ts', 'src/patrol-rl-environment.ts', 'src/patrol-rl-scenarios.ts'];
  const sharedFeaturePath = 'src/patrol-rl-shared-features.ts';
  const coordinatedFeaturePath = 'src/patrol-rl-coordination.ts';
  const rewardPath = 'src/patrol-rl-reward.ts';
  const currentHashes = Object.fromEntries(await Promise.all([...runtimePaths, sharedFeaturePath, coordinatedFeaturePath].map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const policies = await Promise.all(report.runs.map(async run => {
    const serialized = await readFile(resolve(source, `policy-${run.seed}.json`), 'utf8');
    const artifact = JSON.parse(serialized);
    const policy = FrozenPatrolPolicy.fromArtifact(artifact);
    if (policy.seed !== run.seed || policy.completedEpisodes !== run.episodes || policy.trainingSteps !== run.steps || artifact.cancelled !== false
      || runtimePaths.some(path => artifact.provenance?.sourceHashes?.[path] !== currentHashes[path])) throw new Error(`Policy ${run.seed} does not match this runtime or completed run.`);
    if (['shared', 'autoregressive'].includes(artifact.policy.options.actorArchitecture)
      && artifact.provenance?.sourceHashes?.[sharedFeaturePath] !== currentHashes[sharedFeaturePath]) throw new Error(`Policy ${run.seed} shared actor features do not match this runtime.`);
    if (artifact.policy.options.actorArchitecture === 'autoregressive'
      && artifact.provenance?.sourceHashes?.[coordinatedFeaturePath] !== currentHashes[coordinatedFeaturePath]) throw new Error(`Policy ${run.seed} coordinated actor features do not match this runtime.`);
    if (artifact.version === 2) {
      const profile = validateRewardMetadata(artifact.reward);
      if (validateRewardMetadata(report.reward) !== profile || report.settings?.rewardProfile !== profile
        || artifact.settings?.rewardProfile !== profile) throw new Error(`Policy ${run.seed} reward metadata does not match this run.`);
      if (artifact.provenance?.sourceHashes?.[rewardPath] !== createHash('sha256').update(await readFile(rewardPath)).digest('hex')) {
        throw new Error(`Policy ${run.seed} reward source does not match this runtime.`);
      }
    } else if (report.reward !== undefined && validateRewardMetadata(report.reward) !== 'legacy-v1'
      || report.settings?.rewardProfile !== undefined && report.settings.rewardProfile !== 'legacy-v1') {
      throw new Error(`Legacy policy ${run.seed} cannot use a different reward profile.`);
    }
    return { serialized, seed: policy.seed, episodes: policy.completedEpisodes, sha256: createHash('sha256').update(serialized).digest('hex') };
  }));
  await mkdir('.local', { recursive: true });
  staging = await mkdtemp(resolve('.local/patrol-preview-staging-'));
  for (const policy of policies) await writeFile(resolve(staging, `policy-${policy.seed}.json`), policy.serialized, { flag: 'wx' });
  const manifest = {
    version: 1, defaultSeed, runLabel: basename(source), protocolVersion: RL_PROTOCOL_VERSION,
    experimental: true, runtimeSourceVerified: true,
    ...(report.reward === undefined ? {} : { reward: report.reward }),
    models: policies.map(policy => ({ seed: policy.seed, path: `/__patrol_preview/policy-${policy.seed}.json`, episodes: policy.episodes, sha256: policy.sha256 })),
    scenarios: scenarios.evaluation,
  };
  await writeFile(resolve(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const destination = resolve('.local/patrol-preview');
  const previous = resolve('.local', `patrol-preview-previous-${Date.now()}`);
  let movedPrevious = false;
  try {
    await rename(destination, previous);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, destination);
    staging = undefined;
  } catch (error) {
    if (movedPrevious) await rename(previous, destination);
    throw error;
  }
  if (movedPrevious) await rm(previous, { recursive: true });
  process.stdout.write(`Prepared ${policies.length} frozen policies; default seed ${defaultSeed}.\nOpen http://127.0.0.1:5173/neural.html after starting npm run dev.\nThis is a local experimental preview, not a qualified patrol controller.\n`);
} finally {
  if (staging) await rm(staging, { recursive: true });
  await server.close();
}
