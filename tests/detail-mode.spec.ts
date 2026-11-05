import { expect, test } from '@playwright/test';
import { generationFixtures } from '../src/shared/fixtures';
import type { EntryDetail, Generation } from '../src/shared/schemas';
import {
  draftEntryDetailFixture,
  liveClientConfigFixture,
  mockClientConfigFixture,
} from './fixtures/client-config';

const entryId = draftEntryDetailFixture.id;
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('mock設定では生成API経由で固定漫画を表示する', async ({ page }) => {
  let generation: Generation | null = null;
  const generationMockFlags: boolean[] = [];
  let generationRequests = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: '2026-01-02T00:00:00Z',
        generationAvailable: true,
      },
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    const detail: EntryDetail = {
      ...draftEntryDetailFixture,
      latestGenerationId: generation?.id ?? null,
      latestGeneration: generation,
    };
    return route.fulfill({ json: detail });
  });
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    const succeededGeneration = generationFixtures(entryId, generationId).succeeded;
    generation = succeededGeneration;
    generationMockFlags.push(succeededGeneration.mock);
    return route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'succeeded',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    generation
      ? route.fulfill({ json: generation })
      : route.fulfill({ status: 404, json: { error: 'not found' } }),
  );
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: {
        url: '/sample-comic.svg',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    }),
  );

  await page.goto(`/entries/${entryId}`);
  await expect(page.locator('.diary')).toHaveText(draftEntryDetailFixture.body);
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  expect(generationRequests).toBe(1);
  expect(generationMockFlags).toEqual([true]);
});

test('live設定では認証済み記録を表示し、生成利用不可を保つ', async ({ page }) => {
  const apiAuthorization: string[] = [];
  const externalAuthRequests: string[] = [];
  let generationRequests = 0;
  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    localStorage.setItem(
      'sb-manga-nikki-e2e-auth-token',
      JSON.stringify({
        access_token: 'fixture-live-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: 'fixture-live-refresh-token',
        user: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          aud: 'authenticated',
          role: 'authenticated',
          app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
          user_metadata: {},
          created_at: new Date().toISOString(),
          is_anonymous: true,
        },
      }),
    );
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: liveClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: '2026-01-02T00:00:00Z',
        generationAvailable: false,
      },
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    apiAuthorization.push(route.request().headers().authorization ?? '');
    return route.fulfill({ json: draftEntryDetailFixture });
  });
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    return route.fulfill({ status: 503, json: { error: 'not connected' } });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', async (route) => {
    externalAuthRequests.push(route.request().url());
    await route.abort();
  });
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'manga-nikki-e2e.supabase.co')
      externalAuthRequests.push(request.url());
  });

  await page.goto(`/entries/${entryId}`);
  await expect(page.locator('.diary')).toHaveText(draftEntryDetailFixture.body);
  await expect(page.getByRole('button', { name: '漫画の受付を停止しています' })).toBeDisabled();
  expect(apiAuthorization.length).toBeGreaterThan(0);
  expect(apiAuthorization.every((value) => value === 'Bearer fixture-live-access-token')).toBe(
    true,
  );
  expect(generationRequests).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});
