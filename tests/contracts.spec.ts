import { expect, test, type Page } from '@playwright/test';
import { generationFixtures, pageComic, panelsComic } from '../src/shared/fixtures';
import type { EntryDetail, Generation } from '../src/shared/schemas';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixtures = generationFixtures(entryId, generationId);
function detail(generation: Generation, revision = 1): EntryDetail {
  return {
    id: entryId,
    diaryDate: '2026-01-01',
    body: '架空のテスト日記',
    revision,
    latestGenerationId: generation.id,
    latestGeneration: generation,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
async function intercept(page: Page, getGeneration: () => Generation, revision = 1) {
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(getGeneration(), revision) }),
  );
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: getGeneration() }),
  );
  await page.route('**/api/v1/assets/*/url', async (route) => {
    const id = route.request().url().split('/').at(-2);
    return route.fulfill({
      json: { url: `/sample-comic.svg?asset=${id}`, expiresAt: '2099-01-01T00:00:00Z' },
    });
  });
}
for (const [kind, template] of [
  ['page', pageComic],
  ['panels', panelsComic],
] as const) {
  test(`APIから受け取った${kind}漫画の脚本と画像を表示する`, async ({ page }) => {
    const comic = structuredClone(template);
    comic.title = 'APIから届いた別の一日';
    comic.panels[0].caption = '海辺で貝殻を拾った';
    comic.panels[0].dialogue = '波がきれい';
    await intercept(page, () => ({ ...fixtures.succeeded, comic }));
    await page.goto(`/entries/${entryId}`);
    await expect(page.getByRole('heading', { level: 1, name: comic.title })).toBeVisible();
    if (comic.visual.kind === 'page') {
      await expect(page.getByText('4コマの内容を読む', { exact: true })).toHaveCount(0);
      const transcript = page.locator('.comic-transcript > ol.sr-only');
      await expect(transcript).toContainText(comic.panels[0].caption);
      await expect(transcript).toContainText('「波がきれい」');
    } else {
      await expect(page.getByText(comic.panels[0].caption, { exact: true })).toBeVisible();
      await expect(page.getByText('「波がきれい」')).toBeVisible();
    }
    const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
    await expect(page.locator('.comic img')).toHaveCount(ids.length);
    for (const [index, id] of ids.entries()) {
      await expect(page.locator('.comic img').nth(index)).toHaveAttribute(
        'src',
        `/sample-comic.svg?asset=${id}`,
      );
    }
  });
}

test('panels漫画の画像URLを取得できなくても脚本を表示する', async ({ page }) => {
  const comic = structuredClone(panelsComic);
  comic.panels[0].caption = '画像URLがなくても読める架空の説明';
  comic.panels[0].dialogue = '絵がなくても残る会話';
  const generation = { ...fixtures.succeeded, comic };
  const requestedAssetIds = new Set<string>();
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(generation) }),
  );
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route('**/api/v1/assets/*/url', async (route) => {
    const assetId = new URL(route.request().url()).pathname.split('/').at(-2);
    if (assetId) requestedAssetIds.add(assetId);
    await route.abort('failed');
  });

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByRole('heading', { level: 1, name: comic.title })).toBeVisible();
  await expect(page.locator('.comic-panel-card')).toHaveCount(4);
  for (const panel of comic.panels) {
    await expect(page.getByText(panel.caption, { exact: true })).toHaveCount(1);
    if (panel.dialogue) {
      await expect(page.getByText(`「${panel.dialogue}」`, { exact: true })).toHaveCount(1);
    }
  }
  await expect(page.getByText('「絵がなくても残る会話」', { exact: true })).toBeVisible();
  await expect.poll(() => requestedAssetIds.size).toBe(4);
});

