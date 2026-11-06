import { expect, test } from '@playwright/test';
import { generationFixtures } from '../src/shared/fixtures';
import { jstToday, type Entry, type EntryDetail } from '../src/shared/schemas';
import { liveClientConfigFixture, mockClientConfigFixture } from './fixtures/client-config';
import {
  clickAppDialogButton,
  clickEntryMenuItem,
  expectDefaultLibraryLocation,
} from './fixtures/ui';
test('入力からモック漫画を再読込し、最近の記録から削除できる', async ({ page }) => {
  const externalAuthRequests: string[] = [];
  const entryPosts: Array<{ body: string; consentVersion: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/entries' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { body: string; consentVersion: string };
      entryPosts.push(payload);
    }
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill('図書館で本を読んだ。');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  expect(externalAuthRequests).toEqual([]);
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  await page.getByText('元の日記を読む', { exact: true }).click();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true }).last()).toBeVisible();
  await page.reload();
  await expect(page.getByText('元の日記を読む', { exact: true })).toBeVisible();
  await page.getByText('元の日記を読む', { exact: true }).click();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toBeVisible();
  const todaySection = page.getByRole('region', { name: '今日の記録' });
  await expect(todaySection.getByRole('heading', { name: '図書館で本を読んだ。' })).toBeVisible();
  await expect(todaySection.getByRole('link', { name: '漫画を読む' })).toBeVisible();
  const recentRecords = page.locator('.recent-records');
  await expect(recentRecords.getByRole('link', { name: /図書館で本を読んだ。/ })).toHaveCount(0);
  await todaySection.getByRole('link', { name: '漫画を読む' }).click();

  await clickEntryMenuItem(page, '日記を削除');
  const deleteDialogTitle = 'この日記を削除しますか？';
  await expect(page.getByRole('dialog', { name: deleteDialogTitle })).toBeVisible();
  await clickAppDialogButton(page, deleteDialogTitle, 'キャンセル');
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();

  await clickEntryMenuItem(page, '日記を削除');
  await clickAppDialogButton(page, deleteDialogTitle, '削除する');
  await expectDefaultLibraryLocation(page);
  await expect(page.getByText('図書館で本を読んだ。', { exact: true })).toHaveCount(0);
  expect(entryPosts).toMatchObject([{ body: '図書館で本を読んだ。', consentVersion: 'v1' }]);
  expect(externalAuthRequests).toEqual([]);
});
test('狭い画面で下書き保存とHTML風の文字を安全に表示できる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('<script>window.injected=true</script>');
  await expect(page.locator('#summary-preview')).toHaveText(
    '見出し：<script>window.injected=true</script>',
  );
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(
    page.getByRole('heading', { name: '日記を保存しました', exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.locator('.detail-toolbar h1')).toHaveText(
    '<script>window.injected=true</script>',
  );
  await expect(page.getByRole('heading', { name: '下書きを保存しました' })).toHaveCount(0);
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  await page.reload();
  await expect(page.locator('.entry-draft-card .diary')).toHaveText(
    '<script>window.injected=true</script>',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'injected'))).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('初回設定取得中は起動画面を表示し利用不可と誤表示しない', async ({ page }) => {
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
  await expect(page.getByText('保存機能は利用できません。')).not.toBeVisible();
  release();
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
  await expect(startupScreen).toHaveCount(0);
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
    const stateCard = page.locator('.app-state-card[role="alert"]');
    if (path === '/') {
      await expect(stateCard.locator('p')).toHaveText(message);
      await expect(page.getByRole('heading', { name: '読み込めませんでした' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'サンプルを見る' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '最近の記録' })).toHaveCount(0);
      await page.getByRole('button', { name: 'サンプルを見る' }).click();
      await expect(page).toHaveURL(/\/\?sample=1$/);
      await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
      await expect(page.getByText('架空サンプル', { exact: true })).toBeVisible();
      await expect(
        page.getByText('朝はトーストを食べた。図書館で本を読んだ。帰り道で猫を見かけた。'),
      ).toBeVisible();
      await page.getByRole('button', { name: '戻る' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { name: '読み込めませんでした' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'サンプルを見る' })).toBeVisible();
    } else {
      await expect(stateCard.locator('p')).toHaveText(message);
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
  await expect(page.getByRole('heading', { level: 2, name: 'いつもの一日' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toHaveCount(0);
  await page.getByRole('button', { name: '漫画を読む' }).click();
  await expect(page).toHaveURL(/\/\?sample=1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  await expect(
    page.getByText('朝はトーストを食べた。図書館で本を読んだ。帰り道で猫を見かけた。'),
  ).toBeVisible();
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'サンプル' })).toBeVisible();
  await page.getByRole('button', { name: '漫画を読む' }).click();
  await expect(page).toHaveURL(/\/\?sample=1$/);
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/\?sample=1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  await page.getByRole('button', { name: '戻る' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  const sampleEntryState = page.locator('.app-state-card');
  await expect(
    sampleEntryState.getByRole('heading', { name: '日記を保存できません' }),
  ).toBeVisible();
  await expect(sampleEntryState.locator('p')).toHaveText(
    'この環境では個人の記録を保存できません。ホームから架空サンプルを確認できます。',
  );
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveCount(0);
  expect(personalEntryReads).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});

test('サンプルを2回開閉しても戻る操作1回で前の画面に戻る', async ({ page }) => {
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
  await page.goto('/library');
  await page.goto('/');
  await expect(page.getByRole('button', { name: '漫画を読む' })).toBeVisible();

  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '漫画を読む' }).click();
    await expect(page).toHaveURL(/\/\?sample=1$/);
    await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page).toHaveURL(/\/$/);
  }

  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
});

test('liveホームは未登録でも空状態を表示し、日記入力を開ける', async ({ page }) => {
  const personalApiRequests: string[] = [];
  const externalAuthRequests: string[] = [];
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: liveClientConfigFixture }));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith('/api/v1/entries') ||
      (request.method() === 'POST' && url.pathname.startsWith('/api/v1/generations'))
    ) {
      personalApiRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url())) {
      externalAuthRequests.push(request.url());
    }
  });

  await page.goto('/');
  const todayRegion = page.getByRole('region', { name: '今日の記録' });
  await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toHaveCount(0);
  await expect(page.getByText('今日はまだ記録がありません')).toBeVisible();
  await expect(page.locator('img[src="/cat-mascot.png"]')).toBeVisible();
  await expect(todayRegion.getByRole('link', { name: '日記を書く', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '漫画を読む' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await todayRegion.getByRole('link', { name: '日記を書く', exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeEnabled();
  await page.waitForLoadState('networkidle');

  expect(personalApiRequests).toEqual([]);
  expect(externalAuthRequests).toEqual([]);
});

test('liveホームは既存sessionの本人履歴と成功漫画を表示し、登録や生成を始めない', async ({
  page,
}) => {
  const today = jstToday();
  const yesterdayDate = new Date(`${today}T12:00:00.000Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const entryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const generationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const generation = { ...generationFixtures(entryId, generationId).succeeded, mock: false };
  const todayEntry: Entry = {
    id: entryId,
    diaryDate: today,
    body: '本人の今日の架空記録',
    revision: 1,
    latestGenerationId: generationId,
    createdAt: `${today}T12:00:00.000Z`,
    updatedAt: `${today}T12:00:00.000Z`,
  };
  const previousEntry: Entry = {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    diaryDate: yesterday,
    body: '本人の過去の架空記録',
    revision: 1,
    latestGenerationId: null,
    createdAt: `${yesterday}T12:00:00.000Z`,
    updatedAt: `${yesterday}T12:00:00.000Z`,
  };
  const detail: EntryDetail = {
    ...todayEntry,
    latestGeneration: generation,
  };
  const apiAuthorization: string[] = [];
  const personalApiRequests: string[] = [];
  const externalAuthRequests: string[] = [];
  let entryWrites = 0;
  let generationWrites = 0;
  let assetUrlReads = 0;

  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    localStorage.setItem(
      'sb-manga-nikki-e2e-auth-token',
      JSON.stringify({
        access_token: 'fixture-live-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: 'fixture-live-refresh-token',
        user: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          aud: 'authenticated',
          role: 'authenticated',
          app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
          user_metadata: {},
          created_at: new Date().toISOString(),
          is_anonymous: true,
        },
      }),
    );
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: liveClientConfigFixture }));
  await page.route('**/api/v1/entries**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    apiAuthorization.push(request.headers().authorization ?? '');
    if (request.method() === 'POST') {
      if (pathname === '/api/v1/entries') entryWrites++;
      if (pathname.endsWith('/generations')) generationWrites++;
      await route.fulfill({
        status: 409,
        json: { error: 'entry writes are not expected on Home' },
      });
      return;
    }
    if (pathname === '/api/v1/entries') {
      await route.fulfill({ json: { items: [todayEntry, previousEntry], nextCursor: null } });
      return;
    }
    if (pathname === `/api/v1/entries/${entryId}`) {
      await route.fulfill({ json: detail });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });
  await page.route('**/api/v1/generations/*', (route) => route.fulfill({ json: generation }));
  await page.route('**/api/v1/assets/*/url', async (route) => {
    assetUrlReads++;
    apiAuthorization.push(route.request().headers().authorization ?? '');
    await route.fulfill({
      json: {
        url: '/sample-comic.svg',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/') && url.pathname !== '/api/v1/config')
      personalApiRequests.push(`${request.method()} ${url.pathname}`);
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
  const todaySection = page.getByRole('region', { name: '今日の記録' });
  await expect(todaySection.getByText('本人の今日の架空記録')).toBeVisible();
  await expect(todaySection.getByRole('link', { name: '漫画を読む' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toBeVisible();
  const recentRecords = page.locator('.recent-records');
  await expect(recentRecords.getByRole('link', { name: /本人の過去の架空記録/ })).toBeVisible();
  await expect(recentRecords.getByText('本人の今日の架空記録')).toHaveCount(0);
  const previewLink = todaySection.getByRole('link', {
    name: 'いつもの一日の記録を読む',
    exact: true,
  });
  const preview = previewLink.locator('img.entry-thumbnail-image');
  await expect(previewLink).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('src', '/sample-comic.svg');
  await expect
    .poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect.poll(() => assetUrlReads).toBeGreaterThan(0);

  expect(apiAuthorization.length).toBeGreaterThan(0);
  expect(apiAuthorization.every((value) => value === 'Bearer fixture-live-access-token')).toBe(
    true,
  );
  expect(entryWrites).toBe(0);
  expect(generationWrites).toBe(0);
  expect(externalAuthRequests).toEqual([]);

  const readsBeforeOffline = personalApiRequests.length;
  await page.context().setOffline(true);
  await expect(page.getByRole('heading', { name: 'サンプル', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '漫画を読む' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の記録' })).toHaveCount(0);
  await expect(page.getByText('本人の今日の架空記録')).toHaveCount(0);
  await expect(page.getByText('本人の過去の架空記録')).toHaveCount(0);
  expect(personalApiRequests).toHaveLength(readsBeforeOffline);
  expect(externalAuthRequests).toEqual([]);
});

test('ライブの新規作成は入力だけでは登録やCAPTCHA、書き込みを始めない', async ({ page }) => {
  let entryPosts = 0;
  let generationPosts = 0;
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
  await page.route('**/api/v1/entries**', (route) => {
    if (route.request().method() === 'POST') {
      if (new URL(route.request().url()).pathname.endsWith('/generations')) generationPosts++;
      else entryPosts++;
    }
    return route.continue();
  });
  page.on('request', (request) => {
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });

  await page.goto('/new');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '匿名登録' })).toHaveCount(0);
  const body = '入力だけの架空の日記\n改行を保持する。';
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill(body);
  const dateTrigger = page.getByLabel('日付', { exact: true });
  await dateTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dateTrigger).toBeFocused();
  await expect(diary).toHaveValue(body);
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('region', { name: '匿名登録' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(entryPosts).toBe(0);
  expect(generationPosts).toBe(0);
  expect(externalAuthRequests).toEqual([]);
});

test('通信失敗時に入力と再送IDを維持する', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  let first = true;
  const ids: string[] = [];
  let generationPosts = 0;
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
  await page.route('**/api/v1/entries/*/generations', async (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    await route.fulfill({ status: 409, json: { error: 'generation is not expected' } });
  });
  await page.goto('/new');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill('通信後も残す架空の日記');
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持したまま再操作');
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(
    '通信後も残す架空の日記',
  );
  const errorAlert = page.getByRole('alert');
  await expect(errorAlert).toBeInViewport();
  const alertBottom = await errorAlert.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  const navigationTop = await page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(alertBottom).toBeLessThanOrEqual(navigationTop);
  await page.getByRole('button', { name: 'もう一度保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(
    page.getByRole('heading', { name: '日記を保存しました', exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(generationPosts).toBe(0);
});

test('オフライン時は保存せず、再接続後も本文を保持して自動生成しない', async ({ page }) => {
  const originalBody = '再接続まで画面に残す架空の日記';
  const offlineBody = `${originalBody} オフラインで追記`;
  let entryPosts = 0;
  let generationPosts = 0;
  const apiRequests: Array<{ method: string; path: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/'))
      apiRequests.push({ method: request.method(), path: url.pathname });
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: `${jstToday()}T15:00:00.000Z`,
        generationAvailable: true,
      },
    }),
  );
  await page.route('**/api/v1/entries**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    if (new URL(request.url()).pathname.endsWith('/generations')) generationPosts++;
    else entryPosts++;
    await route.fulfill({ status: 409, json: { error: 'writes are not expected in this test' } });
  });

  await page.goto('/new');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await expect(diary).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  await diary.fill(originalBody);
  const beforeOffline = apiRequests.length;
  await page.context().setOffline(true);
  await expect(page.getByRole('heading', { name: 'オフラインです' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await diary.fill(offlineBody);
  await expect(diary).toHaveValue(offlineBody);
  await expect(page.getByRole('button', { name: '下書き保存' })).toBeDisabled();
  await page.getByRole('button', { name: '接続を再確認する' }).click();
  expect(apiRequests.slice(beforeOffline)).toEqual([]);
  expect(entryPosts).toBe(0);
  expect(generationPosts).toBe(0);

  const beforeReconnect = apiRequests.length;
  await page.context().setOffline(false);
  await expect(page.getByRole('heading', { name: 'オフラインです' })).toHaveCount(0);
  await expect(diary).toHaveValue(offlineBody);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  const reconnectRequests = apiRequests.slice(beforeReconnect);
  expect(reconnectRequests.length).toBeGreaterThan(0);
  expect(
    reconnectRequests.every(({ method, path }) => method === 'GET' && path === '/api/v1/me/quota'),
  ).toBe(true);
  expect(entryPosts).toBe(0);
  expect(generationPosts).toBe(0);
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
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill(firstBody);
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
  await page.getByRole('tab', { name: 'リスト' }).click();
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  await expect(listPanel.locator('.entry-history-card')).toHaveCount(1);
  await expect(listPanel.locator('.entry-history-card')).toContainText(firstBody);
});
