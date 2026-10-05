import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const populationMetricIds = [
  'patrol-people-fresh',
  'patrol-people-visible',
  'patrol-population-age',
  'patrol-population-cost',
];

async function openPopulationPatrol(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-population')).toBeVisible();
}

async function readPopulationTelemetry(page: Page): Promise<string[]> {
  return Promise.all(['patrol-time', ...populationMetricIds].map(async metricId =>
    (await page.locator(`#${metricId}`).textContent()) ?? '',
  ));
}

async function readPopulationCost(page: Page): Promise<number> {
  return parseFloat(((await page.locator('#patrol-population-cost').textContent()) ?? '').replaceAll(',', ''));
}

test('applies population size, reproducible seed, and crowded-area revisit requirements', async ({ page }) => {
  await openPopulationPatrol(page);
  await expect(page.locator('#patrol-population')).toHaveValue('5000');
  await expect(page.locator('#patrol-population-seed')).toHaveValue('42');
  await expect(page.locator('#patrol-crowded-window')).toHaveValue('15');
  await expect(page.locator('#patrol-crowded-threshold')).toHaveValue('80');
  await expect(page.locator('#patrol-population-summary')).toContainText(/5,?000 people/);
  await page.locator('#patrol-population').fill('12500');
  await page.locator('#patrol-population-seed').fill('301');
  await page.locator('#patrol-crowded-window').fill('12');
  await page.locator('#patrol-crowded-threshold').fill('25');
  await page.locator('#patrol-apply').click();
  await expect(page.locator('#patrol-population-summary')).toContainText(/12,?500 people/);
  await expect(page.locator('#patrol-population-summary')).toContainText(/seed 301/);
  await expect(page.locator('#patrol-crowded-window')).toHaveValue('12');
  await expect(page.locator('#patrol-crowded-threshold')).toHaveValue('25');
  const appliedSummary = await page.locator('#patrol-population-summary').textContent();
  await page.locator('#patrol-reset').click();
  await expect(page.locator('#patrol-population')).toHaveValue('12500');
  await expect(page.locator('#patrol-population-seed')).toHaveValue('301');
  await expect(page.locator('#patrol-population-summary')).toHaveText(appliedSummary ?? '');
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
});

test('handles an empty city without invalid population metrics', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPopulationPatrol(page);
  await page.locator('#patrol-population').fill('0');
  await page.locator('#patrol-apply').click();
  await expect(page.locator('#patrol-population-summary')).toContainText('0 people');
  for (const metricId of populationMetricIds) {
    await expect(page.locator(`#${metricId}`)).toHaveText('N/A');
  }
  await page.locator('#patrol-speed').selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#patrol-time')).not.toHaveText('00:00');
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  for (const metricId of populationMetricIds) {
    await expect(page.locator(`#${metricId}`)).toHaveText('N/A');
  }
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  expect(errors).toEqual([]);
});

test('updates population observation costs during patrol and freezes them when paused', async ({ page }) => {
  await openPopulationPatrol(page);
  const initialTelemetry = await readPopulationTelemetry(page);
  const initialCost = await readPopulationCost(page);
  await page.locator('#patrol-speed').selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect.poll(() => readPopulationCost(page), { intervals: [100], timeout: 15000 }).toBeGreaterThan(initialCost);
  await expect.poll(async () => parseFloat((await page.locator('#patrol-people-fresh').textContent()) ?? ''), {
    intervals: [100], timeout: 15000,
  }).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  const pausedTelemetry = await readPopulationTelemetry(page);
  expect(pausedTelemetry).not.toEqual(initialTelemetry);
  const startedAt = Date.now();
  await expect.poll(async () => {
    expect(await readPopulationTelemetry(page)).toEqual(pausedTelemetry);
    return Date.now() - startedAt;
  }, { intervals: [100], timeout: 3000 }).toBeGreaterThanOrEqual(750);
  await page.locator('#patrol-reset').click();
  await expect.poll(() => readPopulationTelemetry(page)).toEqual(initialTelemetry);
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeVisible();
});

test('stages randomized populations until applied and preserves the applied seed on reset', async ({ page }) => {
  await openPopulationPatrol(page);
  const originalSeed = await page.locator('#patrol-population-seed').inputValue();
  const originalSummary = await page.locator('#patrol-population-summary').textContent();
  await page.locator('#patrol-randomize-population').click();
  await expect(page.locator('#patrol-population-seed')).not.toHaveValue(originalSeed);
  const stagedSeed = await page.locator('#patrol-population-seed').inputValue();
  await expect(page.locator('#patrol-population-summary')).toHaveText(originalSummary ?? '');
  await page.locator('#patrol-reset').click();
  await expect(page.locator('#patrol-population-seed')).toHaveValue(originalSeed);
  await expect(page.locator('#patrol-population-summary')).toHaveText(originalSummary ?? '');
  await page.locator('#patrol-population-seed').fill(stagedSeed);
  await page.locator('#patrol-apply').click();
  await expect(page.locator('#patrol-population-summary')).toContainText(`seed ${stagedSeed}`);
  await page.locator('#patrol-reset').click();
  await expect(page.locator('#patrol-population-seed')).toHaveValue(stagedSeed);
});

test('keeps population controls and heatmap usable on a narrow mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPopulationPatrol(page);
  await page.locator('#patrol-population').fill('50000');
  await page.locator('#patrol-population-seed').fill('987654');
  await page.locator('#patrol-apply').click();
  await expect(page.locator('#patrol-population-summary')).toContainText(/50,?000 people/);
  await expect(page.locator('#patrol-population-layer')).toBeChecked();
  await page.locator('#patrol-population-layer').uncheck();
  await expect(page.locator('#patrol-population-layer')).not.toBeChecked();
  await page.locator('#patrol-population-layer').check();
  await expect(page.locator('#patrol-population-layer')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  await page.screenshot({ path: 'test-results/population-mobile.png', fullPage: true });
});
