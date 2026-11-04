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
  await page.route('**/api/v1/assets/*/url', (route) => {
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
    await expect(page.getByRole('heading', { name: comic.title })).toBeVisible();
    if (comic.visual.kind === 'page') {
      await page.getByText('4コマの内容を読む', { exact: true }).click();
    }
    await expect(page.getByText(comic.panels[0].caption, { exact: true })).toBeVisible();
    await expect(page.getByText('「波がきれい」')).toBeVisible();
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
  await expect(page.getByRole('heading', { name: comic.title })).toBeVisible();
  await expect(page.locator('.comic-panel-card')).toHaveCount(4);
  for (const panel of comic.panels) {
    await expect(page.getByText(panel.caption, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('「絵がなくても残る会話」', { exact: true })).toBeVisible();
  await expect.poll(() => requestedAssetIds.size).toBe(4);
});

test('埋め込み文字の漫画で画像取得に失敗したら脚本を一度だけ表示する', async ({ page }) => {
  const comic = structuredClone(pageComic);
  if (comic.visual.kind !== 'page') throw new Error('page comic fixture is required');
  comic.visual.textMode = 'embedded';
  comic.panels[0].caption = '代替表示でも一度だけ読める説明';
  comic.panels[0].dialogue = '一度だけ読み上げる会話';
  const generation = { ...fixtures.succeeded, comic };
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(generation) }),
  );
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route('**/api/v1/assets/*/url', (route) => route.abort('failed'));

  await page.goto(`/entries/${entryId}`);
  const fallback = page.locator('.comic-image-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback.getByText(comic.panels[0].caption, { exact: true })).toBeVisible();
  await expect(fallback.getByText('「一度だけ読み上げる会話」', { exact: true })).toBeVisible();
  await expect(page.locator('.comic-transcript ol.sr-only')).toHaveCount(0);
  await expect(page.getByText(comic.panels[0].caption, { exact: true })).toHaveCount(1);
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
  await expect(page.getByRole('heading', { name: '生成を受け付けました' })).toBeVisible();
  generation = fixtures.running;
  await page.clock.runFor(5000);
  await expect(page.getByRole('heading', { name: '4コマを描いています' })).toBeVisible();
  generation = fixtures.succeeded;
  await page.clock.runFor(5000);
  await expect(page.getByRole('heading', { name: pageComic.title })).toBeVisible();
  const completedReads = reads;
  await page.clock.runFor(15000);
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
    await expect(page.getByText('元の日記を読む', { exact: true })).toBeVisible();
    await page.getByText('元の日記を読む', { exact: true }).click();
    await expect(page.locator('.diary')).toHaveText('架空のテスト日記');
    await expect(page.locator('.comic')).toHaveCount(0);
    if (status === 'cancelled')
      await expect(page.getByText('生成は中止されました。')).toBeVisible();
    else if (status === 'unknown')
      await expect(page.getByRole('heading', { name: '生成結果を確認中' })).toBeVisible();
    else await expect(page.getByRole('alert')).toContainText('漫画を作成できませんでした。');
    if (status === 'unknown')
      await expect(page.locator('.generation-card')).toContainText('自動では再生成せず');
    const terminalReads = reads;
    await page.clock.runFor(15000);
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
    }
  }
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: '記録', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '一覧で見る' }).click();
  await expect(page.locator('.entry-history-card')).toHaveCount(20);
  await expect(page.getByText('架空の履歴1件目', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '続きを読み込む' }).click();
  await expect(page.locator('.entry-history-card')).toHaveCount(21);
  await expect(page.getByRole('button', { name: '続きを読み込む' })).not.toBeVisible();
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
  await page.getByLabel('日記', { exact: true }).fill('保存だけ成功した架空の日記');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持');
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(`/entries/${savedId}`);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await page.getByRole('button', { name: '一覧で見る' }).click();
  await expect(page.locator('.entry-history-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /保存だけ成功した架空の日記/ })).toBeVisible();
});

test('390px幅の履歴では200文字の日記を40文字の要約で表示する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const body = 'A'.repeat(200);
  const summary = `${'A'.repeat(39)}…`;
  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill(body);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await page.getByRole('button', { name: '一覧で見る' }).click();
  await expect(page.locator('.entry-history-summary')).toHaveText(summary);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
