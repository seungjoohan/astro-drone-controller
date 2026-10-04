import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => [(window as Window & { simulatorPad?: unknown }).simulatorPad ?? null],
      });
    });
    await use(page);
  },
});

export { expect };
