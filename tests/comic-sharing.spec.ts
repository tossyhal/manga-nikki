import { expect, test } from '@playwright/test';
import { clickAppDialogButton, clickEntryMenuItem } from './fixtures/ui';
import { pageComic, panelsComic } from '../src/shared/fixtures';

test('漫画をPNG保存し、別のブラウザへURLだけで共有して削除で終了する', async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ClipboardItem', {
      configurable: true,
      value: class ClipboardItemMock {
        constructor(readonly data: Record<string, string | Blob | PromiseLike<string | Blob>>) {}
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (
          items: Array<{
            data: Record<string, string | Blob | PromiseLike<string | Blob>>;
          }>,
        ) => {
          document.documentElement.dataset.clipboardWriteStarted = 'true';
          const clipboardValue = items[0]?.data['text/plain'];
          if (clipboardValue === undefined) throw new Error('CLIPBOARD_ITEM_MISSING');
          const text = await clipboardValue;
          document.documentElement.dataset.copiedUrl =
            typeof text === 'string' ? text : await text.text();
        },
      },
    });
  });
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('本文は共有しない架空の日記。');
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.locator('.comic-script')).toHaveCount(0);
  await expect(page.locator('.comic-transcript > ol.sr-only')).toHaveCount(1);
  await expect(page.locator('#original-diary summary')).toHaveText('元の日記を読む');
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

  let shareRequests = 0;
  let signalShareStarted!: () => void;
  let releaseShare!: () => void;
  const shareStarted = new Promise<void>((resolve) => {
    signalShareStarted = resolve;
  });
  const shareGate = new Promise<void>((resolve) => {
    releaseShare = resolve;
  });
  await page.route('**/api/v1/generations/*/share', async (route) => {
    expect(route.request().method()).toBe('POST');
    shareRequests += 1;
    signalShareStarted();
    await shareGate;
    await route.continue();
  });
  const shareButton = page.locator('.comic-actions-toolbar button').nth(1);
  await shareButton.click();
  await shareStarted;
  await expect(page.locator('html')).toHaveAttribute('data-clipboard-write-started', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-copied-url');
  await expect(shareButton).toBeDisabled();
  await shareButton.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(shareRequests).toBe(1);
  releaseShare();
  await expect(page.getByText('URLをコピーしました。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('共有URL', { exact: true })).toHaveCount(0);
  const sharedUrl = await page.locator('html').getAttribute('data-copied-url');
  expect(sharedUrl).toMatch(/^https?:\/\/[^/]+\/shared\/[a-f0-9]{64}$/);
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  const authRequests: string[] = [];
  guestPage.on('request', (request) => {
    if (request.url().includes('supabase.co/auth') || request.url().includes('/api/v1/entries'))
      authRequests.push(request.url());
  });
  await guestPage.goto(sharedUrl!);
  await expect(guestPage.getByRole('heading', { name: 'いつもの一日', exact: true })).toBeVisible();
  await expect(guestPage.getByText('漫画日記', { exact: true })).toHaveCount(0);
  await expect(guestPage.getByText('共有された漫画', { exact: true })).toHaveCount(0);
  await expect(guestPage.getByText('本文は共有しない架空の日記。')).toHaveCount(0);
  expect(authRequests).toEqual([]);
  await clickEntryMenuItem(page, '日記を削除');
  await clickAppDialogButton(page, 'この日記を削除しますか？', '削除する');
  await guestPage.reload();
  await expect(guestPage.getByRole('alert')).toContainText('共有が終了しています');
  await guest.close();
});

test('共有URLをコピーできない場合はURL欄と再コピー操作を表示する', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('CLIPBOARD_DENIED');
        },
      },
    });
  });
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('共有URLのコピー失敗を確認する架空の日記。');
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();
  await expect(page).toHaveURL(/\/entries\//);

  await page.route('**/api/v1/generations/*/share', (route) =>
    route.fulfill({ status: 201, json: { path: `/shared/${'c'.repeat(64)}` } }),
  );
  await page.getByRole('button', { name: 'URLで共有', exact: true }).click();
  await expect(
    page.getByText('URLをコピーできませんでした。下のURLを選択してコピーしてください。', {
      exact: true,
    }),
  ).toBeVisible();
  const sharedUrl = page.getByLabel('共有URL', { exact: true });
  await expect(sharedUrl).toHaveValue(/\/shared\/[a-f0-9]{64}$/);
  await sharedUrl.focus();
  await expect(sharedUrl).toHaveJSProperty('selectionStart', 0);
  await expect(sharedUrl).toHaveJSProperty('selectionEnd', (await sharedUrl.inputValue()).length);
  await page.getByRole('button', { name: 'もう一度コピー', exact: true }).click();
  await expect(sharedUrl).toBeVisible();
  await expect(
    page.getByText('URLをコピーできませんでした。下のURLを選択してコピーしてください。', {
      exact: true,
    }),
  ).toBeVisible();
});

