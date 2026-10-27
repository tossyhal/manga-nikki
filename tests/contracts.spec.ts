import { expect, test, type Page } from '@playwright/test';
import { generationFixtures, pageComic, panelsComic } from '../src/shared/fixtures';
import type { EntryDetail, Generation } from '../src/shared/schemas';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixtures = generationFixtures(entryId, generationId);
function detail(generation: Generation): EntryDetail {
  return {
    id: entryId,
    diaryDate: '2026-01-01',
    body: '架空のテスト日記',
    revision: 1,
    latestGenerationId: generation.id,
    latestGeneration: generation,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
async function intercept(page: Page, getGeneration: () => Generation) {
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: detail(getGeneration()) }),
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
test('queuedからrunning、succeededへ進み、完了後はポーリングを止める', async ({ page }) => {
  await page.clock.install();
  let generation: Generation = fixtures.queued;
  let reads = 0;
  await intercept(page, () => {
    reads++;
    return generation;
  });
  await page.goto(`/entries/${entryId}`);
  await expect(page.getByText('生成待ちです。')).toBeVisible();
  generation = fixtures.running;
  await page.clock.runFor(5000);
  await expect(page.getByText('漫画を作成しています。')).toBeVisible();
  generation = fixtures.succeeded;
  await page.clock.runFor(5000);
  await expect(page.getByRole('heading', { name: pageComic.title })).toBeVisible();
  const completedReads = reads;
  await page.clock.runFor(15000);
  expect(reads).toBe(completedReads);
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
    await expect(page.getByRole('heading', { name: '元の日記' })).toBeVisible();
    await expect(page.locator('.comic')).toHaveCount(0);
    if (status === 'cancelled')
      await expect(page.getByText('生成は中止されました。')).toBeVisible();
    else await expect(page.getByRole('alert')).toContainText(fixtures[status].error.message);
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
  await expect(page.locator('.entries > li')).toHaveCount(20);
  await expect(page.getByText('架空の履歴1件目', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'もっと見る' }).click();
  await expect(page.locator('.entries > li')).toHaveCount(21);
  await expect(page.getByRole('button', { name: 'もっと見る' })).not.toBeVisible();
  await page.getByText('架空の履歴1件目', { exact: true }).click();
  await expect(page).toHaveURL(`/entries/${oldestId}`);
  await expect(page.getByRole('heading', { name: '元の日記' })).toBeVisible();
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
  await page.getByRole('link', { name: '← 記録の一覧' }).click();
  await expect(page.locator('.entries > li')).toHaveCount(1);
  await expect(page.getByText('保存だけ成功した架空の日記', { exact: true })).toBeVisible();
});
