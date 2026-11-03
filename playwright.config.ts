import { defineConfig, devices } from '@playwright/test';
const port = process.env.PLAYWRIGHT_PORT ?? '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests',
  testIgnore: ['pwa-preview.spec.ts', 'pwa-update.spec.ts'],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
