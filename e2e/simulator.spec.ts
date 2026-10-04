import { expect, test } from './fixtures';

interface TestPad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  timestamp: number;
}

declare global {
  interface Window { simulatorPad: TestPad | null }
}

test('flies with keyboard after clicking motors, changes camera, pauses and resets', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#scene canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/flight-lab-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText())).toBeGreaterThan(3);
  await page.keyboard.up('w');
  await page.keyboard.press('c');
  await expect(page.locator('#camera-mode')).toHaveValue('fpv');
  await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
  await expect(page.locator('#pause-overlay')).toBeVisible();
  const pausedAltitude = await page.locator('#altitude').innerText();
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  await expect(page.locator('#altitude')).toHaveText(pausedAltitude);
  await page.locator('#resume-button').click();
  await expect(page.locator('#pause-overlay')).toBeHidden();
  await page.keyboard.press('r');
  await expect(page.locator('#altitude')).toContainText('0.0');
  await expect(page.locator('#arm-button')).toContainText('Start motors');
  expect(errors).toEqual([]);
});

test('reads a simulated controller and pauses on disconnect and focus loss', async ({ page }) => {
  await page.addInitScript(() => {
    window.simulatorPad = {
      id: 'Astro C40 Test Controller', index: 0, connected: true, mapping: 'standard',
      axes: [0, 0, 0, 0], timestamp: 0,
      buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: index === 0, touched: index === 0, value: index === 0 ? 1 : 0 })),
    };
  });
  await page.goto('/');
  await expect(page.locator('#connection-title')).toHaveText('Controller connected');
  await expect(page.locator('#arm-button')).toContainText('Start motors');
  await page.evaluate(() => { window.simulatorPad!.buttons[0] = { pressed: false, touched: false, value: 0 }; });
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.simulatorPad!.buttons[0] = { pressed: true, touched: true, value: 1 }; });
  await expect(page.locator('#arm-button')).toContainText('Stop motors');
  await page.evaluate(() => { window.simulatorPad!.axes[1] = -0.9; });
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText())).toBeGreaterThan(2);
  await page.evaluate(() => { window.simulatorPad!.axes[1] = 0; window.dispatchEvent(new Event('blur')); });
  await expect(page.locator('#pause-overlay')).toBeVisible();
  await page.evaluate(() => { window.simulatorPad!.buttons[9] = { pressed: true, touched: true, value: 1 }; });
  await page.waitForTimeout(150);
  await expect(page.locator('#pause-overlay')).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.simulatorPad!.buttons[9] = { pressed: false, touched: false, value: 0 }; });
  await page.locator('#resume-button').click();
  await page.evaluate(() => { window.simulatorPad = null; });
  await expect(page.locator('#pause-overlay')).toBeVisible();
  await expect(page.locator('#pause-reason')).toContainText('Controller disconnected');
});

test('persists mappings and makes settings usable on small screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Controller setup', exact: true }).click();
  await page.locator('#axis-throttle').selectOption('3');
  await page.locator('#deadzone').fill('0.15');
  await page.getByRole('button', { name: 'Close controller settings' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Controller setup', exact: true }).click();
  await expect(page.locator('#axis-throttle')).toHaveValue('3');
  await expect(page.locator('#deadzone')).toHaveValue('0.15');
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await expect(page.locator('#axis-throttle')).toHaveValue('1');
  await page.getByRole('button', { name: 'Close controller settings' }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: 'test-results/flight-lab-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'All controls' }).click();
  await expect(page.getByRole('heading', { name: 'Your first flight' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it. Let’s fly' }).click();
  await expect(page.locator('#guide-dialog')).not.toBeVisible();
});

test('scores the first course gate after a real keyboard flight', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate course', exact: true }).click();
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText()), { intervals: [100] }).toBeGreaterThan(5);
  await page.keyboard.up('w');
  await page.keyboard.down('ArrowUp');
  await expect(page.locator('#distance')).toHaveText('1 / 6', { timeout: 10000 });
  await page.keyboard.up('ArrowUp');
  await expect(page.locator('#toast')).toContainText('Gate 1 cleared');
  await page.keyboard.press('r');
  await expect(page.locator('#distance')).toHaveText('0 / 6');
});
