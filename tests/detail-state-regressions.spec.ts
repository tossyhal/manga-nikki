import { expect, test } from '@playwright/test';
import { generationFixtures } from '../src/shared/fixtures';
import type { EntryDetail } from '../src/shared/schemas';
import { draftEntryDetailFixture, mockClientConfigFixture } from './fixtures/client-config';
import { routeComicAssets } from './fixtures/comic-assets';

const entryId = draftEntryDetailFixture.id;
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function availableQuota() {
  return {
    remainingToday: 3,
    activeGenerationId: null,
    resetAt: '2026-01-02T00:00:00Z',
    generationAvailable: true,
  };
}

test('sessionStorageが拒否されても詳細を表示し、受付キーなしの生成を送信しない', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('review storage denied');
      },
    });
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  let generationPosts = 0;
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationPosts++;
    return route.fulfill({ status: 202, json: {} });
  });

  await page.goto(`/entries/${entryId}`);
  await expect(page.locator('.diary')).toHaveText(draftEntryDetailFixture.body);
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();

  await expect(page.locator('.detail-page [role="alert"]')).toContainText('ストレージ設定');
  await expect(page.getByRole('heading', { name: 'Unexpected Application Error!' })).toHaveCount(0);
  expect(generationPosts).toBe(0);
});

test('同revisionの成功済み漫画がある409後は最新漫画へ復帰する', async ({ page }) => {
  const succeeded = generationFixtures(entryId, generationId, 1).succeeded;
  const latestDetail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: null,
  };
  let latestReads = 0;
  let generationRejected = false;
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (generationRejected) latestReads++;
    return route.fulfill({ json: generationRejected ? latestDetail : draftEntryDetailFixture });
  });
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationPosts++;
    generationRejected = true;
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'REVISION_ALREADY_GENERATED',
          message: '同じrevisionで生成済みです。',
          requestId: 'revision-already-generated-e2e',
          retryable: false,
        },
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: succeeded }),
  );
  await routeComicAssets(page, generationId, () => succeeded.comic);

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();

  await expect(page.locator('.comic')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'いつもの一日' })).toBeVisible();
  await expect(
    page.locator('.detail-action-dock').getByRole('button', { name: '4コマにする' }),
  ).toHaveCount(0);
  await expect(page.locator('.detail-page [role="alert"]')).toHaveCount(0);
  expect(generationPosts).toBe(1);
  expect(latestReads).toBeGreaterThan(0);
});
