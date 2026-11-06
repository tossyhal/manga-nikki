import { expect, test } from '@playwright/test';
import { mockClientConfigFixture } from './fixtures/client-config';

test('JavaScriptの起動前もHTMLの起動画面を表示する', async ({ page }) => {
  let release!: () => void;
  let releaseConfig!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  await page.route('**/src/client/main.tsx*', async (route) => {
    await gate;
    await route.continue();
  });
  await page.route('**/api/v1/config', async (route) => {
    await configGate;
    await route.continue();
  });

  await page.goto('/new', { waitUntil: 'commit' });
  const fallback = page.locator('#startup-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText('漫画日記');
  await expect(fallback).toContainText('準備中');
  await expect(fallback.locator('img')).toHaveAttribute('src', '/icon-192.png');
  await expect(page.getByRole('status')).toHaveText('準備中…');

  release();
  await expect(page.locator('.startup-screen')).toBeVisible();
  releaseConfig();
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
  await expect(fallback).toHaveCount(0);
});

test('初回の設定取得中だけ起動画面を表示し、画面遷移では再表示しない', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/config', async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto('/new');
  const startupScreen = page.locator('.startup-screen');
  await expect(startupScreen).toBeVisible();
  await expect(startupScreen).toContainText('漫画日記');
  await expect(startupScreen).toContainText('準備中');
  await expect(startupScreen.getByRole('status')).toHaveText('準備中…');
  await expect
    .poll(() =>
      page
        .locator('.startup-screen__indicator')
        .evaluate((indicator) => getComputedStyle(indicator).animationName),
    )
    .toBe('none');

  release();
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
  await expect(startupScreen).toHaveCount(0);

  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
  await expect(startupScreen).toHaveCount(0);

  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page).toHaveURL(/\/library/);
  await expect(startupScreen).toHaveCount(0);
});

test('起動画面中もPWAのオフライン案内を表示する', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/config', async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto('/new');
  await expect(page.locator('.startup-screen')).toBeVisible();
  await expect(page.locator('.app-notices')).toContainText(
    'オフラインです。保存・履歴の取得・漫画の生成には通信が必要です。',
  );

  release();
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
});

test('初回の設定取得に失敗した後は再試行でき、再試行中に起動画面を出さない', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/v1/config', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ json: mockClientConfigFixture });
  });

  await page.goto('/new');
  const startupScreen = page.locator('.startup-screen');
  await expect(startupScreen).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '読み込めませんでした' })).toBeVisible();
  await expect(page.getByRole('button', { name: '再読み込み' })).toBeVisible();

  await page.getByRole('button', { name: '再読み込み' }).click();
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
  await expect(startupScreen).toHaveCount(0);
  expect(attempts).toBe(2);
});
