import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prepareScript = join(repository, 'scripts/prepare-patrol-preview.mjs');
const sharedFeaturePath = 'src/patrol-rl-shared-features.ts';
const coordinatedFeaturePath = 'src/patrol-rl-coordination.ts';
const rewardPath = 'src/patrol-rl-reward.ts';
const runtimePaths = ['src/patrol.ts', 'src/patrol-external.ts', 'src/patrol-environment.ts', 'src/population.ts',
  'src/patrol-policy.ts', 'src/patrol-audit.ts', 'src/patrol-evaluator.ts', 'src/patrol-rl-contract.ts',
  'src/patrol-rl-environment.ts', 'src/patrol-rl-scenarios.ts'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function directoryHashes(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const hashes = {};
  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    const path = join(directory, entry.name);
    hashes[entry.name] = entry.isDirectory() ? await directoryHashes(path) : hash(await readFile(path));
  }
  return hashes;
}

function legacyCheckpoint(checkpoint, version) {
  const copy = structuredClone(checkpoint);
  copy.version = version;
  if (version < 5) delete copy.options.criticNormalization;
  if (version < 4) delete copy.options.actorArchitecture;
  if (version < 3) delete copy.options.actorNormalization;
  if (version < 2) {
    delete copy.options.rewardScale;
    delete copy.options.gradientClipping;
  }
  return copy;
}

