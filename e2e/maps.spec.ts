import { expect, test } from './fixtures';

test('switches maps, flies over NYC, and preserves flight preferences', async ({ page }) => {
  test.setTimeout(45000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#location-name')).toHaveText('Pine Valley');
  await page.getByRole('button', { name: 'Controller setup', exact: true }).click();
  await page.locator('#axis-throttle').selectOption('3');
  await page.getByRole('button', { name: 'Close controller settings' }).click();
  await page.locator('#flight-mode').selectOption('sport');
  await page.getByRole('switch', { name: 'Gentle wind' }).click();
  await page.getByRole('combobox', { name: 'Flight map' }).selectOption('nyc');
  await expect(page.locator('#location-name')).toHaveText('Midtown NYC');
  await expect(page.locator('#location-description')).toContainText('NYC');
  await expect(page.locator('#scene canvas')).toBeVisible();
  await expect(page.locator('#flight-mode')).toHaveValue('sport');
  await expect(page.getByRole('switch', { name: 'Gentle wind' })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/nyc-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText()), { intervals: [100] }).toBeGreaterThan(4);
  await page.keyboard.up('w');
  await page.keyboard.press('r');
  await expect(page.locator('#altitude')).toContainText('0.0');
  await expect(page.locator('#map-select')).toHaveValue('nyc');
  await expect(page.locator('#location-name')).toHaveText('Midtown NYC');
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText()), { intervals: [100], timeout: 20000 }).toBeGreaterThan(100);
  await page.keyboard.up('w');
  await page.screenshot({ path: 'test-results/nyc-skyline.png', fullPage: true });
  await page.getByRole('combobox', { name: 'Flight map' }).selectOption('pine-valley');
  await expect(page.locator('#location-name')).toHaveText('Pine Valley');
  await expect(page.locator('#arm-button')).toContainText('Start motors');
  await expect(page.locator('#altitude')).toContainText('0.0');
  await expect(page.locator('#flight-time')).toHaveText('00:00');
  await expect(page.locator('#battery')).toContainText('100');
  await expect(page.locator('#distance')).toContainText('0');
  await expect(page.locator('#scene canvas')).toHaveCount(1);
  await page.getByRole('button', { name: 'Controller setup', exact: true }).click();
  await expect(page.locator('#axis-throttle')).toHaveValue('3');
  expect(errors).toEqual([]);
});

test('scores the NYC course gate and clears progress on map changes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Flight map' }).selectOption('nyc');
  await page.getByRole('button', { name: 'Gate course', exact: true }).click();
  await expect(page.locator('#session-description')).toContainText('10 m');
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText()), { intervals: [100] }).toBeGreaterThan(9);
  await page.keyboard.up('w');
  await page.keyboard.down('ArrowUp');
  await expect(page.locator('#distance')).toHaveText('1 / 6', { timeout: 10000 });
  await page.keyboard.up('ArrowUp');
  await page.getByRole('combobox', { name: 'Flight map' }).selectOption('pine-valley');
  await expect(page.locator('#distance')).toHaveText('0 / 6');
  await expect(page.locator('#arm-button')).toContainText('Start motors');
  await expect(page.locator('#session-description')).toContainText('6 m');
});

test('ends the flight on a building collision and resets at the NYC landing pad', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Flight map' }).selectOption('nyc');
  await page.getByRole('button', { name: 'Start motors' }).click();
  await page.keyboard.down('w');
  await expect.poll(async () => parseFloat(await page.locator('#altitude').innerText()), { intervals: [100] }).toBeGreaterThan(3);
  await page.keyboard.up('w');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowRight');
  await expect(page.locator('#arm-button')).toContainText('Reset flight', { timeout: 8000 });
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('ArrowRight');
  await expect(page.locator('#toast')).toContainText('Building collision');
  await page.keyboard.press('r');
  await expect(page.locator('#arm-button')).toContainText('Start motors');
  await expect(page.locator('#altitude')).toContainText('0.0');
  await expect(page.locator('#location-name')).toHaveText('Midtown NYC');
});

test('keeps the map selector usable on mobile through repeated switches', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const mapSelect = page.getByRole('combobox', { name: 'Flight map' });
  for (const mapId of ['nyc', 'pine-valley', 'nyc', 'pine-valley', 'nyc']) {
    await mapSelect.selectOption(mapId);
    await expect(mapSelect).toHaveValue(mapId);
    await expect(page.locator('#scene canvas')).toHaveCount(1);
  }
  await page.reload();
  await expect(mapSelect).toHaveValue('nyc');
  await expect(mapSelect).toBeVisible();
  await expect(page.locator('#location-name')).toHaveText('Midtown NYC');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/nyc-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
