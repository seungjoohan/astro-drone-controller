import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : undefined,
  globalTimeout: process.env.CI ? 600000 : 0,
  timeout: process.env.CI ? 180000 : process.env.PLAYWRIGHT_CHROMIUM ? 90000 : 30000,
  expect: { timeout: process.env.CI ? 30000 : 5000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHROMIUM ? 'chromium' : 'chrome',
    viewport: { width: 1440, height: 1080 },
    screenshot: 'only-on-failure',
    trace: process.env.CI ? 'on-first-retry' : 'off',
    launchOptions: { args: ['--enable-webgl', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: process.env.CI ? 'npm run preview -- --port 5173 --strictPort' : 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