test('preview preparation validates versioned reward and feature provenance without replacing incompatible previews', { timeout: 180000 }, async context => {
  const realPreview = join(repository, '.local/patrol-preview');
  const realPreviewBefore = await directoryHashes(realPreview);
  const directory = await mkdtemp(join(tmpdir(), 'patrol-preview-preparation-'));
  try {
    await cp(join(repository, 'src'), join(directory, 'src'), { recursive: true });
    await cp(join(repository, 'package.json'), join(directory, 'package.json'));
    await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const server = await createServer({ root: directory, cacheDir: join(directory, '.vite'), configFile: false,
      server: { middlewareMode: true, hmr: false }, appType: 'custom' });
    let denseCheckpoint;
    let sharedCheckpoint;
    let coordinatedCheckpoint;
    let normalizedCoordinatedCheckpoint;
    let protocolVersion;
    let evaluation;
    let rewardMetadata;
    try {
      const { PPOAgent } = await server.ssrLoadModule('/src/patrol-rl-network.ts');
      const { RL_OBSERVATION_SIZE, RL_PROTOCOL_VERSION } = await server.ssrLoadModule('/src/patrol-rl-contract.ts');
      const { createRLScenarios } = await server.ssrLoadModule('/src/patrol-rl-scenarios.ts');
      ({ rewardMetadata } = await server.ssrLoadModule('/src/patrol-rl-reward.ts'));
      protocolVersion = RL_PROTOCOL_VERSION;
      evaluation = createRLScenarios('validation', 20261006, 4);
      for (const actorArchitecture of ['dense', 'shared', 'autoregressive']) {
        const agent = new PPOAgent(RL_OBSERVATION_SIZE, 101, { actorArchitecture });
        try {
          const checkpoint = agent.exportCheckpoint();
          if (actorArchitecture === 'dense') denseCheckpoint = checkpoint;
          else if (actorArchitecture === 'shared') sharedCheckpoint = checkpoint;
          else coordinatedCheckpoint = checkpoint;
        } finally {
          agent.dispose();
        }
      }
      const normalizedAgent = new PPOAgent(RL_OBSERVATION_SIZE, 101, { actorArchitecture: 'autoregressive', criticNormalization: 'layer' });
      try {
        normalizedCoordinatedCheckpoint = normalizedAgent.exportCheckpoint();
      } finally {
        normalizedAgent.dispose();
      }
    } finally {
      await server.close();
    }
    const sourceHashes = Object.fromEntries(await Promise.all([...runtimePaths, sharedFeaturePath, coordinatedFeaturePath, rewardPath].map(async path =>
      [path, hash(await readFile(join(directory, path)))])));
    const source = join(directory, 'fixture-run');
    await mkdir(source);
    const report = { status: 'completed', protocolVersion,
      settings: { scenarioSeed: 20261006, validationCount: 4, smoke: false },
      runs: [{ complete: true, seed: 101, episodes: 1, steps: 1 }] };
    const writeReport = value => writeFile(join(source, 'report.json'), JSON.stringify(value));
    await writeReport(report);
    await writeFile(join(source, 'scenarios.json'), JSON.stringify({ evaluation, finalTestUsed: false }));
    const preview = join(directory, '.local/patrol-preview');
    const execute = () => spawnSync(process.execPath, [prepareScript, '--run', source], {
      cwd: directory, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024,
    });
    const writePolicy = async (policy, hashes, metadata = {}) => {
      const serialized = JSON.stringify({ format: 'astro-patrol-rl-policy', version: 1, protocolVersion,
        completedEpisodes: 1, trainingSteps: 1, cancelled: false, policy, provenance: { sourceHashes: hashes }, ...metadata });
      await writeFile(join(source, 'policy-101.json'), serialized);
      return serialized;
    };

    for (const mutation of ['missing', 'tampered']) {
      await context.test(`rejects a ${mutation} shared feature fingerprint before replacing preview files`, async () => {
        await mkdir(preview, { recursive: true });
        await writeFile(join(preview, 'manifest.json'), '{"existingPreview":true}\n');
        const previous = await directoryHashes(preview);
        const incompatibleHashes = { ...sourceHashes };
        if (mutation === 'missing') delete incompatibleHashes[sharedFeaturePath];
        else incompatibleHashes[sharedFeaturePath] = '0'.repeat(64);
        await writePolicy(sharedCheckpoint, incompatibleHashes);
        const result = execute();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /shared actor features do not match this runtime/);
        assert.deepEqual(await directoryHashes(preview), previous);
        assert.deepEqual(await readdir(join(directory, '.local')), ['patrol-preview']);
      });
    }

    for (const version of [1, 2, 3, 4, 5]) {
      await context.test(`accepts a compatible v${version} dense checkpoint without a shared feature fingerprint`, async () => {
        const legacyHashes = { ...sourceHashes };
        delete legacyHashes[sharedFeaturePath];
        delete legacyHashes[coordinatedFeaturePath];
        delete legacyHashes[rewardPath];
        const serialized = await writePolicy(legacyCheckpoint(denseCheckpoint, version), legacyHashes);
        const result = execute();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(join(preview, 'policy-101.json'), 'utf8'), serialized);
        const manifest = JSON.parse(await readFile(join(preview, 'manifest.json'), 'utf8'));
        assert.equal(manifest.runtimeSourceVerified, true);
        assert.equal(manifest.models[0].sha256, hash(serialized));
        assert.deepEqual(manifest.scenarios, evaluation);
        assert.deepEqual(await readdir(join(directory, '.local')), ['patrol-preview']);
      });
    }

    await context.test('accepts a shared checkpoint with a matching feature fingerprint', async () => {
      const legacyHashes = { ...sourceHashes };
      delete legacyHashes[rewardPath];
      const serialized = await writePolicy(sharedCheckpoint, legacyHashes);
      const result = execute();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(join(preview, 'policy-101.json'), 'utf8'), serialized);
      const manifest = JSON.parse(await readFile(join(preview, 'manifest.json'), 'utf8'));
      assert.equal(manifest.models[0].sha256, hash(serialized));
      assert.equal(manifest.runtimeSourceVerified, true);
    });

    for (const version of [4, 5]) {
      await context.test(`accepts a v${version} shared checkpoint without a coordinated feature fingerprint`, async () => {
        const compatibleHashes = { ...sourceHashes };
        delete compatibleHashes[coordinatedFeaturePath];
        const serialized = await writePolicy(legacyCheckpoint(sharedCheckpoint, version), compatibleHashes);
        const result = execute();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(join(preview, 'policy-101.json'), 'utf8'), serialized);
      });
    }

    for (const path of [sharedFeaturePath, coordinatedFeaturePath]) {
      for (const mutation of ['missing', 'tampered']) {
        await context.test(`rejects ${mutation} ${path} for an autoregressive policy before replacing files`, async () => {
          const previous = await directoryHashes(preview);
          const incompatibleHashes = { ...sourceHashes };
          if (mutation === 'missing') delete incompatibleHashes[path];
          else incompatibleHashes[path] = '0'.repeat(64);
          await writePolicy(coordinatedCheckpoint, incompatibleHashes);
          const result = execute();
          assert.equal(result.error, undefined);
          assert.equal(result.status, 1, result.stderr);
          assert.match(result.stderr, /actor features do not match this runtime/);
          assert.deepEqual(await directoryHashes(preview), previous);
          assert.deepEqual(await readdir(join(directory, '.local')), ['patrol-preview']);
        });
      }
    }

    for (const fixture of [
      { name: 'v5 missing critic normalization', policy: { ...denseCheckpoint, options: { ...denseCheckpoint.options, criticNormalization: undefined } } },
      { name: 'v5 unknown critic normalization', policy: { ...denseCheckpoint, options: { ...denseCheckpoint.options, criticNormalization: 'batch' } } },
      { name: 'v4 critic normalization relabel', policy: { ...sharedCheckpoint, version: 4 } },
      { name: 'v4 autoregressive relabel', policy: legacyCheckpoint(coordinatedCheckpoint, 4) },
    ]) {
      await context.test(`rejects ${fixture.name} without replacing files`, async () => {
        const previous = await directoryHashes(preview);
        await writePolicy(fixture.policy, sourceHashes);
        const result = execute();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /checkpoint format or architecture/);
        assert.deepEqual(await directoryHashes(preview), previous);
      });
    }

    for (const rewardProfile of ['legacy-v1', 'coverage-v2']) {
      const metadata = { version: 2, reward: rewardMetadata(rewardProfile), settings: { rewardProfile } };
      const currentReport = { ...report, reward: metadata.reward, settings: { ...report.settings, rewardProfile } };
      for (const actorArchitecture of ['dense', 'shared', 'autoregressive']) {
        await context.test(`accepts v2 ${actorArchitecture} artifacts with canonical ${rewardProfile} metadata`, async () => {
          await writeReport(currentReport);
          const checkpoint = actorArchitecture === 'autoregressive' ? coordinatedCheckpoint : actorArchitecture === 'shared' ? sharedCheckpoint : denseCheckpoint;
          const serialized = await writePolicy(checkpoint, sourceHashes, metadata);
          const result = execute();
          assert.equal(result.error, undefined);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(await readFile(join(preview, 'policy-101.json'), 'utf8'), serialized);
          const manifest = JSON.parse(await readFile(join(preview, 'manifest.json'), 'utf8'));
          assert.deepEqual(manifest.reward, metadata.reward);
          assert.equal(manifest.models[0].sha256, hash(serialized));
        });
      }
      await context.test(`accepts v5 autoregressive critic normalization with canonical ${rewardProfile} metadata`, async () => {
        await writeReport(currentReport);
        const serialized = await writePolicy(normalizedCoordinatedCheckpoint, sourceHashes, metadata);
        const result = execute();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(join(preview, 'policy-101.json'), 'utf8'), serialized);
      });
      for (const mutation of ['missing', 'tampered']) {
        await context.test(`rejects a ${mutation} ${rewardProfile} reward source fingerprint without replacing files`, async () => {
          const previous = await directoryHashes(preview);
          const incompatibleHashes = { ...sourceHashes };
          if (mutation === 'missing') delete incompatibleHashes[rewardPath];
          else incompatibleHashes[rewardPath] = '0'.repeat(64);
          await writeReport(currentReport);
          await writePolicy(sharedCheckpoint, incompatibleHashes, metadata);
          const result = execute();
          assert.equal(result.error, undefined);
          assert.equal(result.status, 1, result.stderr);
          assert.match(result.stderr, /reward source does not match this runtime/);
          assert.deepEqual(await directoryHashes(preview), previous);
          assert.deepEqual(await readdir(join(directory, '.local')), ['patrol-preview']);
        });
      }
    }

    const metadata = { version: 2, reward: rewardMetadata('coverage-v2'), settings: { rewardProfile: 'coverage-v2' } };
    const currentReport = { ...report, reward: metadata.reward, settings: { ...report.settings, rewardProfile: 'coverage-v2' } };
    const incompatible = [
      { name: 'missing report reward', report: { ...currentReport, reward: undefined }, metadata },
      { name: 'unknown report reward', report: { ...currentReport, reward: {} }, metadata },
      { name: 'noncanonical report reward', report: { ...currentReport, reward: { ...metadata.reward, extra: true } }, metadata },
      { name: 'mismatched report reward', report: { ...currentReport, reward: rewardMetadata('legacy-v1') }, metadata },
      { name: 'missing report reward setting', report: { ...currentReport, settings: report.settings }, metadata },
      { name: 'unknown report reward setting', report: { ...currentReport, settings: { ...report.settings, rewardProfile: 'unknown' } }, metadata },
      { name: 'missing artifact reward setting', report: currentReport, metadata: { ...metadata, settings: undefined } },
      { name: 'mismatched artifact reward setting', report: currentReport, metadata: { ...metadata, settings: { rewardProfile: 'legacy-v1' } } },
      { name: 'missing artifact reward', report: currentReport, metadata: { ...metadata, reward: undefined } },
      { name: 'legacy artifact relabelled by report', report: currentReport, metadata: { version: 1 } },
    ];
    for (const fixture of incompatible) {
      await context.test(`rejects ${fixture.name} without replacing files`, async () => {
        const previous = await directoryHashes(preview);
        await writeReport(fixture.report);
        await writePolicy(sharedCheckpoint, sourceHashes, fixture.metadata);
        const result = execute();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /reward/i);
        assert.deepEqual(await directoryHashes(preview), previous);
        assert.deepEqual(await readdir(join(directory, '.local')), ['patrol-preview']);
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(await directoryHashes(realPreview), realPreviewBefore);
  }
});
