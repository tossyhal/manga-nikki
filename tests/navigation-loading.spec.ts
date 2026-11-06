import { expect, test } from '@playwright/test';
import type { Entry, EntryDetail } from '../src/shared/schemas';
import { jstToday } from '../src/shared/schemas';
import { mockClientConfigFixture } from './fixtures/client-config';
import { clickEntryMenuItem } from './fixtures/ui';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeEntry(body: string, diaryDate = jstToday()): Entry {
  return {
    id: entryId,
    diaryDate,
    body,
    revision: 1,
    latestGenerationId: null,
    createdAt: `${diaryDate}T00:00:00.000Z`,
    updatedAt: `${diaryDate}T00:00:00.000Z`,
  };
}

test('ホームとライブラリで先頭ページを共有し、キャッシュ再訪で読み込み表示を出さない', async ({
  page,
}) => {
  const entry = makeEntry('今日は公園で本を読んだ。');
  let firstPageGets = 0;

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/v1/entries' &&
      url.searchParams.get('limit') === '20' &&
      !url.searchParams.has('cursor')
    ) {
      firstPageGets += 1;
      await route.fulfill({ json: { items: [entry], nextCursor: null } });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  const todaySection = page.getByRole('region', { name: '今日の記録' });
  await expect(todaySection.getByRole('heading', { name: entry.body, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toBeVisible();
  expect(firstPageGets).toBe(1);

  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.body.innerText.includes('記録を読み込んでいます')) {
        document.documentElement.dataset.navigationLoadingFlash = 'true';
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page.locator('.library-page')).toBeVisible();
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.locator('.home-page')).toBeVisible();
  await expect(todaySection.getByRole('heading', { name: entry.body, exact: true })).toBeVisible();

  expect(firstPageGets).toBe(1);
  await expect(page.locator('html')).not.toHaveAttribute('data-navigation-loading-flash', 'true');
});

test('編集後のホームと詳細で古い記録を再表示しない', async ({ page }) => {
  const today = jstToday();
  let currentEntry = makeEntry('編集前の日記本文です。', today);
  let currentDetail: EntryDetail = { ...currentEntry, latestGeneration: null };
  let firstPageGets = 0;
  let detailGets = 0;
  let patchRequests = 0;

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/v1/entries' &&
      url.searchParams.get('limit') === '20' &&
      !url.searchParams.has('cursor')
    ) {
      firstPageGets += 1;
      await route.fulfill({ json: { items: [currentEntry], nextCursor: null } });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      patchRequests += 1;
      const update = request.postDataJSON() as { diaryDate: string; body: string };
      currentEntry = {
        ...currentEntry,
        diaryDate: update.diaryDate,
        body: update.body,
        revision: currentEntry.revision + 1,
      };
      currentDetail = { ...currentEntry, latestGeneration: null };
      await route.fulfill({ json: currentEntry });
      return;
    }
    if (request.method() === 'GET') {
      detailGets += 1;
      await route.fulfill({ json: currentDetail });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  const todaySection = page.getByRole('region', { name: '今日の記録' });
  await expect(
    todaySection.getByRole('heading', { name: currentEntry.body, exact: true }),
  ).toBeVisible();
  await todaySection.getByRole('link', { name: '記録を読む', exact: true }).click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.locator('.detail-toolbar h1')).toHaveText(currentEntry.body);

  await clickEntryMenuItem(page, '日記を編集');
  const updatedBody = '編集後の日記本文です。';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(updatedBody);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.detail-toolbar h1')).toHaveText(updatedBody);
  await expect.poll(() => detailGets).toBeGreaterThan(1);
  expect(patchRequests).toBe(1);

  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: updatedBody, exact: true })).toBeVisible();
  expect(firstPageGets).toBeGreaterThan(1);

  const updatedTodaySection = page.getByRole('region', { name: '今日の記録' });
  await updatedTodaySection.getByRole('link', { name: '記録を読む', exact: true }).click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.locator('.detail-toolbar h1')).toHaveText(updatedBody);
  await expect(page.getByText('編集前の日記本文です。', { exact: true })).toHaveCount(0);
});
