import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

const execute = args => spawnSync(process.execPath, ['scripts/train-patrol-rl.mjs', ...args], {
  encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
});
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let rewardMetadata;
try {
  ({ rewardMetadata } = await server.ssrLoadModule('/src/patrol-rl-reward.ts'));
} finally {
  await server.close();
}

test('rejects invalid reward profiles, optimization options and evaluation overrides before creating artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patrol-cli-validation-'));
  try {
    const output = join(directory, 'unused');
    for (const profile of ['unknown', 'Coverage-v2', 'legacy', '']) {
      const result = execute([`--reward-profile=${profile}`, '--output', output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Reward profile/);
      assert.equal(existsSync(output), false);
    }
    for (const scale of ['0', '-1', 'NaN', 'Infinity', '1e-9', '1e9', '']) {
      const result = execute([`--reward-scale=${scale}`, '--output', output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Reward scale/);
      assert.equal(existsSync(output), false);
    }
    const invalid = execute(['--gradient-clipping', 'unknown', '--output', output]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Gradient clipping/);
    assert.equal(existsSync(output), false);
    for (const normalization of ['unknown', 'Layer', '']) {
      const result = execute([`--actor-normalization=${normalization}`, '--output', output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Actor normalization/);
      assert.equal(existsSync(output), false);
    }
    for (const architecture of ['unknown', 'Dense', 'SHARED', '']) {
      const result = execute([`--actor-architecture=${architecture}`, '--output', output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Actor architecture/);
      assert.equal(existsSync(output), false);
    }
    for (const normalization of ['unknown', 'Layer', '']) {
      const result = execute([`--critic-normalization=${normalization}`, '--output', output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Critic normalization/);
      assert.equal(existsSync(output), false);
    }
    for (const override of [['--reward-profile', 'legacy-v1'], ['--reward-profile', 'coverage-v2'],
      ['--reward-scale', '0.001'], ['--gradient-clipping', 'separate'],
      ['--actor-normalization', 'none'], ['--actor-normalization', 'layer'],
      ['--actor-architecture', 'dense'], ['--actor-architecture', 'shared'], ['--actor-architecture', 'autoregressive'],
      ['--critic-normalization', 'none'], ['--critic-normalization', 'layer']]) {
      const result = execute(['--evaluate', '--checkpoint', 'not-read.json', ...override, '--output', output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /training overrides are not allowed/);
      assert.equal(existsSync(output), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const { actorNormalization, actorArchitecture, rewardProfile, criticNormalization = 'none' } of [
  { actorNormalization: 'none', actorArchitecture: 'dense', rewardProfile: 'coverage-v2' },
  { actorNormalization: 'layer', actorArchitecture: 'dense', rewardProfile: 'coverage-v2' },
  { actorNormalization: 'none', actorArchitecture: 'shared', rewardProfile: 'coverage-v2' },
  { actorNormalization: 'none', actorArchitecture: 'shared', rewardProfile: 'coverage-v2', criticNormalization: 'layer' },
  { actorNormalization: 'none', actorArchitecture: 'autoregressive', rewardProfile: 'coverage-v2' },
  { actorNormalization: 'none', actorArchitecture: 'autoregressive', rewardProfile: 'coverage-v2', criticNormalization: 'layer' },
  { actorNormalization: 'none', actorArchitecture: 'dense', rewardProfile: 'legacy-v1' },
]) {
test(`records ${rewardProfile}, ${actorArchitecture}, actor ${actorNormalization} and critic ${criticNormalization}, reloads v5 and reproduces matched smoke evaluation`, { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patrol-cli-roundtrip-'));
  try {
    const trainingDirectory = join(directory, 'training');
    const evaluationDirectory = join(directory, 'evaluation');
    const normalizationOptions = actorNormalization === 'none' ? [] : ['--actor-normalization', actorNormalization];
    const architectureOptions = actorArchitecture === 'dense' ? [] : ['--actor-architecture', actorArchitecture];
    const rewardOptions = rewardProfile === 'coverage-v2' && actorArchitecture === 'dense' ? [] : ['--reward-profile', rewardProfile];
    const criticOptions = criticNormalization === 'none' ? [] : ['--critic-normalization', criticNormalization];
    const trained = execute(['--smoke', '--seeds', '7', '--reward-scale', '0.001', '--gradient-clipping', 'separate',
      ...normalizationOptions, ...architectureOptions, ...rewardOptions, ...criticOptions, '--output', trainingDirectory]);
    assert.equal(trained.status, 0, trained.stderr || trained.error?.message);
    const artifact = await read(join(trainingDirectory, 'policy-7.json'));
    const training = await read(join(trainingDirectory, 'training-7.json'));
    const report = await read(join(trainingDirectory, 'report.json'));
    const protocol = await read(join(trainingDirectory, 'protocol.json'));
    const evaluation = await read(join(trainingDirectory, 'evaluation-7.json'));
    assert.equal(artifact.version, 2);
    assert.equal(artifact.policy.version, 5);
    for (const document of [artifact, report, protocol]) {
      assert.equal(document.settings.rewardProfile, rewardProfile);
      assert.deepEqual(document.reward, rewardMetadata(rewardProfile));
    }
    assert.equal(evaluation.rewardProfile, rewardProfile);
    assert.deepEqual(evaluation.reward, rewardMetadata(rewardProfile));
    assert(training.episodes.every(episode => episode.rewardProfile === rewardProfile));
    assert(evaluation.results.every(episode => episode.rewardProfile === rewardProfile));
    assert.deepEqual(report.settings.optimization, { rewardScale: 0.001, gradientClipping: 'separate', actorNormalization, actorArchitecture, criticNormalization });
    assert.deepEqual(artifact.settings.optimization, report.settings.optimization);
    assert.deepEqual(protocol.settings.optimization, report.settings.optimization);
    assert.equal(Object.hasOwn(artifact.policy.options, 'rewardProfile'), false);
    assert.equal(artifact.policy.options.rewardScale, 0.001);
    assert.equal(artifact.policy.options.gradientClipping, 'separate');
    assert.equal(artifact.policy.options.actorNormalization, actorNormalization);
    assert.equal(artifact.policy.options.actorArchitecture, actorArchitecture);
    assert.equal(artifact.policy.options.criticNormalization, criticNormalization);
    assert.deepEqual(artifact.policy.weights[0].shape, [actorArchitecture === 'autoregressive' ? 80 : actorArchitecture === 'shared' ? 68 : 1410, 32]);
    assert.deepEqual(artifact.policy.weights[4].shape, [32, actorArchitecture !== 'dense' ? 1 : 216]);
    const sharedFeatureHash = createHash('sha256').update(await readFile('src/patrol-rl-shared-features.ts')).digest('hex');
    assert.equal(artifact.provenance.sourceHashes['src/patrol-rl-shared-features.ts'], sharedFeatureHash);
    const rewardHash = createHash('sha256').update(await readFile('src/patrol-rl-reward.ts')).digest('hex');
    assert.equal(artifact.provenance.sourceHashes['src/patrol-rl-reward.ts'], rewardHash);
    const coordinationHash = createHash('sha256').update(await readFile('src/patrol-rl-coordination.ts')).digest('hex');
    assert.equal(artifact.provenance.sourceHashes['src/patrol-rl-coordination.ts'], coordinationHash);
    assert.equal(artifact.completedEpisodes, 8);
    assert.equal(report.status, 'completed');
    assert.equal(report.runs[0].complete, true);
    assert.equal(report.promotionEligible, false);
    assert(training.updates.length > 0);
    for (const update of training.updates) {
      assert(Object.values(update).every(Number.isFinite));
      assert(Math.abs(update.rewardScaledMean - update.rewardRawMean * 0.001) < 1e-7);
    }
    const evaluated = execute(['--evaluate', '--smoke', '--checkpoint', join(trainingDirectory, 'policy-7.json'), '--output', evaluationDirectory]);
    assert.equal(evaluated.status, 0, evaluated.stderr || evaluated.error?.message);
    assert.deepEqual(await read(join(evaluationDirectory, 'evaluation-7.json')), evaluation);
    const evaluatedReport = await read(join(evaluationDirectory, 'report.json'));
    assert.equal(evaluatedReport.settings.rewardProfile, rewardProfile);
    assert.deepEqual(evaluatedReport.reward, rewardMetadata(rewardProfile));
    assert.equal((await read(join(evaluationDirectory, 'protocol.json'))).settings.rewardProfile, rewardProfile);
    assert.deepEqual(evaluatedReport.settings.optimization, report.settings.optimization);
    assert.equal(evaluatedReport.inputPolicy.seed, 7);
    assert.equal(evaluatedReport.runs[0].episodes, null);
    assert.equal(existsSync(join(evaluationDirectory, 'policy-7.json')), false);
    if (actorArchitecture !== 'dense') {
      for (const sourcePath of ['src/patrol-rl-shared-features.ts', 'src/patrol-rl-reward.ts', 'src/patrol-rl-coordination.ts']) {
        for (const missing of [false, true]) {
          const incompatible = structuredClone(artifact);
          if (missing) delete incompatible.provenance.sourceHashes[sourcePath];
          else incompatible.provenance.sourceHashes[sourcePath] = '0'.repeat(64);
          const suffix = `${sourcePath.split('/').pop()}-${missing}`;
          const checkpoint = join(directory, `incompatible-${suffix}.json`);
          const incompatibleOutput = join(directory, `incompatible-output-${suffix}`);
          await writeFile(checkpoint, JSON.stringify(incompatible));
          const result = execute(['--evaluate', '--smoke', '--checkpoint', checkpoint, '--output', incompatibleOutput]);
          assert.equal(result.status, 1);
          assert.match(result.stderr, /source fingerprint differs/);
          assert.equal(existsSync(incompatibleOutput), false);
        }
      }
      for (const mutation of ['missing-reward', 'null-reward', 'tampered-reward', 'tampered-weight', 'missing-setting', 'conflicting-setting']) {
        const incompatible = structuredClone(artifact);
        if (mutation === 'missing-reward') delete incompatible.reward;
        if (mutation === 'null-reward') incompatible.reward = null;
        if (mutation === 'tampered-reward') incompatible.reward = { ...incompatible.reward, unexpected: true };
        if (mutation === 'tampered-weight') incompatible.reward.weights.overlap += 1;
        if (mutation === 'missing-setting') delete incompatible.settings.rewardProfile;
        if (mutation === 'conflicting-setting') incompatible.settings.rewardProfile = 'legacy-v1';
        const checkpoint = join(directory, `${mutation}.json`);
        const incompatibleOutput = join(directory, `${mutation}-output`);
        await writeFile(checkpoint, JSON.stringify(incompatible));
        const result = execute(['--evaluate', '--smoke', '--checkpoint', checkpoint, '--output', incompatibleOutput]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /reward/i);
        assert.equal(existsSync(incompatibleOutput), false);
      }
    }
    if (rewardProfile === 'legacy-v1') {
      const legacy = structuredClone(artifact);
      legacy.version = 1;
      legacy.policy.version = 4;
      delete legacy.policy.options.criticNormalization;
      delete legacy.settings.optimization.criticNormalization;
      delete legacy.reward;
      delete legacy.settings.rewardProfile;
      const checkpoint = join(directory, 'legacy-v1.json');
      const legacyOutput = join(directory, 'legacy-output');
      await writeFile(checkpoint, JSON.stringify(legacy));
      const result = execute(['--evaluate', '--smoke', '--checkpoint', checkpoint, '--output', legacyOutput]);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(await read(join(legacyOutput, 'evaluation-7.json')), evaluation);
      assert.equal((await read(join(legacyOutput, 'report.json'))).settings.rewardProfile, 'legacy-v1');
      for (const mutation of ['coverage-setting', 'coverage-metadata', 'missing-reward-source']) {
        const incompatible = structuredClone(legacy);
        if (mutation === 'coverage-setting') incompatible.settings.rewardProfile = 'coverage-v2';
        if (mutation === 'coverage-metadata') incompatible.reward = rewardMetadata('coverage-v2');
        if (mutation === 'missing-reward-source') delete incompatible.provenance.sourceHashes['src/patrol-rl-reward.ts'];
        const incompatibleCheckpoint = join(directory, `${mutation}.json`);
        const incompatibleOutput = join(directory, `${mutation}-output`);
        await writeFile(incompatibleCheckpoint, JSON.stringify(incompatible));
        const invalid = execute(['--evaluate', '--smoke', '--checkpoint', incompatibleCheckpoint, '--output', incompatibleOutput]);
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, mutation === 'missing-reward-source' ? /source fingerprint differs/ : /legacy-v1 reward profile/);
        assert.equal(existsSync(incompatibleOutput), false);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
}
