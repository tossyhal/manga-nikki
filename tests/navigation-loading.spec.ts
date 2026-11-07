import { expect, test } from '@playwright/test';
import type { Entry, EntryDetail } from '../src/shared/schemas';
import { jstToday } from '../src/shared/schemas';
import { mockClientConfigFixture } from './fixtures/client-config';
import { clickAppDialogButton, clickEntryMenuItem } from './fixtures/ui';

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
  const updatedBody = '編集後の日記本文です。';
  let currentEntry = makeEntry('編集前の日記本文です。', today);
  let currentDetail: EntryDetail = { ...currentEntry, latestGeneration: null };
  let firstPageGets = 0;
  let detailGets = 0;
  let patchRequests = 0;
  let releasePostEditFirstPageResponse!: () => void;
  const postEditFirstPageResponseGate = new Promise<void>((resolve) => {
    releasePostEditFirstPageResponse = resolve;
  });

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
      if (currentEntry.body === updatedBody) {
        await postEditFirstPageResponseGate;
      }
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
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(updatedBody);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.detail-toolbar h1')).toHaveText(updatedBody);
  await expect.poll(() => detailGets).toBeGreaterThan(1);
  expect(patchRequests).toBe(1);

  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page).toHaveURL('/');
  const updatedTodaySection = page.getByRole('region', { name: '今日の記録' });
  try {
    await expect.poll(() => firstPageGets).toBeGreaterThan(1);
    await expect(updatedTodaySection).toBeVisible();
    await expect(
      updatedTodaySection.getByRole('heading', { name: updatedBody, exact: true }),
    ).toHaveCount(0);
  } finally {
    releasePostEditFirstPageResponse();
  }
  await expect(
    updatedTodaySection.getByRole('heading', { name: updatedBody, exact: true }),
  ).toBeVisible();

  await updatedTodaySection.getByRole('link', { name: '記録を読む', exact: true }).click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.locator('.detail-toolbar h1')).toHaveText(updatedBody);
  await expect(page.getByText('編集前の日記本文です。', { exact: true })).toHaveCount(0);
});

test('15秒を過ぎた記録も再検証中は表示し、応答後に最新内容へ更新する', async ({ page }) => {
  const original = makeEntry('再検証前の本文です。');
  let currentEntry = original;
  let firstPageGets = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });

  await page.clock.install();
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
      if (firstPageGets > 1) {
        markRefreshStarted();
        await refreshGate;
      }
      await route.fulfill({ json: { items: [currentEntry], nextCursor: null } });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: original.body, exact: true })).toBeVisible();
    await page.getByRole('link', { name: '記録', exact: true }).click();
    await expect(page.locator('.library-page')).toBeVisible();
    await page.clock.fastForward(16_000);

    currentEntry = {
      ...original,
      body: '再検証後の本文です。',
      revision: 2,
      updatedAt: new Date().toISOString(),
    };
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes('記録を読み込んでいます')) {
          document.documentElement.dataset.navigationLoadingFlash = 'true';
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByRole('link', { name: 'ホーム', exact: true }).click();
    await refreshStarted;
    await expect(page.getByRole('heading', { name: original.body, exact: true })).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-navigation-loading-flash', 'true');

    releaseRefresh();
    await expect(page.getByRole('heading', { name: currentEntry.body, exact: true })).toBeVisible();
    expect(firstPageGets).toBe(2);
  } finally {
    releaseRefresh();
  }
});

test('削除中に返った古い一覧応答を再利用しない', async ({ page }) => {
  const original = makeEntry('削除済みの本文です。');
  const detail: EntryDetail = { ...original, latestGeneration: null };
  let currentEntry: Entry | null = original;
  let firstPageGets = 0;
  let releaseStaleRead!: () => void;
  const staleReadGate = new Promise<void>((resolve) => {
    releaseStaleRead = resolve;
  });
  let markStaleReadStarted!: () => void;
  const staleReadStarted = new Promise<void>((resolve) => {
    markStaleReadStarted = resolve;
  });

  await page.clock.install();
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
      const responseItems = currentEntry ? [currentEntry] : [];
      if (firstPageGets === 2) {
        markStaleReadStarted();
        await staleReadGate;
      }
      await route.fulfill({ json: { items: responseItems, nextCursor: null } });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: detail });
      return;
    }
    if (request.method() === 'DELETE') {
      currentEntry = null;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.continue();
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: original.body, exact: true })).toBeVisible();
    await page.getByRole('link', { name: '記録', exact: true }).click();
    await expect(page.locator('.library-page')).toBeVisible();
    await page.clock.fastForward(16_000);
    await page.getByRole('link', { name: 'ホーム', exact: true }).click();
    await staleReadStarted;

    await page.getByRole('link', { name: '記録を読む', exact: true }).click();
    await expect(page).toHaveURL(`/entries/${entryId}`);
    await expect(page.locator('.detail-toolbar h1')).toHaveText(original.body);
    await clickEntryMenuItem(page, '日記を削除');
    await clickAppDialogButton(page, 'この日記を削除しますか？', '削除する');
    await expect(page.locator('.library-page')).toBeVisible();
    await expect(page.getByText(original.body, { exact: true })).toHaveCount(0);

    releaseStaleRead();
    await page.getByRole('link', { name: 'ホーム', exact: true }).click();
    await expect(page.getByRole('heading', { name: original.body, exact: true })).toHaveCount(0);
    expect(firstPageGets).toBe(3);
  } finally {
    releaseStaleRead();
  }
});

test('記録キャッシュを別のモック認証スコープへ渡さない', async ({ page }) => {
  const ownerA = makeEntry('所有者Aの本文です。');
  const ownerB = makeEntry('所有者Bの本文です。');
  const authorizations: string[] = [];
  await page.addInitScript(() => localStorage.setItem('manga-nikki.mock-session', 'owner-a-token'));
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
      const authorization = request.headers().authorization ?? '';
      authorizations.push(authorization);
      await route.fulfill({
        json: {
          items: [authorization.endsWith('owner-a-token') ? ownerA : ownerB],
          nextCursor: null,
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: ownerA.body, exact: true })).toBeVisible();
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page.locator('.library-page')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('manga-nikki.mock-session', 'owner-b-token'));
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();

  await expect(page.getByRole('heading', { name: ownerB.body, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: ownerA.body, exact: true })).toHaveCount(0);
  expect(authorizations).toEqual(['Bearer mock:owner-a-token', 'Bearer mock:owner-b-token']);
});
