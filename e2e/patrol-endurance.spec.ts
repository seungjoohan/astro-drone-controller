import { expect, test } from './fixtures';

test('stages environment settings and rotates a finite fleet through a charging base', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-learning-profile')).toHaveValue('diverse');
  await page.locator('#patrol-environment').selectOption('compact');
  await page.locator('#patrol-endurance').fill('120');
  await page.locator('#patrol-recharge').fill('30');
  await page.locator('#patrol-charging-pads').fill('1');
  await expect(page.locator('#patrol-environment-summary')).toContainText('unlimited');
  await page.locator('#patrol-apply').click();
  await expect(page.locator('#patrol-environment-summary')).toContainText('180 m radius');
  await expect(page.locator('#patrol-environment-summary')).toContainText('endurance enabled');
  await expect(page.locator('#patrol-revisit')).toContainText('N/A');
  await page.locator('#patrol-speed').selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#patrol-health')).toContainText(/[1-9]\d* charges/, { timeout: 45000 });
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  await expect(page.locator('#patrol-health')).toContainText('0 reserve violations');
  await expect(page.locator('#patrol-health')).toContainText('0 stranded');
  await expect(page.locator('[data-drone-id]')).toHaveCount(5);
  await expect(page.locator('.patrol-drone-energy').first()).toContainText('battery');
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  await page.screenshot({ path: 'test-results/patrol-endurance-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('runs bounded diverse trials and exposes individual environments without changing the mission', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await page.locator('#patrol-learning-generations').fill('1');
  await page.locator('#patrol-learning-budget').fill('15');
  await page.locator('#patrol-learning-start').click();
  await expect(page.locator('#patrol-learning-status')).toContainText('Completed', { timeout: 45000 });
  await expect(page.locator('[data-generalization-case]').first()).toBeAttached();
  await expect(page.locator('#patrol-learning-results')).toContainText('worst-case gap');
  await expect(page.locator('#patrol-learning-results')).toContainText('reserve violations');
  await expect(page.locator('#patrol-time')).toHaveText('00:00');
  await expect(page.locator('#patrol-strategy')).toContainText('Uniform baseline');
  await expect(page.locator('#patrol-environment-summary')).toContainText('unlimited');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  await page.screenshot({ path: 'test-results/patrol-generalization-mobile.png', fullPage: true });
});

test('preserves the original learning report when saving new environment-aware results', async ({ page }) => {
  const legacy = JSON.stringify({
    version: 1, evaluatorVersion: 'patrol-pilot-v1-grid40-audit10-dt0.5',
    settings: {
      config: { coverageTarget: 95, revisitSeconds: 120, fleetSize: 5, populationCount: 5000, populationSeed: 42, crowdedRevisitSeconds: 15, crowdedCellPopulation: 80 },
      optimizerSeed: 42, generations: 1, budgetSeconds: 15,
    },
    progress: {
      status: 'completed', generation: 1, evaluations: 0, elapsedSeconds: 0, testedFleetSizes: [], candidates: [],
      frontierIds: [], recommendedId: null, message: 'Original learning report retained for review.',
    },
  });
  await page.addInitScript(value => localStorage.setItem('astro-patrol-learning-results-v1', value), legacy);
  await page.goto('/');
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-learning-status')).toContainText('Read-only');
  await expect(page.locator('#patrol-learning-message')).toContainText('Original learning report');
  await expect(page.locator('#patrol-learning-profile')).toHaveValue('current');
  await page.locator('#patrol-learning-start').click();
  await expect(page.locator('#patrol-learning-status')).toContainText('Completed', { timeout: 45000 });
  expect(await page.evaluate(() => localStorage.getItem('astro-patrol-learning-results-v1'))).toBe(legacy);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('astro-patrol-learning-results-v2') ?? '{}').version)).toBe(2);
});
