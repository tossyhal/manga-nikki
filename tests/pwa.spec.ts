import { expect, test } from '@playwright/test';
import { draftEntryDetailFixture, mockClientConfigFixture } from './fixtures/client-config';
import { clickEntryMenuItem } from './fixtures/ui';

const entryId = draftEntryDetailFixture.id;

async function makeUpdateAvailable(page: import('@playwright/test').Page) {
  await page.addInitScript(() => Reflect.set(window, '__pwaUpdateCalls', 0));
  await page.route('**/@vite-plugin-pwa/virtual:pwa-register/react*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const updatedSource = source
      .replace('const needRefresh = useState(false);', 'const needRefresh = useState(true);')
      .replace(
        'const updateServiceWorker = (_reloadPage) => {\n  };',
        'const updateServiceWorker = (_reloadPage) => { Reflect.set(window, "__pwaUpdateCalls", Reflect.get(window, "__pwaUpdateCalls") + 1); };',
      );

    expect(updatedSource).not.toBe(source);
    await route.fulfill({ response, body: updatedSource });
  });
}

test('更新通知だけでは再読み込みせず、明示操作で更新を要求する', async ({ page }) => {
  await makeUpdateAvailable(page);
  const navigations: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  await page.goto('/');
  await expect(page.getByText('新しいバージョンを利用できます。')).toBeVisible();
  const initialNavigationCount = navigations.length;
  await page.waitForTimeout(250);
  expect(navigations).toHaveLength(initialNavigationCount);
  expect(await page.evaluate(() => Reflect.get(window, '__pwaUpdateCalls'))).toBe(0);

  await page.getByRole('button', { name: '更新する' }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__pwaUpdateCalls'))).toBe(1);
  expect(navigations).toHaveLength(initialNavigationCount);
});

test('未保存の日記入力中は更新を保留し、保存後も明示操作まで本文を保つ', async ({ page }) => {
  await makeUpdateAvailable(page);
  await page.goto('/new');
  const diary = page.getByLabel('日記', { exact: true });
  await diary.fill('更新中も残す架空の日記');

  const updateButton = page.getByRole('button', { name: '更新する' });
  await expect(updateButton).toBeDisabled();
  await expect(diary).toHaveValue('更新中も残す架空の日記');
  expect(await page.evaluate(() => Reflect.get(window, '__pwaUpdateCalls'))).toBe(0);

  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(updateButton).toBeEnabled();
  await updateButton.click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__pwaUpdateCalls'))).toBe(1);
});

test('詳細の日記編集が未保存の間は手動PWA更新を保留する', async ({ page }) => {
  await makeUpdateAvailable(page);
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );

  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('日記', { exact: true });
  await diary.fill('更新中に保護する詳細編集の架空日記');

  await expect(page.getByRole('button', { name: '更新する' })).toBeDisabled();
  await expect(diary).toHaveValue('更新中に保護する詳細編集の架空日記');
  expect(await page.evaluate(() => Reflect.get(window, '__pwaUpdateCalls'))).toBe(0);
});

test('オフライン時に架空サンプルと利用制限を案内する', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日の記録' })).toBeVisible();
  await page.context().setOffline(true);

  const offlineNotice = page.getByRole('status').filter({ hasText: 'オフラインです。' });
  await expect(offlineNotice).toContainText('オフラインです。');
  await expect(offlineNotice).toContainText('日記本文や生成画像はオフライン用に保存しません。');
  await expect(page.getByRole('heading', { name: '今日の記録' })).toBeVisible();
});
