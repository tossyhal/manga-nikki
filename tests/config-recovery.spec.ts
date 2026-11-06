import { expect, test } from '@playwright/test';
import { mockClientConfigFixture } from './fixtures/client-config';

const quotaFixture = {
  remainingToday: 3,
  activeGenerationId: null,
  resetAt: '2099-01-01T00:00:00.000Z',
  generationAvailable: true,
};

async function routeQuota(
  page: import('@playwright/test').Page,
  generationAvailable: () => boolean = () => quotaFixture.generationAvailable,
) {
  await page.route('**/api/v1/me/quota', (route) => {
    const available = generationAvailable();
    return route.fulfill({
      json: { ...quotaFixture, generationAvailable: available, remainingToday: available ? 3 : 0 },
    });
  });
}

async function resumeByVisibility(page: import('@playwright/test').Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test('復帰時に停止解除を読み直し、入力を保ったまま生成CTAを戻す', async ({ page }) => {
  let configRequests = 0;
  let generationAvailable = false;
  const writes: string[] = [];
  await page.route('**/api/v1/config', (route) => {
    configRequests++;
    generationAvailable = configRequests > 1;
    return route.fulfill({ json: { ...mockClientConfigFixture, generationAvailable } });
  });
  await routeQuota(page, () => generationAvailable);
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET')
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await page.goto('/new');
  const body = page.getByLabel('今日はどんな日だった？', { exact: true });
  await expect(body).toBeVisible();
  await expect(page.getByRole('button', { name: '下書きとして保存' })).toBeEnabled();
  await body.fill('設定の再取得中も残す架空の日記。');
  expect(configRequests).toBe(1);

  await resumeByVisibility(page);
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  await expect(body).toHaveValue('設定の再取得中も残す架空の日記。');
  expect(configRequests).toBe(2);
  expect(writes).toEqual([]);
});

test('復帰時に生成停止を読み直して生成CTAを止める', async ({ page }) => {
  let configRequests = 0;
  await page.route('**/api/v1/config', (route) => {
    configRequests++;
    return route.fulfill({
      json: { ...mockClientConfigFixture, generationAvailable: configRequests === 1 },
    });
  });
  await routeQuota(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET')
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await page.goto('/new');
  const body = page.getByLabel('今日はどんな日だった？', { exact: true });
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  await body.fill('停止を確認する架空の日記。');
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );

  await expect(page.getByRole('button', { name: '下書きとして保存' })).toBeEnabled();
  await expect(body).toHaveValue('停止を確認する架空の日記。');
  expect(configRequests).toBe(2);
  expect(writes).toEqual([]);
});

test('復帰後のconfig再取得に失敗しても入力と画面を残す', async ({ page }) => {
  let configRequests = 0;
  await page.route('**/api/v1/config', async (route) => {
    configRequests++;
    if (configRequests === 1) return route.fulfill({ json: mockClientConfigFixture });
    return route.abort('failed');
  });
  await routeQuota(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET')
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await page.goto('/new');
  const body = page.getByLabel('今日はどんな日だった？', { exact: true });
  await expect(body).toBeVisible();
  await body.fill('失敗後も残す架空の日記。');
  await resumeByVisibility(page);

  await expect(body).toHaveValue('失敗後も残す架空の日記。');
  await expect(page.locator('.startup-screen')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '読み込めませんでした' })).toHaveCount(0);
  expect(configRequests).toBe(2);
  expect(writes).toEqual([]);
});

test('初回config取得に失敗しても復帰イベントで再試行する', async ({ page }) => {
  let configRequests = 0;
  await page.route('**/api/v1/config', async (route) => {
    configRequests++;
    if (configRequests === 1) return route.abort('failed');
    return route.fulfill({ json: mockClientConfigFixture });
  });
  await routeQuota(page);

  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '読み込めませんでした' })).toBeVisible();
  await resumeByVisibility(page);

  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
  await expect(page.locator('.startup-screen')).toHaveCount(0);
  expect(configRequests).toBe(2);
});

test('復帰イベントが再取得中に続いてもdedupeし、間引き後に最後のconfigを反映する', async ({
  page,
}) => {
  let releaseFirstRefresh!: () => void;
  const firstRefreshGate = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve;
  });
  let configRequests = 0;
  await page.route('**/api/v1/config', async (route) => {
    configRequests++;
    if (configRequests === 2) {
      await firstRefreshGate;
      return route.fulfill({ json: { ...mockClientConfigFixture, generationAvailable: true } });
    }
    return route.fulfill({
      json: { ...mockClientConfigFixture, generationAvailable: configRequests < 3 },
    });
  });
  await routeQuota(page);

  await page.goto('/new');
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  await resumeByVisibility(page);
  await expect.poll(() => configRequests).toBe(2);
  await resumeByVisibility(page);
  await resumeByVisibility(page);
  await resumeByVisibility(page);
  expect(configRequests).toBe(2);
  releaseFirstRefresh();
  await page.waitForTimeout(5_100);

  await expect(page.getByRole('button', { name: '下書きとして保存' })).toBeEnabled();
  expect(configRequests).toBe(3);
});
