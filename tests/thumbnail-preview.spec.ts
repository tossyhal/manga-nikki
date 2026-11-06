import { expect, test } from '@playwright/test';
import { generationFixtures, pageComic } from '../src/shared/fixtures';
import { jstToday, type Entry, type EntryDetail, type Generation } from '../src/shared/schemas';
import { mockClientConfigFixture } from './fixtures/client-config';

const today = jstToday();
const todayEntryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const previousEntryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const todayGenerationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const previousGenerationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const previousFailureId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const todayAssetId = 'today-thumbnail-asset';
const previousAssetId = 'previous-thumbnail-asset';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';

const previousDay = new Date(`${today}T12:00:00.000Z`);
previousDay.setUTCDate(previousDay.getUTCDate() - 1);
const yesterday = previousDay.toISOString().slice(0, 10);
const clockStart = new Date(`${today}T12:00:00.000Z`);

function entry(id: string, diaryDate: string, body: string, latestGenerationId: string): Entry {
  return {
    id,
    diaryDate,
    body,
    revision: 1,
    latestGenerationId,
    createdAt: `${diaryDate}T12:00:00.000Z`,
    updatedAt: `${diaryDate}T12:00:00.000Z`,
  };
}

function generationWithAsset(id: string, entryId: string, assetId: string): Generation {
  return {
    ...generationFixtures(entryId, id).succeeded,
    mock: false,
    comic: {
      ...pageComic,
      visual: { kind: 'page', assetId, textMode: 'external' },
    },
  };
}

async function installEntries(
  page: import('@playwright/test').Page,
  entries: Entry[],
  details: EntryDetail[],
) {
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries**', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/entries')
      return route.fulfill({ json: { items: entries, nextCursor: null } });
    const id = pathname.slice('/api/v1/entries/'.length);
    const detail = detailById.get(id);
    return detail
      ? route.fulfill({ json: detail })
      : route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

test('期限相当のHomeサムネイル失敗は1回だけ自動取得し、同じURLの手動再試行で表示する', async ({
  page,
}) => {
  await page.clock.install({ time: clockStart });
  const todayEntry = entry(
    todayEntryId,
    today,
    '期限付きサムネイルを確認する架空の日記',
    todayGenerationId,
  );
  const todayGeneration = generationWithAsset(todayGenerationId, todayEntryId, todayAssetId);
  const detail: EntryDetail = {
    ...todayEntry,
    latestGeneration: todayGeneration,
    lastSuccessfulGeneration: todayGeneration,
  };
  await installEntries(page, [todayEntry], [detail]);

  let assetUrlReads = 0;
  await page.route('**/api/v1/assets/*/url', (route) => {
    assetUrlReads++;
    const expiresAt = new Date(clockStart.valueOf() + assetUrlReads * 60_000).toISOString();
    const url = assetUrlReads === 1 ? '/thumbnail-expired.svg' : '/thumbnail-fresh.svg';
    return route.fulfill({ json: { url, expiresAt } });
  });

  let releaseExpiredImage!: () => void;
  let notifyExpiredImage!: () => void;
  const expiredImageGate = new Promise<void>((resolve) => {
    releaseExpiredImage = resolve;
  });
  const expiredImageRequested = new Promise<void>((resolve) => {
    notifyExpiredImage = resolve;
  });
  let freshImageRequests = 0;
  await page.route('**/thumbnail-expired.svg', async (route) => {
    notifyExpiredImage();
    await expiredImageGate;
    await route.abort('failed');
  });
  await page.route('**/thumbnail-fresh.svg', (route) => {
    freshImageRequests++;
    return freshImageRequests <= 2
      ? route.abort('failed')
      : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });

  await page.goto('/');
  const frame = page.locator('.home-today-image');
  const image = frame.locator('img.entry-thumbnail-image');
  await expect(image).toHaveAttribute('src', '/thumbnail-expired.svg');
  await expiredImageRequested;
  const beforeFailure = await frame.boundingBox();
  await page.clock.fastForward(60_000);
  releaseExpiredImage();

  const retry = page.getByRole('button', { name: '漫画画像を再読み込み' });
  await expect(retry).toBeVisible();
  await expect.poll(() => assetUrlReads).toBe(2);
  await expect.poll(() => freshImageRequests).toBe(1);
  await expect(
    page.locator('.home-today-image-link').getByRole('button', { name: '漫画画像を再読み込み' }),
  ).toHaveCount(0);
  expect(await retry.evaluate((button) => button.closest('a'))).toBeNull();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(assetUrlReads).toBe(2);
  expect(await frame.boundingBox()).toEqual(beforeFailure);

  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => assetUrlReads).toBe(3);
  await expect.poll(() => freshImageRequests).toBe(2);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-disabled', 'false');

  await page.keyboard.press('Enter');
  await expect.poll(() => assetUrlReads).toBe(4);
  await expect.poll(() => freshImageRequests).toBe(3);
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(4);
  await expect(retry).toHaveCount(0);
  await expect(page.locator('.home-today-image-link')).toBeFocused();
  expect(await frame.boundingBox()).toEqual(beforeFailure);
  expect(assetUrlReads).toBe(4);
  expect(freshImageRequests).toBe(3);
});

