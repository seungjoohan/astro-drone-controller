import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function openLearning(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-learning-start')).toBeVisible();
  await page.locator('#patrol-learning-profile').selectOption('current');
}

test('runs learning separately from the mission and supports pause, resume, and cancel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openLearning(page);
  await expect(page.locator('[data-learning-fleet]')).toHaveCount(8);
  await expect(page.locator('#patrol-learning-status')).toContainText(/idle|ready/i);
  await page.locator('#patrol-learning-generations').fill('20');
  await page.locator('#patrol-learning-budget').fill('60');
  await page.locator('#patrol-learning-start').click();
  await expect(page.locator('#patrol-learning-status')).toContainText(/running/i);
  await page.locator('#patrol-learning-pause').click();
  await expect(page.locator('#patrol-learning-status')).toContainText(/paused/i);
  const evaluations = await page.locator('#patrol-learning-evaluations').textContent();
  const pausedAt = Date.now();
  await expect.poll(async () => {
    expect(await page.locator('#patrol-learning-evaluations').textContent()).toBe(evaluations);
    return Date.now() - pausedAt;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(750);
  await expect(page.locator('#patrol-time')).toHaveText('00:00');
  await page.locator('#patrol-speed').selectOption('16');
  await page.getByRole('button', { name: 'Start patrol', exact: true }).click();
  await expect(page.locator('#patrol-time')).not.toHaveText('00:00');
  await page.locator('#patrol-learning-resume').click();
  await expect(page.locator('#patrol-learning-status')).toContainText(/running/i);
  await page.locator('#patrol-learning-cancel').click();
  await expect(page.locator('#patrol-learning-status')).toContainText(/cancelled/i);
  await expect(page.getByRole('button', { name: 'Pause patrol', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('searches all fleet sizes, tests candidates, and applies only an explicit new test mission', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openLearning(page);
  await page.locator('#patrol-learning-generations').fill('1');
  await page.locator('#patrol-learning-budget').fill('45');
  await page.locator('#patrol-learning-seed').fill('117');
  await page.locator('#patrol-learning-start').click();
  await expect(page.locator('#patrol-learning-status')).toContainText(/completed/i, { timeout: 90000 });
  await expect(page.locator('#patrol-learning-tested-fleets')).toContainText(/1.*2.*3.*4.*5.*6.*7.*8/);
  await expect(page.locator('#patrol-time')).toHaveText('00:00');
  await expect(page.locator('#patrol-strategy')).toContainText(/uniform|baseline/i);
  const apply = page.locator('[data-learning-apply]:enabled').first();
  await expect(apply).toBeVisible();
  await expect(apply).toHaveAttribute('data-learning-kind', 'adaptive');
  const fleet = await apply.locator('xpath=ancestor::*[@data-learning-fleet]').getAttribute('data-learning-fleet');
  await apply.click();
  await expect(page.locator('#patrol-fleet')).toHaveValue(fleet ?? '');
  await expect(page.locator('#patrol-time')).toHaveText('00:00');
  await expect(page.getByRole('button', { name: 'Start patrol', exact: true })).toBeVisible();
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  await page.screenshot({ path: 'test-results/patrol-learning-desktop.png', fullPage: true });
  await page.locator('#patrol-baseline').click();
  await expect(page.locator('#patrol-strategy')).toContainText(/uniform|baseline/i);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#patrol-learning-export').click();
  const resultsFile = await (await downloadPromise).path();
  expect(resultsFile).not.toBeNull();
  await page.locator('#patrol-population').fill('6000');
  await page.locator('#patrol-apply').click();
  await expect(page.locator('#patrol-learning-config')).toContainText('MISSION CHANGED');
  await expect(page.locator('[data-learning-apply]:enabled')).toHaveCount(0);
  await page.locator('#patrol-learning-import-file').setInputFiles(resultsFile!);
  await expect(page.locator('#patrol-learning-status')).toContainText(/read.only/i);
  await expect(page.locator('[data-learning-apply]:enabled')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Patrol control center', exact: true }).click();
  await expect(page.locator('#patrol-learning-status')).toContainText(/read.only|saved|restored|imported/i);
  await expect(page.locator('[data-learning-apply]:enabled')).toHaveCount(0);
  await expect(page.locator('#patrol-time')).toHaveText('00:00');
  expect(errors).toEqual([]);
});

test('rejects malformed imported results and keeps learning controls usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLearning(page);
  await page.locator('#patrol-learning-import-file').setInputFiles({
    name: 'invalid-checkpoint.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"progress":{"recommendedId":"forged"}}'),
  });
  await expect(page.locator('#patrol-learning-notice')).toContainText(/invalid|incompatible|failed|error/i);
  await expect(page.locator('[data-learning-apply]:enabled')).toHaveCount(0);
  await expect(page.locator('#patrol-learning-start')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await expect(page.locator('#patrol-center')).not.toContainText(/NaN|Infinity/);
  await page.screenshot({ path: 'test-results/patrol-learning-mobile.png', fullPage: true });
});
