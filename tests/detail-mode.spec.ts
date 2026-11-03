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

test('mock設定では固定漫画を生成でき、開発用の保存状態を表示する', async ({ page }) => {
  let generation: Generation | null = null;
  let generationRequests = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
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
    generation = generationFixtures(entryId, generationId).succeeded;
    return route.fulfill({
      status: 202,
      json: { generationId, status: 'succeeded' },
    });
  });
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: {
        url: '/sample-comic.svg',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    }),
  );

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByText('開発サーバーへ仮保存しました。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'モック漫画を見る' })).toBeEnabled();
  await page.getByRole('button', { name: 'モック漫画を見る' }).click();
  await expect(page.getByRole('heading', { name: 'いつもの一日' })).toBeVisible();
  expect(generationRequests).toBe(1);
});

test('live設定では匿名保存の案内を出し、未接続の生成操作を無効にする', async ({ page }) => {
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
  await expect(
    page.getByText('この匿名アカウントに保存しました。保存期間は最大30日です。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '漫画生成は利用できません' })).toBeDisabled();
  expect(apiAuthorization.length).toBeGreaterThan(0);
  expect(apiAuthorization.every((value) => value === 'Bearer fixture-live-access-token')).toBe(
    true,
  );
  expect(generationRequests).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});
