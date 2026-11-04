import { expect, test } from '@playwright/test';
import { liveClientConfigFixture } from './fixtures/client-config';
import { clickAppDialogButton, clickEntryMenuItem } from './fixtures/ui';
test('入力からモック漫画を再読込し、最近の記録から削除できる', async ({ page }) => {
  const externalAuthRequests: string[] = [];
  page.on('request', (request) => {
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日の記録' })).toBeVisible();
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  await page.getByLabel('日記', { exact: true }).fill('図書館で本を読んだ。');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('heading', { name: '図書館で本を読んだ。' })).toBeVisible();
  await page.getByText('元の日記を読む', { exact: true }).click();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true }).last()).toBeVisible();
  await expect(
    page.getByText('固定サンプルです。入力内容は反映されず、AIにも送信されません。'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('元の日記を読む', { exact: true })).toBeVisible();
  await page.getByText('元の日記を読む', { exact: true }).click();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true }).last()).toBeVisible();
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toBeVisible();
  const recentRecords = page.locator('.recent-records');
  await expect(recentRecords.getByRole('link', { name: /図書館で本を読んだ。/ })).toBeVisible();
  await recentRecords.getByRole('link', { name: /図書館で本を読んだ。/ }).click();

  await clickEntryMenuItem(page, '日記を削除');
  const deleteDialogTitle = 'この日記を削除しますか？';
  await expect(page.getByRole('dialog', { name: deleteDialogTitle })).toBeVisible();
  await clickAppDialogButton(page, deleteDialogTitle, 'キャンセル');
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('heading', { name: '図書館で本を読んだ。' })).toBeVisible();

  await clickEntryMenuItem(page, '日記を削除');
  await clickAppDialogButton(page, deleteDialogTitle, '削除する');
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByText('図書館で本を読んだ。', { exact: true })).toHaveCount(0);
  expect(externalAuthRequests).toEqual([]);
});
test('狭い画面で下書き保存とHTML風の文字を安全に表示できる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill('<script>window.injected=true</script>');
  await expect(page.locator('#summary-preview')).toHaveText(
    '見出し：<script>window.injected=true</script>',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(
    page.getByRole('heading', { name: '<script>window.injected=true</script>' }),
  ).toBeVisible();
  await expect(page.locator('.diary')).toHaveText('<script>window.injected=true</script>');
  expect(await page.evaluate(() => Reflect.get(window, 'injected'))).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('設定取得中は利用不可と誤表示しない', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/config', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/new');
  await expect(page.getByText('読み込んでいます…')).toBeVisible();
  await expect(page.getByText('保存機能は利用できません。')).not.toBeVisible();
  release();
  await expect(page.getByLabel('日記', { exact: true })).toBeVisible();
});

test('設定取得失敗時は案内と公開サンプルだけを表示する', async ({ page }) => {
  const message = '現在、読み込めません。通信を確認して再読み込みしてください。';
  const personalApiRequests: string[] = [];
  const externalAuthRequests: string[] = [];
  await page.route('**/api/v1/config', (route) => route.abort('failed'));
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/entries')) personalApiRequests.push(request.url());
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });

  for (const path of ['/', '/new', '/library', '/entries/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
    await page.goto(path);
    await expect(page.locator('.notice')).toHaveText(message);
    if (path === '/') {
      await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '漫画を読む' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '最近の記録' })).toHaveCount(0);
      await page.getByRole('button', { name: '漫画を読む' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
      await expect(
        page.getByText('朝はトーストを食べた。図書館で本を読んだ。帰り道で猫を見かけた。'),
      ).toBeVisible();
      await page.getByRole('button', { name: '戻る' }).click();
    } else {
      await expect(page.locator('#main').getByRole('alert')).toHaveText(message);
    }
  }
  expect(personalApiRequests).toEqual([]);
  expect(externalAuthRequests).toEqual([]);
});

