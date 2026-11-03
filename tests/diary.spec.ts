import { expect, test } from '@playwright/test';
test('入力からモック漫画と履歴を再読込して削除できる', async ({ page }) => {
  const externalAuthRequests: string[] = [];
  page.on('request', (request) => {
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /今日のことを/ })).toBeVisible();
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  await page.getByLabel('日記', { exact: true }).fill('図書館で本を読んだ。');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '保存してモック漫画を見る' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByText('図書館で本を読んだ。', { exact: true }).last()).toBeVisible();
  await expect(
    page.getByText('固定サンプルです。入力した日記から生成した画像ではありません。'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '元の日記' })).toBeVisible();
  await page.getByRole('link', { name: '← 記録の一覧' }).click();
  await expect(page.getByRole('heading', { name: '保存した記録', exact: true })).toBeVisible();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true })).toBeVisible();
  await page.getByText('図書館で本を読んだ。', { exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '記録を削除' }).click();
  await expect(page.getByRole('heading', { name: '最初の一日を残しましょう。' })).toBeVisible();
  expect(externalAuthRequests).toEqual([]);
});
test('狭い画面で下書き保存とHTML風の文字を安全に表示できる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill('<script>window.injected=true</script>');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(
    page.getByText('<script>window.injected=true</script>', { exact: true }),
  ).toBeVisible();
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

test('設定を読み込めない画面では通信確認と再読み込みを案内する', async ({ page }) => {
  const message = '現在、読み込めません。通信を確認して再読み込みしてください。';
  await page.route('**/api/v1/config', (route) => route.abort('failed'));

  for (const path of ['/new', '/library', '/entries/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
    await page.goto(path);
    await expect(page.locator('.notice')).toHaveText(message);
    await expect(page.getByRole('alert')).toHaveText(message);
  }
});

test('サンプルを閲覧するだけでは匿名登録やCAPTCHAを呼び出さない', async ({ page }) => {
  const externalAuthRequests: string[] = [];
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
    if (/supabase\.co|challenges\.cloudflare\.com/.test(request.url()))
      externalAuthRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByText('サンプルの一日')).toBeVisible();
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  await expect(page.getByText('保存機能は利用できません。')).toBeVisible();
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
  await expect(page.locator('.notice')).toHaveText('匿名利用 / 保存前に利用条件をご確認ください');
  await expect(page.getByText('現在、漫画生成は利用できません。', { exact: true })).toBeVisible();
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
