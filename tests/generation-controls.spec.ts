import { expect, test } from '@playwright/test';
import { generationFixtures } from '../src/shared/fixtures';
import type { EntryDetail, Generation } from '../src/shared/schemas';
import { draftEntryDetailFixture, liveClientConfigFixture } from './fixtures/client-config';

const entryId = draftEntryDetailFixture.id;
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

declare global {
  interface Window {
    __e2eTurnstileEvents?: Array<{ action: string | null; token: string }>;
  }
}

async function installTurnstileFake(
  page: import('@playwright/test').Page,
  { failFirstGeneration = false }: { failFirstGeneration?: boolean } = {},
) {
  await page.addInitScript(
    ({ failFirstGeneration: failOnFirstGeneration }) => {
      const widgets = new Map<
        string,
        {
          action?: string;
          callback: (token: string) => void;
          'error-callback': () => void;
        }
      >();
      let nextId = 0;
      let generationAttempts = 0;
      window.__e2eTurnstileEvents = [];
      window.turnstile = {
        render(_container, options) {
          const id = String(++nextId);
          widgets.set(id, options);
          return id;
        },
        execute(id) {
          const widget = widgets.get(id);
          if (!widget) return;
          const action = widget.action ?? null;
          if (action === 'generate' && failOnFirstGeneration && generationAttempts === 0) {
            generationAttempts++;
            window.setTimeout(() => widget['error-callback'](), 0);
            return;
          }
          if (action === 'generate') generationAttempts++;
          const token =
            action === 'generate'
              ? `generation-token-e2e-${generationAttempts}`
              : 'registration-token-e2e';
          window.__e2eTurnstileEvents?.push({ action, token });
          window.setTimeout(() => widget.callback(token), 0);
        },
        remove(id) {
          widgets.delete(id);
        },
      };
    },
    { failFirstGeneration },
  );
}

async function installLiveSession(page: import('@playwright/test').Page) {
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
}

function availableQuota(activeGenerationId: string | null = null) {
  return {
    remainingToday: 3,
    activeGenerationId,
    resetAt: '2026-01-02T00:00:00Z',
    generationAvailable: true,
  };
}

test('新規保存後に生成用CAPTCHAを取り直し、固定サンプルとして受付する', async ({ page }) => {
  await installTurnstileFake(page);
  const order: string[] = [];
  const signupTokens: string[] = [];
  const generationRequests: Array<{ token: string; key: string; body: unknown }> = [];
  let quotaRequests = 0;
  let generation: Generation | null = null;
  const entryDetail: EntryDetail = { ...draftEntryDetailFixture };
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => {
    quotaRequests++;
    return route.fulfill({ json: availableQuota() });
  });
  await page.route('**/api/v1/entries', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    order.push('entry-saved');
    return route.fulfill({ json: { ...entryDetail, latestGeneration: undefined } });
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: entryDetail }));
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    const body = route.request().postDataJSON() as { captchaToken: string };
    generationRequests.push({
      token: body.captchaToken,
      key: route.request().headers()['idempotency-key'] ?? '',
      body,
    });
    order.push('generation-requested');
    generation = generationFixtures(entryId, generationId).succeeded;
    return route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'succeeded',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation ?? generationFixtures(entryId, generationId).queued }),
  );
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' },
    }),
  );
  await page.route('https://manga-nikki-e2e.supabase.co/**', async (route) => {
    const body = route.request().postDataJSON() as {
      gotrue_meta_security?: { captcha_token?: string };
    };
    const token =
      body.gotrue_meta_security?.captcha_token ??
      (body as { captchaToken?: string }).captchaToken ??
      '';
    signupTokens.push(token);
    order.push('anonymous-session-created');
    const now = Math.floor(Date.now() / 1000);
    return route.fulfill({
      status: 200,
      json: {
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
      },
    });
  });

  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill('入力内容を反映しない架空の日記');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '保存して固定サンプルを見る' }).click();
  await expect(page.getByRole('heading', { name: 'いつもの一日' })).toBeVisible();
  await expect(
    page.getByText('固定サンプルです。入力内容は反映されず、AIにも送信されません。').first(),
  ).toBeVisible();

  const captchaEvents = await page.evaluate(() => window.__e2eTurnstileEvents ?? []);
  expect(captchaEvents).toEqual([
    { action: null, token: 'registration-token-e2e' },
    { action: 'generate', token: 'generation-token-e2e-1' },
  ]);
  expect(signupTokens).toEqual(['registration-token-e2e']);
  expect(order.indexOf('anonymous-session-created')).toBeLessThan(order.indexOf('entry-saved'));
  expect(order.indexOf('entry-saved')).toBeLessThan(order.indexOf('generation-requested'));
  expect(generationRequests).toHaveLength(1);
  expect(generationRequests[0]).toMatchObject({
    token: 'generation-token-e2e-1',
    body: { expectedRevision: 1, captchaToken: 'generation-token-e2e-1' },
  });
  expect(generationRequests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(quotaRequests).toBeGreaterThan(0);
});

