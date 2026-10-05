import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function openPatrol(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-center')).toBeVisible();
}

async function configureFleet(page: Page, count: number): Promise<void> {
  await page.getByLabel('Fleet size', { exact: true }).fill(String(count));
  await page.getByRole('button', { name: 'Apply and reset', exact: true }).click();
  await expect(page.locator('[data-drone-id]')).toHaveCount(count);
  await expect.poll(() => readMetric(page, 'patrol-active-count')).toBe(count);
  await page.getByLabel('Simulation speed', { exact: true }).selectOption('16');
}

async function readMetric(page: Page, id: string): Promise<number> {
  return parseFloat((await page.locator(`#${id}`).textContent()) ?? '');
}

async function readMissionSeconds(page: Page): Promise<number> {
  const time = (await page.locator('#patrol-time').textContent()) ?? '';
  return time.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

async function readTelemetry(page: Page): Promise<string[]> {
  return Promise.all(['patrol-time', 'patrol-coverage', 'patrol-revision'].map(async id =>
    (await page.locator(`#${id}`).textContent()) ?? '',
  ));
}

async function expectFrozenTelemetry(page: Page, expected: string[]): Promise<void> {
  const startedAt = Date.now();
  await expect.poll(async () => {
    expect(await readTelemetry(page)).toEqual(expected);
    return Date.now() - startedAt;
  }, { intervals: [100], timeout: 3000 }).toBeGreaterThanOrEqual(750);
}

test('patrols without a controller and freezes on pause and simulator navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPatrol(page);
  await expect(page.getByLabel('Coverage target (%)', { exact: true })).toHaveValue('95');
  await expect(page.getByLabel('Revisit window (seconds)', { exact: true })).toHaveValue('120');
  await page.getByLabel('Simulation speed', { exact: true }).selectOption('16');
  const initialCoverage = await readMetric(page, 'patrol-coverage');
  const initialTime = await page.locator('#patrol-time').textContent();
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#patrol-time')).not.toHaveText(initialTime ?? '');
  await expect.poll(() => readMetric(page, 'patrol-coverage'), { intervals: [100], timeout: 15000 }).toBeGreaterThan(initialCoverage);
  await expect.poll(() => readMissionSeconds(page), { intervals: [100], timeout: 20000 }).toBeGreaterThanOrEqual(100);
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  const pausedTelemetry = await readTelemetry(page);
  await expectFrozenTelemetry(page, pausedTelemetry);
  await page.screenshot({ path: 'test-results/patrol-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Resume patrol', exact: true }).click();
  await expect(page.locator('#patrol-time')).not.toHaveText(pausedTelemetry[0]);
  await page.locator('#sim-nav').click();
  await expect(page.locator('#patrol-center')).toBeHidden();
  const awayTelemetry = await readTelemetry(page);
  await expectFrozenTelemetry(page, awayTelemetry);
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-center')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume patrol', exact: true })).toBeVisible();
  await expectFrozenTelemetry(page, awayTelemetry);
  await page.getByRole('button', { name: 'Reset patrol', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeVisible();
  await expect(page.locator('#patrol-time')).toHaveText(initialTime ?? '');
  expect(errors).toEqual([]);
});

test('detects failed and diverted drones, reallocates routes, and restores the existing fleet', async ({ page }) => {
  await openPatrol(page);
  await configureFleet(page, 3);
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  const initialRevision = await readMetric(page, 'patrol-revision');
  await page.getByRole('button', { name: 'Fail drone 1', exact: true }).click();
  await expect.poll(() => readMetric(page, 'patrol-active-count'), { intervals: [100] }).toBe(2);
  await expect.poll(() => readMetric(page, 'patrol-revision')).toBeGreaterThan(initialRevision);
  await expect(page.locator('[data-drone-id="1"] .patrol-drone-status')).toContainText(/offline/i);
  await expect(page.getByRole('log', { name: 'Patrol event log' })).toContainText(/malfunction|unresponsive|failed/i);
  const failedRevision = await readMetric(page, 'patrol-revision');
  await page.getByRole('button', { name: 'Divert drone 2', exact: true }).click();
  await expect.poll(() => readMetric(page, 'patrol-active-count'), { intervals: [100] }).toBe(1);
  await expect.poll(() => readMetric(page, 'patrol-revision')).toBeGreaterThan(failedRevision);
  await expect(page.getByRole('log', { name: 'Patrol event log' })).toContainText(/deviat|divert/i);
  await expect(page.locator('[data-drone-id]')).toHaveCount(3);
  const divertedRevision = await readMetric(page, 'patrol-revision');
  await page.getByRole('button', { name: 'Restore drone 1', exact: true }).click();
  await expect.poll(() => readMetric(page, 'patrol-active-count')).toBe(2);
  await expect.poll(() => readMetric(page, 'patrol-revision')).toBeGreaterThan(divertedRevision);
  await expect(page.locator('[data-drone-id="1"] .patrol-drone-status')).toContainText(/patrolling/i);
  await expect(page.getByRole('log', { name: 'Patrol event log' })).toContainText(/restor|recover/i);
  await expect(page.locator('[data-drone-id]')).toHaveCount(3);
});

