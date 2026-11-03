import { expect, test } from '@playwright/test';

test('production previewは公開用静的ファイルだけをcacheし、offlineで架空サンプルを表示する', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /今日のことを/ })).toBeVisible();
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
          '/sample-comic.svg',
        ].includes(path) || /^\/assets\/.+\.(?:js|css)$/.test(path),
    ),
  ).toBe(true);
  expect(cachedPaths.some((path) => path.startsWith('/api/'))).toBe(false);

  await context.setOffline(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /今日のことを/ })).toBeVisible();
  await expect(page.locator('.sample img')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('オフラインです。');
});
