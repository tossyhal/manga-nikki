import { expect, test } from '@playwright/test';
import { generationFixtures, panelsComic } from '../src/shared/fixtures';
import { jstToday, type Entry, type EntryDetail, type Generation } from '../src/shared/schemas';
import { mockClientConfigFixture } from './fixtures/client-config';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assetIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
] as [string, string, string, string];
const start = new Date(`${jstToday()}T12:00:00.000Z`);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';

function makeEntry(): Entry {
  const diaryDate = jstToday();
  return {
    id: entryId,
    diaryDate,
    body: '読み返して漫画を再利用するための架空日記',
    revision: 1,
    latestGenerationId: generationId,
    createdAt: `${diaryDate}T12:00:00.000Z`,
    updatedAt: `${diaryDate}T12:00:00.000Z`,
  };
}

function makeGeneration(entry: Entry): Generation {
  return {
    ...generationFixtures(entry.id, generationId).succeeded,
    mock: false,
    comic: {
      ...panelsComic,
      visual: { kind: 'panels', assetIds, textMode: 'external' },
    },
  };
}

test('4コマ漫画の画像Blobは56秒後の再訪でも再取得せず、読込表示を出さない', async ({ page }) => {
  await page.clock.install({ time: start });
  const entry = makeEntry();
  const generation = makeGeneration(entry);
  const detail: EntryDetail = {
    ...entry,
    latestGeneration: generation,
    lastSuccessfulGeneration: generation,
  };

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries**', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/entries')
      return route.fulfill({ json: { items: [entry], nextCursor: null } });
    if (pathname === `/api/v1/entries/${entryId}`) return route.fulfill({ json: detail });
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  let batchReads = 0;
  let imageFetches = 0;
  await page.route(`**/api/v1/generations/${generationId}/assets`, async (route) => {
    batchReads++;
    if (batchReads > 1) await new Promise((resolve) => setTimeout(resolve, 80));
    const expiresAt = new Date(start.valueOf() + batchReads * 60_000).toISOString();
    return route.fulfill({
      json: {
        assets: assetIds.map((id) => ({
          id,
          url: `/performance-${id}.svg`,
          expiresAt,
        })),
      },
    });
  });
  await page.route('**/performance-*.svg', (route) => {
    imageFetches++;
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });

  await page.goto('/');
  const homeImage = page.locator('.home-today-image-link img.entry-thumbnail-image');
  await expect(homeImage).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => homeImage.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(4);
  expect(batchReads).toBe(1);
  expect(imageFetches).toBe(1);

  await page.getByRole('link', { name: '漫画を読む', exact: true }).click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  const comicImages = page.locator('.comic-images .comic-panel-card img');
  await expect(comicImages).toHaveCount(4);
  await expect
    .poll(() =>
      comicImages.evaluateAll((images) =>
        images.every((node) => (node as HTMLImageElement).naturalWidth === 4),
      ),
    )
    .toBe(true);
  expect(batchReads).toBe(1);
  expect(imageFetches).toBe(4);

  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.locator('.home-page')).toBeVisible();
  await page.clock.fastForward(56_000);
  await page.getByRole('link', { name: '漫画を読む', exact: true }).click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(comicImages).toHaveCount(4);
  await expect
    .poll(() =>
      comicImages.evaluateAll((images) =>
        images.every((node) => (node as HTMLImageElement).naturalWidth === 4),
      ),
    )
    .toBe(true);

  expect(batchReads).toBe(2);
  expect(imageFetches).toBe(4);
  await expect(page.getByText('漫画画像を読み込んでいます…', { exact: true })).toHaveCount(0);
});
