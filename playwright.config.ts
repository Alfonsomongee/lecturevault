import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    // Optional: point at a locally installed Chromium (PW_CHROMIUM_PATH) instead of the bundled one
    launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] || undefined },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'dashboard',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