test('サンプルを閲覧するだけでは匿名登録やCAPTCHAを呼び出さない', async ({ page }) => {
  const externalAuthRequests: string[] = [];
  let personalEntryReads = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({
      json: {
        dataMode: 'sample',
        generationAvailable: false,
        consentVersion: 'v1',
        retentionDays: 30,
      },
    }),
  );
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/v1/entries?')) {
      personalEntryReads += 1;
    }
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'いつもの一日' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toHaveCount(0);
  await page.getByRole('button', { name: '漫画を読む' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  await expect(
    page.getByText('朝はトーストを食べた。図書館で本を読んだ。帰り道で猫を見かけた。'),
  ).toBeVisible();
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page.getByRole('heading', { name: 'サンプル' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  await expect(page.getByText('保存機能は利用できません。')).toBeVisible();
  expect(personalEntryReads).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});

test('liveホームは履歴取得と匿名登録を始めない', async ({ page }) => {
  let personalEntryReads = 0;
  const externalAuthRequests: string[] = [];
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: liveClientConfigFixture }));
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/v1/entries?')) {
      personalEntryReads += 1;
    }
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url())) {
      externalAuthRequests.push(request.url());
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '漫画を読む' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');

  expect(personalEntryReads).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});

test('同意がないライブ保存では登録や登録用CAPTCHAを開始しない', async ({ page }) => {
  let entryPosts = 0;
  const externalAuthRequests: string[] = [];
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({
      json: {
        dataMode: 'live',
        generationAvailable: false,
        consentVersion: 'v1',
        retentionDays: 30,
      },
    }),
  );
  await page.route('**/api/v1/entries', (route) => {
    if (route.request().method() === 'POST') entryPosts++;
    return route.continue();
  });
  page.on('request', (request) => {
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });

  await page.goto('/new');
  await expect(page.locator('.policy-note')).toContainText('匿名セッションはこのブラウザに保存');
  await expect(page.locator('.policy-note')).toContainText(
    '保存後30日を過ぎると閲覧できなくなります',
  );
  await expect(page.locator('.policy-note')).toContainText('現在、漫画生成は利用できません。');
  await page.getByLabel('日記', { exact: true }).fill('同意前の架空の日記');
  await page.getByRole('button', { name: '下書き保存' }).click();

  await expect(page.getByRole('alert')).toContainText('保存と匿名利用の条件を確認してください');
  expect(entryPosts).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});

test('通信失敗時に入力と再送IDを維持する', async ({ page }) => {
  let first = true;
  const ids: string[] = [];
  await page.route('**/api/v1/entries', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    ids.push(route.request().postDataJSON().createRequestId);
    if (first) {
      first = false;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill('通信後も残す架空の日記');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持したまま再操作');
  await expect(page.getByLabel('日記', { exact: true })).toHaveValue('通信後も残す架空の日記');
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test('別の日記の通信失敗後に元の日記を再送しても重複作成しない', async ({ page }) => {
  const firstBody = 'Aの日記';
  const secondBody = 'Bの日記';
  const requestIds: string[] = [];
  let savedId = '';
  await page.route('**/api/v1/entries', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const payload = route.request().postDataJSON();
    requestIds.push(payload.createRequestId);
    if (payload.body === secondBody) return route.abort('failed');
    if (!savedId) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      savedId = (await response.json()).id;
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.goto('/new');
  const diary = page.getByLabel('日記', { exact: true });
  await diary.fill(firstBody);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持');
  await diary.fill(secondBody);
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持');
  await diary.fill(firstBody);
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(`/entries/${savedId}`);
  expect(requestIds).toHaveLength(3);
  expect(requestIds[0]).toBe(requestIds[2]);
  expect(requestIds[0]).not.toBe(requestIds[1]);
  await page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await page.getByRole('button', { name: '一覧で見る' }).click();
  await expect(page.locator('.entry-history-card')).toHaveCount(1);
  await expect(page.locator('.entry-history-card')).toContainText(firstBody);
});