test('shows degraded coverage without invalid metrics when the entire patrol fleet is offline', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPatrol(page);
  await configureFleet(page, 3);
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  for (const droneId of [1, 2, 3]) {
    await page.getByRole('button', { name: `Fail drone ${droneId}`, exact: true }).click();
  }
  await expect.poll(() => readMetric(page, 'patrol-active-count'), { intervals: [100] }).toBe(0);
  await expect(page.locator('#patrol-status')).toContainText(/degraded/i);
  await expect(page.locator('.patrol-drone-status')).toHaveText([/offline/i, /offline/i, /offline/i]);
  await expect(page.locator('[data-drone-id]')).toHaveCount(3);
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  expect(Number.isFinite(await readMetric(page, 'patrol-coverage'))).toBe(true);
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  await page.screenshot({ path: 'test-results/patrol-degraded.png', fullPage: true });
  await page.getByRole('button', { name: 'Reset patrol', exact: true }).click();
  await expect.poll(() => readMetric(page, 'patrol-active-count')).toBe(3);
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps patrol controls usable on mobile and preserves manual flight after returning', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPatrol(page);
  await page.getByLabel('Coverage target (%)', { exact: true }).fill('90');
  await page.getByLabel('Revisit window (seconds)', { exact: true }).fill('180');
  await configureFleet(page, 3);
  await expect(page.getByLabel('Coverage target (%)', { exact: true })).toHaveValue('90');
  await expect(page.getByLabel('Revisit window (seconds)', { exact: true })).toHaveValue('180');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect.poll(() => readMetric(page, 'patrol-coverage'), { intervals: [100], timeout: 15000 }).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause patrol', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/patrol-mobile.png', fullPage: true });
  await page.locator('#sim-nav').click();
  await expect(page.locator('#patrol-center')).toBeHidden();
  await expect(page.locator('#scene canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText()), { intervals: [100], timeout: process.env.CI ? 30000 : 10000 }).toBeGreaterThan(2);
  await page.keyboard.up('w');
  await page.keyboard.press('r');
  await expect(page.locator('#altitude')).toContainText('0.0');
  await expect(page.locator('#arm-button')).toContainText('Start motors');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('opens live controller setup without resuming the autonomous mission', async ({ page }) => {
  await openPatrol(page);
  await page.getByLabel('Simulation speed', { exact: true }).selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#patrol-time')).not.toHaveText('00:00');
  await page.getByRole('button', { name: 'Controller setup', exact: true }).click();
  await expect(page.locator('#patrol-center')).toBeHidden();
  await expect(page.locator('#controller-dialog')).toBeVisible();
  const pausedTelemetry = await readTelemetry(page);
  await page.evaluate(() => {
    window.simulatorPad = {
      id: 'Patrol setup test controller', index: 0, connected: true, mapping: 'standard',
      axes: [0.6, 0, 0, 0], timestamp: 0,
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
  });
  await expect(page.locator('#device-name')).toHaveText('Patrol setup test controller');
  await expect(page.locator('#raw-axes')).toContainText('A0: 0.60');
  await expectFrozenTelemetry(page, pausedTelemetry);
  await page.getByRole('button', { name: 'Close controller settings', exact: true }).click();
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume patrol', exact: true })).toBeVisible();
  await expectFrozenTelemetry(page, pausedTelemetry);
});
