import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { expect, test } from './fixtures';
import { RL_ACTION_COUNT, RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_PROTOCOL_VERSION } from '../src/patrol-rl-contract';
import { createRLScenarios } from '../src/patrol-rl-scenarios';

test.skip(!!process.env.CI, 'The neural preview is intentionally absent from the production build served by CI.');

function policyFixture(seed: number): unknown {
  const weights = ['actor', 'critic'].flatMap(network => [
    { name: `${network}.hidden1.kernel`, shape: [RL_OBSERVATION_SIZE, 32] },
    { name: `${network}.hidden1.bias`, shape: [32] },
    { name: `${network}.hidden2.kernel`, shape: [32, 32] },
    { name: `${network}.hidden2.bias`, shape: [32] },
    { name: `${network}.output.kernel`, shape: [32, network === 'actor' ? RL_MAX_DRONES * RL_ACTION_COUNT : 1] },
    { name: `${network}.output.bias`, shape: [network === 'actor' ? RL_MAX_DRONES * RL_ACTION_COUNT : 1] },
  ]).map(weight => ({
    ...weight,
    values: Array.from({ length: weight.shape.reduce((product, size) => product * size, 1) }, (_, index) => weight.name === 'actor.output.bias' && index % RL_ACTION_COUNT === 0 ? 1 : 0),
  }));
  return {
    format: 'astro-patrol-rl-policy', version: 1, protocolVersion: RL_PROTOCOL_VERSION, completedEpisodes: 64, trainingSteps: 18064,
    policy: {
      format: 'astro-patrol-ppo', version: 1, observationSize: RL_OBSERVATION_SIZE, actionCount: RL_ACTION_COUNT, maxDrones: RL_MAX_DRONES,
      hiddenSizes: [32, 32], seed, randomState: seed, weights,
      options: { gamma: 0.99, gaeLambda: 0.95, clipRatio: 0.2, learningRate: 0.0003, epochs: 4, minibatchSize: 64, valueCoefficient: 0.5, entropyCoefficient: 0.01, maxGradientNorm: 0.5 },
    },
  };
}

async function mockArtifacts(page: Page, failedSeed?: number): Promise<void> {
  const policies = new Map([42, 73, 101].map(seed => [seed, JSON.stringify(policyFixture(seed))]));
  await page.route('**/__patrol_preview/manifest.json', route => route.fulfill({
    json: {
      version: 1, defaultSeed: 101, runLabel: '64 episodes × 3 seeds',
      models: [42, 73, 101].map(seed => ({ seed, episodes: 64, path: `/__patrol_preview/policy-${seed}.json`, sha256: createHash('sha256').update(policies.get(seed)!).digest('hex') })),
      scenarios: createRLScenarios('validation', 42, 4),
    },
  }));
  await page.route('**/__patrol_preview/policy-*.json', route => {
    const seed = Number(/policy-(\d+)\.json/.exec(route.request().url())?.[1]);
    return route.fulfill(seed === failedSeed ? { status: 404, body: 'Missing checkpoint' } : { contentType: 'application/json', body: policies.get(seed) });
  });
}

test('plays frozen neural decisions, pauses, and resets without changing the main patrol', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockArtifacts(page);
  await page.goto('/neural.html');
  await expect(page.locator('#preview-status')).toHaveText('Ready');
  await expect(page.locator('#preview-policy')).toHaveValue('101');
  await expect(page.locator('#preview-map')).toHaveAttribute('data-controller', 'neural');
  await expect(page.locator('.drone-row')).toHaveCount(8);
  await expect(page.locator('#preview-context')).toContainText('not a benchmark result');
  await expect(page.locator('#preview-time')).toHaveText('00:00');
  await expect(page.locator('#preview-decisions')).toHaveText('0');
  await page.locator('#preview-speed').selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('#preview-decisions').textContent())).toBeGreaterThan(1);
  await expect(page.locator('#preview-time')).not.toHaveText('00:00');
  await expect(page.locator('.drone-battery').first()).not.toHaveText('100%');
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  const pausedTime = await page.locator('#preview-map').getAttribute('data-time');
  const pauseStarted = Date.now();
  await expect.poll(async () => {
    expect(await page.locator('#preview-map').getAttribute('data-time')).toBe(pausedTime);
    return Date.now() - pauseStarted;
  }, { intervals: [100] }).toBeGreaterThan(500);
  await page.locator('#preview-reset').click();
  await expect(page.locator('#preview-time')).toHaveText('00:00');
  await expect(page.locator('#preview-decisions')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeEnabled();
  await expect(page.locator('main')).not.toContainText(/NaN|Infinity/);
  await page.screenshot({ path: 'test-results/patrol-neural-preview-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('stages policy, fleet, and baseline changes until explicitly applied', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockArtifacts(page);
  await page.goto('/neural.html');
  await expect(page.locator('#preview-status')).toHaveText('Ready');
  await page.locator('#preview-policy').selectOption('42');
  await page.locator('#preview-controller').selectOption('uniform');
  await page.locator('#preview-fleet').selectOption('3');
  await expect(page.locator('#preview-staged')).toContainText('Unapplied changes');
  await expect(page.locator('#preview-applied')).toContainText('seed 101');
  await expect(page.locator('.drone-row')).toHaveCount(8);
  await page.locator('#preview-apply').click();
  await expect(page.locator('#preview-map')).toHaveAttribute('data-controller', 'uniform');
  await expect(page.locator('.drone-row')).toHaveCount(3);
  await expect(page.locator('#preview-applied')).toContainText('Uniform baseline');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#preview-time')).not.toHaveText('00:00');
  await page.locator('#preview-reset').click();
  await expect(page.locator('#preview-time')).toHaveText('00:00');
  await expect(page.locator('#preview-decisions')).toHaveText('0');
  await page.locator('#preview-controller').selectOption('neural');
  await page.locator('#preview-scenario').selectOption({ index: 1 });
  await page.locator('#preview-apply').click();
  await expect(page.locator('#preview-applied')).toContainText('seed 42');
  await expect(page.locator('#preview-context')).toContainText('Held-out validation replay');
  expect(errors).toEqual([]);
});

test('does not silently fall back when a trained policy fails to load', async ({ page }) => {
  await mockArtifacts(page, 101);
  await page.goto('/neural.html');
  await expect(page.locator('#preview-error')).toContainText('unavailable');
  await expect(page.locator('#preview-start')).toBeDisabled();
  await expect(page.locator('#preview-applied')).toContainText('No active preview');
  await page.locator('#preview-policy').selectOption('73');
  await page.locator('#preview-apply').click();
  await expect(page.locator('#preview-error')).toBeHidden();
  await expect(page.locator('#preview-applied')).toContainText('seed 73');
  await expect(page.locator('#preview-start')).toBeEnabled();
});

test('keeps the preview usable on mobile and pauses on focus loss', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockArtifacts(page);
  await page.goto('/neural.html');
  await expect(page.locator('#preview-status')).toHaveText('Ready');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#preview-status')).toHaveText('Running');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#preview-status')).toContainText('focus lost');
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/patrol-neural-preview-mobile.png', fullPage: true });
});

