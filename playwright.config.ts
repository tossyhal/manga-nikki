import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: 'tests',
  testIgnore: ['pwa-preview.spec.ts', 'pwa-update.spec.ts'],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: baseURL,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://manga-nikki-e2e.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'e2e-placeholder',
      VITE_TURNSTILE_SITE_KEY: 'e2e-public-site-key',
    },
    reuseExistingServer: !process.env.CI,
  },
});