test('4コマ画像は遅い署名URLを待たずに先に届いたコマから表示する', async ({ page }) => {
  const comic = structuredClone(panelsComic);
  const generation = { ...fixtures.succeeded, comic };
  const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
  const slowId = ids[3];
  let releaseSlowResponse!: () => void;
  let notifySlowRequest!: () => void;
  const slowResponseGate = new Promise<void>((resolve) => {
    releaseSlowResponse = resolve;
  });
  const slowRequestStarted = new Promise<void>((resolve) => {
    notifySlowRequest = resolve;
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(generation) }),
  );
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route('**/api/v1/assets/*/url', async (route) => {
    const assetId = decodeURIComponent(
      new URL(route.request().url()).pathname.split('/').at(-2) ?? '',
    );
    if (assetId === slowId) {
      notifySlowRequest();
      await slowResponseGate;
    }
    return route.fulfill({
      json: {
        url: `/sample-comic.svg?asset=${assetId}`,
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  });
  await page.route('**/sample-comic.svg?asset=*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    }),
  );

  await page.goto(`/entries/${entryId}`);
  try {
    await slowRequestStarted;
    await expect(page.locator('.comic img')).toHaveCount(3);
    for (const id of ids.slice(0, 3)) {
      await expect(page.locator(`.comic img[src="/sample-comic.svg?asset=${id}"]`)).toHaveCount(1);
    }
  } finally {
    releaseSlowResponse();
  }
  await expect(page.locator('.comic img')).toHaveCount(4);
});

test('同じ画像URLのまま手動再読み込みすると漫画画像が復旧する', async ({ page }) => {
  const comic = structuredClone(pageComic);
  const generation = { ...fixtures.succeeded, comic };
  let failImageResponse = true;
  const imageRequests: string[] = [];
  await intercept(page, () => generation);
  await page.route('**/sample-comic.svg?asset=*', (route) => {
    imageRequests.push(route.request().url());
    if (failImageResponse)
      return route.fulfill({ status: 404, headers: { 'cache-control': 'no-store' }, body: '' });
    return route.fulfill({
      contentType: 'image/svg+xml',
      headers: { 'cache-control': 'no-store' },
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    });
  });

  await page.goto(`/entries/${entryId}`);
  const fallback = page.locator('.comic-script');
  await expect(fallback.getByRole('button', { name: '画像を再読み込み' })).toBeVisible();
  const imageUrl = `/sample-comic.svg?asset=${comic.visual.kind === 'page' ? comic.visual.assetId : ''}`;
  failImageResponse = false;
  await fallback.getByRole('button', { name: '画像を再読み込み' }).click();

  const image = page.locator('.comic img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(10);
  await expect(image).toHaveAttribute('src', imageUrl);
  expect(imageRequests.length).toBeGreaterThanOrEqual(2);
  expect(new Set(imageRequests)).toEqual(new Set([new URL(imageUrl, page.url()).href]));
});

test('拡大画像の署名URL失効は1回だけ自動更新し、その後は手動再取得できる', async ({ page }) => {
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  const comic = structuredClone(panelsComic);
  const generation = { ...fixtures.succeeded, comic };
  const assetUrlRequests = new Map<string, number>();
  let holdInitialResponses = true;
  let releaseInitialResponses!: () => void;
  let notifyInitialRequests!: () => void;
  const initialResponseGate = new Promise<void>((resolve) => {
    releaseInitialResponses = resolve;
  });
  const initialRequestsStarted = new Promise<void>((resolve) => {
    notifyInitialRequests = resolve;
  });
  let holdRenewal = false;
  let releaseRenewal!: () => void;
  const renewalGate = new Promise<void>((resolve) => {
    releaseRenewal = resolve;
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(generation) }),
  );
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route('**/api/v1/assets/*/url', async (route) => {
    const assetId = new URL(route.request().url()).pathname.split('/').at(-2);
    if (!assetId) return route.abort();
    const requestNumber = (assetUrlRequests.get(assetId) ?? 0) + 1;
    assetUrlRequests.set(assetId, requestNumber);
    const browserNow = await page.evaluate(() => Date.now());
    if (requestNumber === 1 && holdInitialResponses) {
      if (assetUrlRequests.size === 4) notifyInitialRequests();
      await initialResponseGate;
    }
    if (holdRenewal) await renewalGate;
    const url = `/sample-comic.svg?asset=${assetId}&request=${requestNumber}`;
    return route.fulfill({
      json: {
        url,
        expiresAt: new Date(
          browserNow + (requestNumber === 1 || requestNumber === 3 ? 60_000 : 120_000),
        ).toISOString(),
      },
    });
  });
  await page.route('**/sample-comic.svg?asset=*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('broken')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    });
  });

  await page.goto(`/entries/${entryId}`);
  await initialRequestsStarted;
  await page.clock.fastForward(10_000);
  holdInitialResponses = false;
  releaseInitialResponses();
  await expect
    .poll(() => [...assetUrlRequests.values()].reduce((sum, count) => sum + count, 0))
    .toBeGreaterThanOrEqual(4);
  const comicImage = page.locator('.comic img').first();
  await expect(comicImage).toBeVisible();
  await expect
    .poll(() => comicImage.evaluate((image) => (image as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
  const initialUrlRequestCount = [...assetUrlRequests.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  await page.locator('.comic-image-button').first().click();
  const dialog = page.getByRole('dialog', { name: '漫画画像' });
  await expect(dialog).toBeVisible();

  async function expireZoomImage() {
    await page.clock.fastForward(51_000);
    const zoomImage = dialog.locator('img');
    await zoomImage.evaluate((image) => {
      const url = new URL((image as HTMLImageElement).src);
      url.searchParams.set('broken', '1');
      (image as HTMLImageElement).src = url.toString();
    });
  }

  holdRenewal = true;
  await expireZoomImage();
  await expect(dialog.getByText('画像を読み込んでいます…')).toBeVisible();
  await expect
    .poll(() => [...assetUrlRequests.values()].reduce((sum, count) => sum + count, 0))
    .toBe(initialUrlRequestCount + 4);
  releaseRenewal();
  await expect(dialog.locator('img')).toBeVisible();
  expect(await dialog.isVisible()).toBe(true);

  await expireZoomImage();
  await expect(dialog.getByText('漫画の画像を表示できません。')).toBeVisible();
  await expect
    .poll(() => [...assetUrlRequests.values()].reduce((sum, count) => sum + count, 0))
    .toBe(initialUrlRequestCount + 4);
  await dialog.getByRole('button', { name: '画像を再読み込み' }).click();
  await expect
    .poll(() => [...assetUrlRequests.values()].reduce((sum, count) => sum + count, 0))
    .toBe(initialUrlRequestCount + 8);
  await expect(dialog.locator('img')).toBeVisible();
  await expect(dialog.getByText('漫画の画像を表示できません。')).toHaveCount(0);

  await page.clock.fastForward(56_000);
  await expect
    .poll(() => [...assetUrlRequests.values()].reduce((sum, count) => sum + count, 0))
    .toBe(initialUrlRequestCount + 8);
  await expect(dialog.locator('img')).toBeVisible();
  await page.clock.fastForward(5_000);
  await dialog.locator('img').evaluate((image) => {
    const url = new URL((image as HTMLImageElement).src);
    url.searchParams.set('broken', '1');
    (image as HTMLImageElement).src = url.toString();
  });
  await expect
    .poll(() => [...assetUrlRequests.values()].reduce((sum, count) => sum + count, 0))
    .toBe(initialUrlRequestCount + 12);
  await expect(dialog.locator('img')).toBeVisible();
});

test('埋め込み文字の漫画で画像取得に失敗したら脚本を一度だけ表示する', async ({ page }) => {
  const comic = structuredClone(pageComic);
  if (comic.visual.kind !== 'page') throw new Error('page comic fixture is required');
  comic.visual.textMode = 'embedded';
  comic.panels[0].caption = '代替表示でも一度だけ読める説明';
  comic.panels[0].dialogue = '一度だけ読み上げる会話';
  const generation = { ...fixtures.succeeded, comic };
  let assetUrlRequests = 0;
  let retryRequested = false;
  let generationPosts = 0;
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(generation) }),
  );
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route('**/api/v1/assets/*/url', (route) => {
    assetUrlRequests++;
    if (!retryRequested) return route.abort('failed');
    return route.fulfill({
      json: {
        url: '/sample-comic.svg?asset=retry',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  });
  await page.route('**/api/v1/entries/*/generations', (route) => {
    generationPosts++;
    return route.abort();
  });

  await page.goto(`/entries/${entryId}`);
  const fallback = page.locator('.comic-image-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback.getByText(comic.panels[0].caption, { exact: true })).toBeVisible();
  await expect(fallback.getByText('「一度だけ読み上げる会話」', { exact: true })).toBeVisible();
  await expect(page.locator('.comic-transcript ol.sr-only')).toHaveCount(0);
  await expect(page.getByText(comic.panels[0].caption, { exact: true })).toHaveCount(1);

  const failedRequests = assetUrlRequests;
  retryRequested = true;
  await fallback.getByRole('button', { name: '画像を再読み込み' }).click();
  const image = page.locator('.comic img');
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const img = element as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      }),
    )
    .toBe(true);
  await expect(page.locator('.comic-image-fallback')).toHaveCount(0);
  expect(assetUrlRequests).toBe(failedRequests + 1);
  expect(generationPosts).toBe(0);
});

test('queuedからrunning、succeededへ進み、完了後はポーリングを止める', async ({ page }) => {
  await page.clock.install();
  let generation: Generation = fixtures.queued;
  let reads = 0;
  await intercept(page, () => {
    reads++;
    return generation;
  });
  await page.goto(`/entries/${entryId}`);
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  await expect(page.getByText('元の日記を読む', { exact: true })).toHaveCount(0);
  generation = fixtures.running;
  await page.clock.runFor(5000);
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  await expect(page.getByText('元の日記を読む', { exact: true })).toHaveCount(0);
  generation = fixtures.succeeded;
  await page.clock.runFor(5000);
  await expect(page.getByRole('heading', { level: 1, name: pageComic.title })).toBeVisible();
  const completedReads = reads;
  await page.clock.runFor(15000);
  // 仮想時計では通信通知の到着まで進まないため、実時間でも観測する。
  await page.waitForTimeout(500);
  expect(reads).toBe(completedReads);
});
test('編集後の日記では旧revisionから生成した漫画だと表示する', async ({ page }) => {
  await intercept(page, () => fixtures.succeeded, 2);
  await page.goto(`/entries/${entryId}`);
  await expect(
    page.getByText('編集前の日記から生成された漫画です。', { exact: true }),
  ).toBeVisible();
});
for (const status of ['failed', 'unknown', 'cancelled'] as const) {
  test(`${status}では漫画なしで表示し、自動で生成しない`, async ({ page }) => {
    await page.clock.install();
    let reads = 0;
    let generates = 0;
    await intercept(page, () => {
      reads++;
      return fixtures[status];
    });
    await page.route('**/api/v1/entries/*/generations', (route) => {
      generates++;
      return route.abort();
    });
    await page.goto(`/entries/${entryId}`);
    if (status === 'unknown') {
      await expect(page.getByRole('heading', { name: '生成結果を確認中' })).toBeVisible();
      await expect(page.getByText('元の日記を読む', { exact: true })).toHaveCount(0);
      await expect(page.locator('.diary')).toHaveCount(0);
    } else {
      await expect(page.getByText('元の日記を読む', { exact: true })).toBeVisible();
      await expect(page.locator('#original-diary')).not.toHaveAttribute('open');
      await page.getByText('元の日記を読む', { exact: true }).click();
      await expect(page.locator('.diary')).toHaveText('架空のテスト日記');
    }
    await expect(page.locator('.comic')).toHaveCount(0);
    if (status === 'cancelled') {
      await expect(page.getByRole('heading', { name: '生成を終了しました' })).toBeVisible();
      await expect(page.getByText('生成は中止されました。')).toBeVisible();
    } else if (status === 'unknown')
      await expect(page.getByRole('heading', { name: '生成結果を確認中' })).toBeVisible();
    else
      await expect(page.getByRole('heading', { name: '漫画を生成できませんでした' })).toBeVisible();
    if (status === 'unknown')
      await expect(page.locator('.generation-card')).toContainText('自動では再生成せず');
    const terminalReads = reads;
    await page.clock.runFor(15000);
    await page.waitForTimeout(500);
    expect(reads).toBe(terminalReads);
    expect(generates).toBe(0);
  });
}

test('生成済み1件と下書き20件の履歴から21件目を開ける', async ({ page, request }) => {
  const owner = crypto.randomUUID();
  const headers = { Authorization: `Bearer mock:${owner}`, 'Content-Type': 'application/json' };
  await page.addInitScript(
    (value) => localStorage.setItem('manga-nikki.mock-session', value),
    owner,
  );
  let oldestId = '';
  for (let i = 0; i < 21; i++) {
    const response = await request.post('/api/v1/entries', {
      headers,
      data: {
        createRequestId: crypto.randomUUID(),
        diaryDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
        body: `架空の履歴${i + 1}件目`,
        consentVersion: 'v1',
      },
    });
    expect(response.status()).toBe(201);
    const entry = await response.json();
    if (i === 0) {
      oldestId = entry.id;
      const generated = await request.post(`/api/v1/entries/${entry.id}/generations`, {
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        data: { expectedRevision: 1, captchaToken: '' },
      });
      expect(generated.status()).toBe(202);
      const detailResponse = await request.get(`/api/v1/entries/${entry.id}`, { headers });
      const detail = await detailResponse.json();
      expect(detail.body).toBe('架空の履歴1件目');
      expect(detail.latestGeneration).toMatchObject({ mock: true, status: 'succeeded' });
    }
  }
  const requestedCursors: string[] = [];
  await page.route('**/api/v1/entries**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor) requestedCursors.push(cursor);
    return route.continue();
  });
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: '記録', exact: true })).toHaveClass(/sr-only/);
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('tab', { name: 'リスト' }).click();
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  const pageControls = listPanel.getByRole('navigation', { name: '記録一覧のページ送り' });
  const listSummaries = listPanel.locator('.entry-history-summary');
  await expect(listSummaries).toHaveCount(3);
  const visibleSummaries = new Set<string>();
  for (let index = 0; index < 7; index++) {
    await expect(pageControls).toContainText(`${index + 1}ページ目`);
    const summaries = await listSummaries.allTextContents();
    expect(summaries).toHaveLength(3);
    summaries.forEach((summary) => visibleSummaries.add(summary));
    if (index < 6) await pageControls.getByRole('button', { name: '次へ' }).click();
  }
  await expect(pageControls).toContainText('7ページ目');
  await expect(listSummaries).toHaveCount(3);
  await expect(pageControls.getByRole('button', { name: '次へ' })).toBeDisabled();
  expect(visibleSummaries.size).toBe(21);
  for (let index = 1; index <= 21; index++) {
    expect(visibleSummaries).toContain(`架空の履歴${index}件目`);
  }
  expect(requestedCursors).toHaveLength(1);

  await pageControls.getByRole('button', { name: '前へ' }).click();
  await expect(pageControls).toContainText('6ページ目');
  await expect(page.getByRole('link', { name: /架空の履歴6件目/ })).toBeVisible();
  for (let index = 0; index < 5; index++) {
    await pageControls.getByRole('button', { name: '前へ' }).click();
  }
  await expect(pageControls).toContainText('1ページ目');
  await expect(page.getByRole('link', { name: /架空の履歴21件目/ })).toBeVisible();
  for (let index = 0; index < 6; index++) {
    await pageControls.getByRole('button', { name: '次へ' }).click();
  }
  await page.getByRole('link', { name: /架空の履歴1件目/ }).click();
  await expect(page).toHaveURL(`/entries/${oldestId}`);
  await expect(page.getByText('元の日記を読む', { exact: true })).toBeVisible();
});

