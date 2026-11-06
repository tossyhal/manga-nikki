import { expect, test, type Page } from '@playwright/test';
import { pageComic, sampleDiary } from '../src/shared/fixtures';

async function openPublicSample(page: Page) {
  const errorCard = page.locator('.app-state-card[role="alert"]');
  await expect(errorCard.getByRole('heading', { name: '読み込めませんでした' })).toBeVisible();
  await errorCard.getByRole('button', { name: 'サンプルを見る' }).click();

  const sample = page.locator('.sample-detail');
  await expect(sample.getByRole('heading', { level: 1, name: pageComic.title })).toBeVisible();
  await expect(sample.getByText('架空サンプル', { exact: true })).toBeVisible();
  await expect(sample.locator('.original-diary > p')).toHaveText(sampleDiary);
  const image = sample.locator('.comic img');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', '/sample-comic.svg');
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

test('production previewは公開用静的ファイルだけをcacheし、offlineで架空サンプルを表示する', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await openPublicSample(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();

  const cachedPaths = await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const requests = await Promise.all(
      cacheNames.map(async (cacheName) => (await caches.open(cacheName)).keys()),
    );
    return requests.flat().map((request) => new URL(request.url).pathname);
  });

  expect(cachedPaths).toContain('/index.html');
  expect(cachedPaths).toContain('/manifest.webmanifest');
  expect(cachedPaths).toContain('/icon-192.png');
  expect(cachedPaths).toContain('/icon-512.png');
  expect(cachedPaths).toContain('/cat-mascot.png');
  expect(cachedPaths).toContain('/sample-comic.svg');
  expect(cachedPaths.some((path) => /^\/assets\/.+\.js$/.test(path))).toBe(true);
  expect(cachedPaths.some((path) => /^\/assets\/.+\.css$/.test(path))).toBe(true);
  expect(
    cachedPaths.every(
      (path) =>
        [
          '/index.html',
          '/manifest.webmanifest',
          '/icon-192.png',
          '/icon-512.png',
          '/cat-mascot.png',
          '/sample-comic.svg',
        ].includes(path) || /^\/assets\/.+\.(?:js|css)$/.test(path),
    ),
  ).toBe(true);
  expect(cachedPaths.some((path) => path.startsWith('/api/'))).toBe(false);

  await context.setOffline(true);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'オフラインです。' })).toBeVisible();
  await openPublicSample(page);
});