test('共有URLの作成に失敗した場合はコピー失敗として案内しない', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ClipboardItem', {
      configurable: true,
      value: class ClipboardItemMock {
        constructor(readonly data: Record<string, string | Blob | PromiseLike<string | Blob>>) {}
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (
          items: Array<{
            data: Record<string, string | Blob | PromiseLike<string | Blob>>;
          }>,
        ) => {
          const clipboardValue = items[0]?.data['text/plain'];
          if (clipboardValue === undefined) throw new Error('CLIPBOARD_ITEM_MISSING');
          await clipboardValue;
        },
      },
    });
  });
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('共有URL作成の失敗を確認する架空の日記。');
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await page.route('**/api/v1/generations/*/share', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }),
  );

  await page.getByRole('button', { name: 'URLで共有', exact: true }).click();
  await expect(
    page.getByText('共有URLを作成できませんでした。時間をおいて再試行してください。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('URLをコピーできませんでした。下のURLを選択してコピーしてください。'),
  ).toHaveCount(0);
  await expect(page.getByLabel('共有URL', { exact: true })).toHaveCount(0);
});

test('4枚のコマ画像と外付けの文章を1枚のPNGにまとめる', async ({ page }) => {
  const token = 'a'.repeat(64);
  const ids = panelsComic.visual.kind === 'panels' ? panelsComic.visual.assetIds : [];
  const images = Object.fromEntries(ids.map((id) => [id, '/sample-comic.svg']));
  await page.route(`**/api/v1/shared/${token}`, (route) =>
    route.fulfill({ json: { comic: panelsComic, images } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shared/${token}`);
  await expect(page.getByRole('heading', { name: panelsComic.title, exact: true })).toBeVisible();
  await expect(page.locator('.comic-panel-card')).toHaveCount(4);
  const sharedPageBounds = await page.locator('.shared-comic-page').boundingBox();
  const sharedComicBounds = await page.locator('.shared-comic-page > .comic').boundingBox();
  const sharedActionsBounds = await page
    .locator('.shared-comic-page > .comic-actions')
    .boundingBox();
  const sharedGridColumns = await page
    .locator('.shared-comic-page .comic-images')
    .evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
    );
  expect(sharedComicBounds?.width).toBeGreaterThan(720);
  expect(sharedGridColumns).toBe(2);
  expect(sharedComicBounds?.x).toBeGreaterThanOrEqual(sharedPageBounds?.x ?? 0);
  expect((sharedComicBounds?.x ?? 0) + (sharedComicBounds?.width ?? 0)).toBeLessThanOrEqual(
    (sharedPageBounds?.x ?? 0) + (sharedPageBounds?.width ?? 0),
  );
  expect(sharedActionsBounds?.x).toBeGreaterThanOrEqual(sharedPageBounds?.x ?? 0);
  expect((sharedActionsBounds?.x ?? 0) + (sharedActionsBounds?.width ?? 0)).toBeLessThanOrEqual(
    (sharedPageBounds?.x ?? 0) + (sharedPageBounds?.width ?? 0),
  );
  const sharedCardPositions = await page
    .locator('.shared-comic-page .comic-panel-card')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const image = card.querySelector('.comic-panel-image-frame');
        const caption = card.querySelector('.comic-panel-caption');
        if (!image || !caption) throw new Error('共有漫画のコマ説明がありません');
        return {
          x: card.getBoundingClientRect().x,
          y: card.getBoundingClientRect().y,
          right: card.getBoundingClientRect().right,
          imageRight: image.getBoundingClientRect().right,
          captionX: caption.getBoundingClientRect().x,
          captionRight: caption.getBoundingClientRect().right,
        };
      }),
    );
  expect(sharedCardPositions[1]?.x).toBeGreaterThan(sharedCardPositions[0]?.x ?? 0);
  expect(sharedCardPositions[2]?.x).toBeLessThan(sharedCardPositions[3]?.x ?? 0);
  expect(sharedCardPositions[2]?.y).toBeGreaterThan(sharedCardPositions[0]?.y ?? 0);
  for (const position of sharedCardPositions) {
    expect(position.captionX).toBeGreaterThan(position.imageRight);
    expect(position.captionRight).toBeLessThanOrEqual(position.right);
  }
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(1440);

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