test('表示済みのHomeサムネイルは可視復帰時に再取得せず表示を保つ', async ({ page }) => {
  await page.clock.install({ time: clockStart });
  const todayEntry = entry(todayEntryId, today, '期限後も表示を保つ架空日記', todayGenerationId);
  const todayGeneration = generationWithAsset(todayGenerationId, todayEntryId, todayAssetId);
  const detail: EntryDetail = {
    ...todayEntry,
    latestGeneration: todayGeneration,
    lastSuccessfulGeneration: todayGeneration,
  };
  await installEntries(page, [todayEntry], [detail]);

  let assetUrlReads = 0;
  let thumbnailRequests = 0;
  await page.route('**/api/v1/assets/*/url', (route) => {
    assetUrlReads++;
    return assetUrlReads === 1
      ? route.fulfill({
          json: {
            url: '/visible-thumbnail.svg',
            expiresAt: new Date(clockStart.valueOf() + 60_000).toISOString(),
          },
        })
      : route.fulfill({ status: 503, body: '' });
  });
  await page.route('**/visible-thumbnail.svg', (route) => {
    thumbnailRequests++;
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });

  await page.goto('/');
  const image = page.locator('.home-today-image-link img.entry-thumbnail-image');
  await expect(image).toHaveAttribute('src', '/visible-thumbnail.svg');
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(4);
  await expect.poll(() => assetUrlReads).toBe(1);
  await expect.poll(() => thumbnailRequests).toBe(1);

  await page.clock.fastForward(65_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(250);

  expect(assetUrlReads).toBe(1);
  expect(thumbnailRequests).toBe(1);
  await expect(image).toHaveAttribute('src', '/visible-thumbnail.svg');
  await expect(image).toBeVisible();
  await expect(page.getByRole('button', { name: '漫画画像を再読み込み' })).toHaveCount(0);
});

test('非選択tabにある未読込Libraryサムネイルは期限後も署名URLを取得しない', async ({ page }) => {
  await page.clock.install({ time: clockStart });
  const dateAtOffset = (days: number) => {
    const date = new Date(`${today}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const records = [
    {
      entry: entry(todayEntryId, today, '今日の架空日記', todayGenerationId),
      assetId: todayAssetId,
    },
    {
      entry: entry(previousEntryId, dateAtOffset(1), '昨日の架空日記', previousGenerationId),
      assetId: previousAssetId,
    },
    {
      entry: entry(
        previousFailureId,
        dateAtOffset(2),
        '一昨日の架空日記',
        '11111111-1111-4111-8111-111111111111',
      ),
      assetId: 'third-thumbnail-asset',
    },
    {
      entry: entry(
        '99999999-9999-4999-8999-999999999999',
        dateAtOffset(3),
        '非選択tabに残る日記',
        '22222222-2222-4222-8222-222222222222',
      ),
      assetId: 'hidden-thumbnail-asset',
    },
  ];
  const details: EntryDetail[] = records.map(({ entry: current, assetId }) => {
    const generation = generationWithAsset(current.latestGenerationId!, current.id, assetId);
    return {
      ...current,
      latestGeneration: generation,
      lastSuccessfulGeneration: generation,
    };
  });
  await installEntries(
    page,
    records.map(({ entry: current }) => current),
    details,
  );

  let targetAssetReads = 0;
  let targetImageRequests = 0;
  let releaseTargetImage!: () => void;
  let notifyTargetImage!: () => void;
  const targetImageGate = new Promise<void>((resolve) => {
    releaseTargetImage = resolve;
  });
  const targetImageRequested = new Promise<void>((resolve) => {
    notifyTargetImage = resolve;
  });
  await page.route('**/api/v1/assets/*/url', (route) => {
    const assetId = new URL(route.request().url()).pathname.split('/').at(-2);
    if (assetId !== 'hidden-thumbnail-asset')
      return route.fulfill({
        json: { url: '/other-thumbnail.svg', expiresAt: '2099-01-01T00:00:00.000Z' },
      });
    targetAssetReads++;
    return route.fulfill({
      json: {
        url: '/hidden-thumbnail-' + targetAssetReads + '.svg',
        expiresAt: new Date(clockStart.valueOf() + 60_000).toISOString(),
      },
    });
  });
  await page.route('**/hidden-thumbnail-*.svg', async (route) => {
    targetImageRequests++;
    if (targetImageRequests === 1) {
      notifyTargetImage();
      await targetImageGate;
    }
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });
  await page.route('**/other-thumbnail.svg', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }),
  );

  await page.goto('/library?day=' + dateAtOffset(3));
  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  const targetCard = calendarPanel
    .locator('.entry-history-card')
    .filter({ hasText: '非選択tabに残る日記' });
  await expect(targetCard).toBeVisible();
  await targetCard.scrollIntoViewIfNeeded();
  const image = targetCard.locator('img.entry-thumbnail-image');
  await expect(image).toHaveAttribute('src', '/hidden-thumbnail-1.svg');
  await targetImageRequested;
  expect(targetAssetReads).toBe(1);
  expect(targetImageRequests).toBe(1);

  await page.getByRole('tab', { name: 'リスト' }).click();
  await expect(calendarPanel).toBeHidden();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.clock.fastForward(65_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(250);

  expect(targetAssetReads).toBe(1);
  expect(targetImageRequests).toBe(1);
  releaseTargetImage();
});

test('EntryHistoryのpermission失敗はpollせず、HomeとLibraryのretryを画像領域内に置く', async ({
  page,
}) => {
  const todayEntry = entry(todayEntryId, today, '今日の架空記録', todayGenerationId);
  const previousEntry = entry(
    previousEntryId,
    yesterday,
    '昨日の架空記録と保持済み漫画',
    previousFailureId,
  );
  const todayGeneration = generationWithAsset(todayGenerationId, todayEntryId, todayAssetId);
  const previousSuccess = generationWithAsset(
    previousGenerationId,
    previousEntryId,
    previousAssetId,
  );
  const previousFailure = generationFixtures(previousEntryId, previousFailureId).failed;
  const details: EntryDetail[] = [
    {
      ...todayEntry,
      latestGeneration: todayGeneration,
      lastSuccessfulGeneration: todayGeneration,
    },
    {
      ...previousEntry,
      latestGeneration: previousFailure,
      lastSuccessfulGeneration: previousSuccess,
    },
  ];
  await installEntries(page, [todayEntry, previousEntry], details);

  let previousAssetReads = 0;
  let releaseHomeAssetError!: () => void;
  let notifyHomeAssetError!: () => void;
  const homeAssetErrorGate = new Promise<void>((resolve) => {
    releaseHomeAssetError = resolve;
  });
  const homeAssetErrorRequested = new Promise<void>((resolve) => {
    notifyHomeAssetError = resolve;
  });
  let releaseLibraryAssetError!: () => void;
  let notifyLibraryAssetError!: () => void;
  const libraryAssetErrorGate = new Promise<void>((resolve) => {
    releaseLibraryAssetError = resolve;
  });
  const libraryAssetErrorRequested = new Promise<void>((resolve) => {
    notifyLibraryAssetError = resolve;
  });
  await page.route('**/api/v1/assets/*/url', async (route) => {
    const assetId = new URL(route.request().url()).pathname.split('/').at(-2);
    if (assetId === todayAssetId)
      return route.fulfill({
        json: { url: '/today-thumbnail.svg', expiresAt: '2099-01-01T00:00:00.000Z' },
      });
    if (assetId !== previousAssetId)
      return route.fulfill({
        status: 404,
        json: {
          error: {
            code: 'NOT_FOUND',
            message: '見つかりません。',
            requestId: 'fixture-request-id',
            retryable: false,
          },
        },
      });

    previousAssetReads++;
    if (previousAssetReads === 1) {
      notifyHomeAssetError();
      await homeAssetErrorGate;
    } else if (previousAssetReads === 3) {
      notifyLibraryAssetError();
      await libraryAssetErrorGate;
    } else {
      return route.fulfill({
        json: { url: '/previous-success.svg', expiresAt: '2099-01-01T00:00:00.000Z' },
      });
    }
    return route.fulfill({
      status: 403,
      json: {
        error: {
          code: 'FORBIDDEN',
          message: 'アクセスできません。',
          requestId: 'fixture-request-id',
          retryable: false,
        },
      },
    });
  });
  await page.route('**/today-thumbnail.svg', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }),
  );
  await page.route('**/previous-success.svg', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }),
  );

  await page.goto('/');
  await page.locator('.recent-records').scrollIntoViewIfNeeded();
  const homeItem = page.locator('.recent-records .entry-history-item');
  await expect(homeItem).toContainText('生成失敗');
  await homeAssetErrorRequested;
  const homeItemBefore = await homeItem.boundingBox();
  releaseHomeAssetError();
  const homeRetry = homeItem.getByRole('button', { name: '漫画画像を再読み込み' });
  await expect(homeRetry).toBeVisible();
  expect(await homeRetry.evaluate((button) => button.closest('a'))).toBeNull();
  expect(await homeItem.boundingBox()).toEqual(homeItemBefore);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(previousAssetReads).toBe(1);
  await homeRetry.click();
  await expect.poll(() => previousAssetReads).toBe(2);
  await expect(homeRetry).toHaveCount(0);

  await page.getByRole('link', { name: '記録', exact: true }).click();
  await page.getByRole('tab', { name: 'リスト' }).click();
  const libraryItem = page
    .locator('.library-list-records .entry-history-item')
    .filter({ hasText: '昨日の架空記録と保持済み漫画' });
  await expect(libraryItem).toContainText('生成失敗');
  await libraryAssetErrorRequested;
  const libraryItemBefore = await libraryItem.boundingBox();
  releaseLibraryAssetError();
  const libraryRetry = libraryItem.getByRole('button', { name: '漫画画像を再読み込み' });
  await expect(libraryRetry).toBeVisible();
  expect(await libraryRetry.evaluate((button) => button.closest('a'))).toBeNull();
  expect(await libraryItem.boundingBox()).toEqual(libraryItemBefore);
  await libraryRetry.click();
  await expect.poll(() => previousAssetReads).toBe(4);
  await expect(libraryRetry).toHaveCount(0);
  await expect
    .poll(() =>
      libraryItem
        .locator('img.entry-thumbnail-image')
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBe(4);
  expect(previousAssetReads).toBe(4);
});