test('保存完了後にレスポンスだけ失っても再送で重複作成しない', async ({ page }) => {
  let savedId = '';
  const requestIds: string[] = [];
  await page.route('**/api/v1/entries', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requestIds.push(route.request().postDataJSON().createRequestId);
    if (savedId) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    savedId = (await response.json()).id;
    await route.abort('failed');
  });
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('保存だけ成功した架空の日記');
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持');
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(`/entries/${savedId}`);
  await expect(
    page.getByRole('heading', { name: '日記を保存しました', exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.locator('.detail-toolbar h1')).toHaveText('保存だけ成功した架空の日記');
  await expect(page.getByRole('heading', { name: '下書きを保存しました' })).toHaveCount(0);
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeVisible();
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await page.reload();
  await expect(page.locator('.entry-draft-card .diary')).toHaveText('保存だけ成功した架空の日記');
  await page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await page.getByRole('tab', { name: 'リスト' }).click();
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  await expect(listPanel.locator('.entry-history-card')).toHaveCount(1);
  await expect(listPanel.getByRole('link', { name: /保存だけ成功した架空の日記/ })).toBeVisible();
});

test('390px幅の履歴では200文字の日記を40文字の要約で表示する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const body = 'A'.repeat(200);
  const summary = `${'A'.repeat(39)}…`;
  await page.goto('/new');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(body);
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.locator('.draft-saved-card > .diary')).toHaveText(`${'A'.repeat(120)}…`);
  const originalDiarySummary = page.locator('.draft-saved-original > summary');
  await expect(originalDiarySummary).toHaveText('日記の全文を読む');
  await originalDiarySummary.click();
  await expect(page.locator('.draft-saved-original .diary')).toHaveText(body);
  await page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await page.getByRole('tab', { name: 'リスト' }).click();
  await expect(
    page.getByRole('tabpanel', { name: 'リスト' }).locator('.entry-history-summary'),
  ).toHaveText(summary);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