test('通信断の受付確認は同じキーで再送し、unknownを自動再送しない', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  const firstGeneration = generationFixtures(entryId, generationId).unknown;
  const generationRequests: Array<{ key: string; captchaToken: string }> = [];
  let generationReads = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({ json: availableQuota(generationReads > 0 ? generationId : null) }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, async (route) => {
    const body = route.request().postDataJSON() as { captchaToken: string };
    generationRequests.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      captchaToken: body.captchaToken,
    });
    if (generationRequests.length === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'unknown',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) => {
    generationReads++;
    return route.fulfill({ json: firstGeneration });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '漫画を作成する' }).click();
  await expect(page.getByRole('alert')).toContainText('通信に失敗しました');
  await page.reload();
  await expect(page.getByRole('button', { name: '受付結果を確認' })).toBeVisible();
  await page.getByRole('button', { name: '受付結果を確認' }).click();
  await expect(page.getByRole('alert')).toContainText('自動では再生成せず');
  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[0]?.key).toBe(generationRequests[1]?.key);
  expect(generationRequests[0]?.captchaToken).toBe('generation-token-e2e-1');
  expect(generationRequests[1]?.captchaToken).toBe('');
  await expect.poll(() => generationReads).toBe(2);

  const readsAfterUnknown = generationReads;
  await page.waitForTimeout(5200);
  expect(generationRequests).toHaveLength(2);
  expect(generationReads).toBe(readsAfterUnknown);
  await expect(page.getByRole('button', { name: '新しい確認を取得' })).toHaveCount(0);
});

test('生成用CAPTCHAが失敗しても保存済みの日記を残して取り直せる', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page, { failFirstGeneration: true });
  const generation = generationFixtures(entryId, generationId).succeeded;
  let generationRequests = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    return route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'succeeded',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' },
    }),
  );
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '漫画を作成する' }).click();
  await expect(page.getByRole('alert')).toContainText('保存済みの日記はそのままです');
  await expect(page.getByText(draftEntryDetailFixture.body, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新しい確認を取得' }).click();
  await expect(page.getByRole('heading', { name: 'いつもの一日' })).toBeVisible();
  expect(generationRequests).toBe(1);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([
    { action: 'generate', token: 'generation-token-e2e-2' },
  ]);
});

test('quota上限では受付せず、停止理由と更新時刻を表示する', async ({ page }) => {
  await installLiveSession(page);
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 0,
        activeGenerationId: null,
        resetAt: '2026-01-02T00:00:00Z',
        generationAvailable: false,
      },
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  let generationRequests = 0;
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    return route.abort();
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByText(/本日の生成上限に達しています。利用枠は/)).toBeVisible();
  await expect(page.getByRole('button', { name: '本日の生成上限に達しています' })).toBeDisabled();
  expect(generationRequests).toBe(0);
});

test('生成停止中は残り枠があっても受付しない', async ({ page }) => {
  await installLiveSession(page);
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        ...availableQuota(),
        generationAvailable: false,
      },
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  let generationRequests = 0;
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    return route.abort();
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await expect(
    page.getByText('現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '漫画の受付を停止しています' })).toBeDisabled();
  expect(generationRequests).toBe(0);
});

test('生成APIの認証切れでは別の匿名登録を行わず、記録を残す', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  let generationRequests = 0;
  let externalAuthRequests = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    return route.fulfill({
      status: 401,
      json: {
        error: {
          code: 'AUTH_REQUIRED',
          message: 'SECRET_ENV_NAME should never be shown',
          requestId: 'auth-expired-request',
          retryable: false,
        },
      },
    });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', async (route) => {
    externalAuthRequests++;
    await route.abort();
  });

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '漫画を作成する' }).click();
  await expect(page.getByRole('alert')).toContainText('匿名セッションを確認できません');
  await expect(page.getByText('SECRET_ENV_NAME')).toHaveCount(0);
  await expect(page.getByText(draftEntryDetailFixture.body, { exact: true })).toBeVisible();
  expect(generationRequests).toBe(1);
  expect(externalAuthRequests).toBe(0);
});

test('生成処理中の連打と離脱を確認し、遅れた応答では画面遷移を変えない', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  let releaseRequest!: () => void;
  let notifyRequest!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let generationRequests = 0;
  let generationReads = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, async (route) => {
    generationRequests++;
    notifyRequest();
    await requestGate;
    await route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'queued',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) => {
    generationReads++;
    return route.fulfill({ json: generationFixtures(entryId, generationId).queued });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '漫画を作成する' }).click();
  await requestReceived;
  await expect(page.getByRole('button', { name: '受付しています…' })).toBeDisabled();
  expect(generationRequests).toBe(1);

  const dialogPromise = page.waitForEvent('dialog');
  const navigation = page.getByRole('link', { name: '← 記録の一覧' }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('処理中');
  await dialog.accept();
  await navigation;
  await expect(page).toHaveURL(/\/library$/);

  releaseRequest();
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/library$/);
  expect(generationReads).toBe(0);
  expect(generationRequests).toBe(1);
});
