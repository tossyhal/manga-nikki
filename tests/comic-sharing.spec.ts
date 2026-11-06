import { expect, test } from '@playwright/test';
import { clickAppDialogButton, clickEntryMenuItem } from './fixtures/ui';
import { pageComic, panelsComic } from '../src/shared/fixtures';

test('漫画をPNG保存し、別のブラウザへURLだけで共有して削除で終了する', async ({
  page,
  browser,
}) => {
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('本文は共有しない架空の日記。');
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('button', { name: '画像を保存', exact: true })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '画像を保存', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('manga-nikki.png');
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  const { readFile } = await import('node:fs/promises');
  const png = await readFile(downloadPath!);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await page.getByRole('button', { name: 'URLで共有', exact: true }).click();
  await page.getByRole('button', { name: '共有URLを作る', exact: true }).click();
  const sharedUrl = page.getByLabel('共有URL', { exact: true });
  await expect(sharedUrl).toHaveValue(/\/shared\/[a-f0-9]{64}$/);
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  const authRequests: string[] = [];
  guestPage.on('request', (request) => {
    if (request.url().includes('supabase.co/auth') || request.url().includes('/api/v1/entries'))
      authRequests.push(request.url());
  });
  await guestPage.goto(await sharedUrl.inputValue());
  await expect(guestPage.getByRole('heading', { name: 'いつもの一日', exact: true })).toBeVisible();
  await expect(guestPage.getByText('本文は共有しない架空の日記。')).toHaveCount(0);
  expect(authRequests).toEqual([]);
  await clickEntryMenuItem(page, '日記を削除');
  await clickAppDialogButton(page, 'この日記を削除しますか？', '削除する');
  await guestPage.reload();
  await expect(guestPage.getByRole('alert')).toContainText('共有が終了しています');
  await guest.close();
});

test('4枚のコマ画像と外付けの文章を1枚のPNGにまとめる', async ({ page }) => {
  const token = 'a'.repeat(64);
  const ids = panelsComic.visual.kind === 'panels' ? panelsComic.visual.assetIds : [];
  const images = Object.fromEntries(ids.map((id) => [id, '/sample-comic.svg']));
  await page.route(`**/api/v1/shared/${token}`, (route) =>
    route.fulfill({ json: { comic: panelsComic, images } }),
  );
  await page.goto(`/shared/${token}`);
  await expect(page.getByRole('heading', { name: panelsComic.title, exact: true })).toBeVisible();
  await expect(page.locator('.comic-panel-card')).toHaveCount(4);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '画像を保存', exact: true }).click();
  const downloaded = await pending;
  const { readFile } = await import('node:fs/promises');
  const png = await readFile((await downloaded.path())!);
  expect(png.readUInt32BE(16)).toBe(848);
  expect(png.readUInt32BE(20)).toBeGreaterThan(3200);
  expect(await downloaded.failure()).toBeNull();
});

for (const ended of [false, true]) {
  test(`共有画像の署名失効時は一度だけ再取得し、${ended ? '削除済みなら共有を止める' : '新しい画像を表示する'}`, async ({
    page,
  }) => {
    await page.clock.install();
    const token = 'b'.repeat(64);
    const id = pageComic.visual.kind === 'page' ? pageComic.visual.assetId : '';
    let expired = false;
    let renewals = 0;
    let signalRequested!: () => void;
    let releaseImage!: () => void;
    const requested = new Promise<void>((resolve) => {
      signalRequested = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.route(`**/api/v1/shared/${token}`, async (route) => {
      if (expired) renewals += 1;
      if (ended && expired)
        return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
      return route.fulfill({
        json: {
          comic: pageComic,
          images: { [id]: !expired ? '/test-expired-image.png' : '/sample-comic.svg?renewed=1' },
        },
      });
    });
    await page.route('**/test-expired-image.png', async (route) => {
      signalRequested();
      await gate;
      await route.fulfill({ status: 403, body: '' });
    });
    await page.goto(`/shared/${token}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: pageComic.title, exact: true })).toBeVisible();
    await requested;
    await page.clock.fastForward(60_000);
    expired = true;
    releaseImage();
    if (ended) {
      await expect(page.getByRole('alert')).toContainText('共有が終了しています');
      await expect(page.locator('.comic')).toHaveCount(0);
    } else {
      await expect(page.locator('.comic img').first()).toHaveAttribute(
        'src',
        '/sample-comic.svg?renewed=1',
      );
      await expect(page.getByText('漫画の画像を表示できません。', { exact: true })).toHaveCount(0);
    }
    expect(renewals).toBe(1);
  });
}