for (const shape of ['circle', 'rectangle'] as const) {
  test(`recovers playback after hidden and small ${shape} canvases`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await mockArtifacts(page);
    await page.goto('/neural.html');
    await expect(page.locator('#preview-status')).toHaveText('Ready');
    const scenario = createRLScenarios('validation', 42, 4).find(candidate => candidate.environment.shape === shape)!;
    await page.locator('#preview-scenario').selectOption(scenario.id);
    await page.locator('#preview-apply').click();
    await expect(page.locator('#preview-status')).toHaveText('Ready');
    const canvas = page.locator('#preview-map');
    for (const dimensions of [
      { display: 'none', width: 0, height: 0 },
      { display: 'block', width: 20, height: 240 },
      { display: 'block', width: 240, height: 20 },
      { display: 'block', width: 42, height: 42 },
    ]) {
      const size = await canvas.evaluate(async (target, dimensions) => {
        const element = target as HTMLCanvasElement;
        element.style.display = dimensions.display;
        element.style.width = `${dimensions.width}px`;
        element.style.height = `${dimensions.height}px`;
        await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
        return { width: element.clientWidth, height: element.clientHeight };
      }, dimensions);
      expect(size).toEqual({ width: dimensions.width, height: dimensions.height });
      await expect(page.locator('#preview-error')).toBeHidden();
      await expect(page.locator('#preview-status')).toHaveText('Ready');
    }
    await canvas.evaluate(async target => {
      target.removeAttribute('style');
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
    });
    expect(await canvas.evaluate(target => target.clientWidth > 42 && target.clientHeight > 42)).toBe(true);
    await page.locator('#preview-speed').selectOption('16');
    await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
    await expect.poll(async () => Number(await page.locator('#preview-decisions').textContent())).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
    await expect(page.locator('#preview-error')).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('previews the actual local trained artifact without fixture substitution', async ({ page }) => {
  test.skip(process.env.PATROL_PREVIEW_REAL_MODELS !== '1', 'Requires explicitly prepared local trained artifacts.');
  const manifestResponse = await page.request.get('/__patrol_preview/manifest.json');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json() as {
    defaultSeed: number;
    models: { seed: number; episodes: number; path: string; sha256: string }[];
  };
  const model = manifest.models.find(candidate => candidate.seed === manifest.defaultSeed);
  expect(model).toBeDefined();
  const policyResponse = await page.request.get(model!.path);
  expect(policyResponse.ok()).toBe(true);
  expect(createHash('sha256').update(await policyResponse.body()).digest('hex')).toBe(model!.sha256);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/neural.html');
  await expect(page.locator('#preview-status')).toHaveText('Ready');
  await expect(page.locator('#preview-policy')).toHaveValue(String(manifest.defaultSeed));
  await expect(page.locator('#preview-training')).toContainText(`${model!.episodes} episodes`);
  const initialPositions = await page.locator('.drone-row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.position));
  const initialCanvas = await page.locator('#preview-map').evaluate(target => (target as HTMLCanvasElement).toDataURL());
  await page.locator('#preview-speed').selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('#preview-decisions').textContent())).toBeGreaterThanOrEqual(4);
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  const currentPositions = await page.locator('.drone-row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.position));
  expect(currentPositions).not.toEqual(initialPositions);
  expect(await page.locator('#preview-map').evaluate(target => (target as HTMLCanvasElement).toDataURL())).not.toBe(initialCanvas);
  await expect(page.locator('#preview-error')).toBeHidden();
  await expect(page.locator('#preview-time')).not.toHaveText('00:00');
  await page.screenshot({ path: 'test-results/neural-preview-real-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/neural-preview-real-mobile.png', fullPage: true });
  await page.locator('#preview-reset').click();
  await expect(page.locator('#preview-time')).toHaveText('00:00');
  await expect(page.locator('#preview-decisions')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
