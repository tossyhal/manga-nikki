import { expect, test } from '@playwright/test';
test('入力からモック漫画と履歴を再読込して削除できる', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /今日のことを/ })).toBeVisible();
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  await page.getByLabel('日記', { exact: true }).fill('図書館で本を読んだ。');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '保存してモック漫画を見る' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('heading', { name: '図書館で本を読んだ。' })).toBeVisible();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true }).last()).toBeVisible();
  await expect(
    page.getByText('固定サンプルです。入力した日記から生成した画像ではありません。'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '元の日記' })).toBeVisible();
  await page
    .getByRole('link', { name: /漫画日記/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: '過去の記録' })).toBeVisible();
  await expect(page.getByRole('link', { name: /図書館で本を読んだ。/ }).first()).toBeVisible();
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page.getByRole('heading', { name: '保存した記録', exact: true })).toBeVisible();
  await expect(page.getByText('図書館で本を読んだ。', { exact: true })).toBeVisible();
  await page.getByText('図書館で本を読んだ。', { exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '記録を削除' }).click();
  await expect(page.getByRole('heading', { name: '最初の一日を残しましょう。' })).toBeVisible();
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
  await page.getByRole('link', { name: '← 記録の一覧' }).click();
  await expect(page.locator('.entries > li')).toHaveCount(1);
  await expect(page.locator('.entries')).toContainText(firstBody);
});
