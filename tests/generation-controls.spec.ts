import { expect, test } from '@playwright/test';
import { generationFixtures } from '../src/shared/fixtures';
import { jstToday, type Entry, type EntryDetail, type Generation } from '../src/shared/schemas';
import {
  draftEntryDetailFixture,
  liveClientConfigFixture,
  mockClientConfigFixture,
} from './fixtures/client-config';
import {
  clickAppDialogButton,
  clickEntryMenuItem,
  expectDefaultLibraryLocation,
  openEntryMenu,
} from './fixtures/ui';

const entryId = draftEntryDetailFixture.id;
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

declare global {
  interface Window {
    __e2eTurnstileEvents?: Array<{ action: string | null; token: string }>;
    __releaseE2eGenerationCaptcha?: () => void;
  }
}

async function installTurnstileFake(
  page: import('@playwright/test').Page,
  {
    failFirstGeneration = false,
    delayFirstGenerationCallback,
  }: {
    failFirstGeneration?: boolean;
    delayFirstGenerationCallback?: 'token' | 'error';
  } = {},
) {
  await page.addInitScript(
    ({
      failFirstGeneration: failOnFirstGeneration,
      delayFirstGenerationCallback: delayedCallback,
    }) => {
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
          const deliverToken = () => {
            window.__e2eTurnstileEvents?.push({ action, token });
            widget.callback(token);
          };
          if (action === 'generate' && generationAttempts === 1 && delayedCallback) {
            window.__releaseE2eGenerationCaptcha =
              delayedCallback === 'token' ? deliverToken : () => widget['error-callback']();
            return;
          }
          window.setTimeout(deliverToken, 0);
        },
        remove(id) {
          widgets.delete(id);
        },
      };
    },
    { failFirstGeneration, delayFirstGenerationCallback },
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
  const supabaseRequests: string[] = [];
  const entryPosts: Array<{ body: string; consentVersion: string }> = [];
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
    entryPosts.push(route.request().postDataJSON() as { body: string; consentVersion: string });
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
    supabaseRequests.push(route.request().url());
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
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'manga-nikki-e2e.supabase.co') {
      supabaseRequests.push(request.url());
    }
  });

  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('入力内容を反映しない架空の日記');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '匿名登録' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
  expect(entryPosts).toEqual([]);
  expect(signupTokens).toEqual([]);
  expect(supabaseRequests).toEqual([]);
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();

  const captchaEvents = await page.evaluate(() => window.__e2eTurnstileEvents ?? []);
  expect(captchaEvents).toEqual([
    { action: null, token: 'registration-token-e2e' },
    { action: 'generate', token: 'generation-token-e2e-1' },
  ]);
  expect(signupTokens).toEqual(['registration-token-e2e']);
  expect(supabaseRequests.length).toBeGreaterThan(0);
  expect(entryPosts).toMatchObject([
    { body: '入力内容を反映しない架空の日記', consentVersion: 'v1' },
  ]);
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

for (const failure of [
  {
    status: 429,
    code: 'USER_LIMIT_REACHED',
    retryable: false,
    message: '本日の生成上限に達しています。保存済みの記録は引き続き見られます。',
  },
  {
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: true,
    message: '一時的に利用できません。時間をおいて再操作してください。',
  },
]) {
  test(`新規日記保存後の生成${failure.status}でも保存済み記録へ移動できる`, async ({ page }) => {
    const body = `生成${failure.status}後も保存を保持する架空の日記`;
    const savedEntry: Entry = {
      id: entryId,
      diaryDate: jstToday(),
      body,
      revision: 1,
      latestGenerationId: null,
      createdAt: `${jstToday()}T12:00:00.000Z`,
      updatedAt: `${jstToday()}T12:00:00.000Z`,
    };
    let entryPosts = 0;
    let generationPosts = 0;
    await page.route('**/api/v1/config', (route) =>
      route.fulfill({ json: mockClientConfigFixture }),
    );
    await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
    await page.route('**/api/v1/entries', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      entryPosts++;
      return route.fulfill({ status: 201, json: savedEntry });
    });
    await page.route(`**/api/v1/entries/${entryId}`, (route) =>
      route.fulfill({ json: { ...savedEntry, latestGeneration: null } }),
    );
    await page.route(`**/api/v1/entries/${entryId}/generations`, async (route) => {
      generationPosts++;
      await route.fulfill({
        status: failure.status,
        json: {
          error: {
            code: failure.code,
            message: 'fixture backend detail is not shown',
            requestId: `generation-${failure.status}-request`,
            retryable: failure.retryable,
          },
        },
      });
    });

    await page.goto('/new');
    await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(body);
    await page.getByRole('button', { name: '4コマにする' }).click();

    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole('heading', { name: '日記を保存しました' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(failure.message);
    await expect(page.getByRole('link', { name: '保存した記録を見る' })).toHaveAttribute(
      'href',
      `/entries/${entryId}`,
    );
    expect(entryPosts).toBe(1);
    expect(generationPosts).toBe(1);

    await page.getByRole('link', { name: '保存した記録を見る' }).click();
    await expect(page).toHaveURL(`/entries/${entryId}`);
    await expect(page.locator('.entry-draft-card .diary')).toHaveText(body);
  });
}

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
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page.getByRole('alert')).toContainText('通信に失敗しました');
  await page.reload();
  await expect(page.getByRole('button', { name: '受付結果を確認' })).toBeVisible();
  await page.getByRole('button', { name: '受付結果を確認' }).click();
  await expect(page.getByRole('heading', { name: '生成結果を確認中' })).toBeVisible();
  await expect(page.locator('.generation-card')).toContainText('自動では再生成せず');
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
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page.getByRole('alert')).toContainText('保存済みの日記はそのままです');
  await expect(page.locator('.diary')).toHaveText(draftEntryDetailFixture.body);
  await page.getByRole('button', { name: '新しい確認を取得' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
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

test('利用枠確認の失敗は再確認で復帰し、自動生成を始めない', async ({ page }) => {
  await installLiveSession(page);
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  let quotaRequests = 0;
  let allowQuotaSuccess = false;
  await page.route('**/api/v1/me/quota', (route) => {
    quotaRequests++;
    if (!allowQuotaSuccess) {
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'backend details are not displayed',
            requestId: 'quota-unavailable-request',
            retryable: true,
          },
        },
      });
    }
    return route.fulfill({ json: availableQuota() });
  });
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
    page.getByText(
      '利用枠を確認できないため、漫画の受付を停止しています。日記の閲覧と保存は続けられます。',
    ),
  ).toBeVisible();
  const retryQuota = page.getByRole('button', { name: '利用枠を再確認', exact: true });
  await expect(retryQuota).toBeEnabled();
  const failedReads = quotaRequests;
  expect(failedReads).toBeGreaterThan(0);
  expect(generationRequests).toBe(0);

  allowQuotaSuccess = true;
  await retryQuota.click();
  await expect(page.getByRole('region', { name: '本日の漫画生成枠' })).toContainText(
    '本日の残り生成枠は3回です。',
  );
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  expect(quotaRequests).toBeGreaterThan(failedReads);
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
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page.getByRole('alert')).toContainText('匿名セッションを確認できません');
  await expect(page.getByText('SECRET_ENV_NAME')).toHaveCount(0);
  await expect(page.locator('.diary')).toHaveText(draftEntryDetailFixture.body);
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
  await page.getByRole('button', { name: '4コマにする' }).click();
  await requestReceived;
  await expect(page.getByRole('button', { name: '受付しています…' })).toBeDisabled();
  expect(generationRequests).toBe(1);

  const navigation = page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  await clickAppDialogButton(page, '処理中です', '移動する');
  await navigation;
  await expectDefaultLibraryLocation(page);

  releaseRequest();
  await page.waitForTimeout(200);
  await expectDefaultLibraryLocation(page);
  expect(generationReads).toBe(0);
  expect(generationRequests).toBe(1);
});

for (const delayedCallback of ['token', 'error'] as const) {
  test(`日記の保存中に届いた古い生成CAPTCHAの${delayedCallback} callbackを無視する`, async ({
    page,
  }) => {
    await installLiveSession(page);
    await installTurnstileFake(page, { delayFirstGenerationCallback: delayedCallback });
    let currentEntry = { ...draftEntryDetailFixture };
    let releasePatch!: () => void;
    let notifyPatch!: () => void;
    const patchReceived = new Promise<void>((resolve) => {
      notifyPatch = resolve;
    });
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    let generationRequests = 0;
    await page.route('**/api/v1/config', (route) =>
      route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
    );
    await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
    await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        const update = route.request().postDataJSON() as {
          diaryDate: string;
          body: string;
        };
        notifyPatch();
        await patchGate;
        currentEntry = {
          ...currentEntry,
          ...update,
          revision: 2,
          updatedAt: '2026-01-02T00:00:00Z',
        };
      }
      return route.fulfill({ json: currentEntry });
    });
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
      route.fulfill({ json: generationFixtures(entryId, generationId).succeeded }),
    );
    await page.route('**/api/v1/assets/*/url', (route) =>
      route.fulfill({
        json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' },
      }),
    );
    await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

    await page.goto(`/entries/${entryId}`);
    await page.getByRole('button', { name: '4コマにする' }).click();
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha)))
      .toBe(true);

    await clickEntryMenuItem(page, '日記を編集');
    await page
      .getByLabel('今日はどんな日だった？', { exact: true })
      .fill('保存処理を確認する架空の日記');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await patchReceived;
    await expect(
      page.locator('.detail-edit-toolbar').getByRole('button', {
        name: '編集をやめる',
      }),
    ).toBeDisabled();
    await expect(
      page.locator('#edit-entry-form').getByRole('button', {
        name: '編集をやめる',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(() => window.__releaseE2eGenerationCaptcha?.());
    await page.waitForTimeout(25);
    expect(generationRequests).toBe(0);
    releasePatch();

    await expect(page.locator('.diary')).toHaveText('保存処理を確認する架空の日記');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新しい確認を取得' })).toHaveCount(0);
    const createButton = page.getByRole('button', { name: '4コマにする' });
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect.poll(() => generationRequests).toBe(1);
  });
}

test('生成失敗後に編集・再保存で新しい受付へ進め、残り枠を確認できる', async ({ page }) => {
  const failedGeneration = generationFixtures(entryId, generationId).failed;
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: failedGeneration,
  };
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: failedGeneration }),
  );

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByRole('alert')).toContainText(
    '本文を編集して保存すると新しく受付できます。',
  );
  await expect(page.getByRole('region', { name: '本日の漫画生成枠' })).toContainText(
    '本日の残り生成枠は3回です。',
  );
  await openEntryMenu(page);
  await expect(page.getByRole('menuitem', { name: '日記を編集' })).toBeVisible();
});

test('生成APIと受付再確認の503には生成向けの再操作案内を表示する', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
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
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend details are not displayed',
          requestId: 'generation-dependency-request',
          retryable: true,
        },
      },
    });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '4コマにする' }).click();
  const message = '漫画の受付を利用できません。時間をおいて再操作してください。';
  await expect(page.getByRole('alert')).toContainText(message);
  await page.getByRole('button', { name: '受付結果を確認' }).click();
  await expect(page.getByRole('alert')).toContainText(message);
  expect(generationRequests).toBe(2);
});

test('受付停止後の再確認は停止理由を保ち、同じ受付キーを使う', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  const generationRequests: Array<{ key: string; captchaToken: string }> = [];
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      captchaToken: (route.request().postDataJSON() as { captchaToken: string }).captchaToken,
    });
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'GENERATION_DISABLED',
          message: 'backend details are not displayed',
          requestId: 'generation-disabled-request',
          retryable: false,
        },
      },
    });
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '4コマにする' }).click();
  const stoppedMessage = '現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。';
  await expect(page.getByRole('alert')).toContainText(stoppedMessage);
  await expect(page.getByRole('button', { name: '受付結果を確認' })).toBeVisible();
  await page.getByRole('button', { name: '受付結果を確認' }).click();
  await expect(page.getByRole('alert')).toContainText(stoppedMessage);
  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(generationRequests[1]?.key).toBe(generationRequests[0]?.key);
  expect(generationRequests.map(({ captchaToken }) => captchaToken)).toEqual([
    'generation-token-e2e-1',
    '',
  ]);
});

test('受付結果の確認後は処理中blockerを出さず詳細へ遷移する', async ({ page }) => {
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  let generationRequests = 0;
  await page.route('**/api/v1/entries/*/generations', (route) => {
    generationRequests++;
    if (generationRequests === 1) return route.abort('failed');
    return route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'queued',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  let nativeDialogCount = 0;
  page.on('dialog', async (dialog) => {
    nativeDialogCount++;
    await dialog.dismiss();
  });

  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('再確認後の遷移を調べる架空の日記');
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect(page.getByRole('alert')).toContainText('入力内容を保持したまま再操作');
  await page.getByRole('button', { name: '受付結果を確認' }).click();

  await expect(page).toHaveURL(/\/entries\/[0-9a-f-]{36}$/);
  expect(nativeDialogCount).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(generationRequests).toBe(2);
});

test('quota待ち中に編集を始めたら遅延した自動生成要求を破棄する', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page, { delayFirstGenerationCallback: 'token' });
  await page.addInitScript(() => {
    window.history.replaceState(
      { key: 'e2e-start-generation', usr: { startGeneration: true }, idx: 0 },
      '',
      window.location.href,
    );
  });
  let releaseQuota!: () => void;
  let notifyQuota!: () => void;
  const quotaRequested = new Promise<void>((resolve) => {
    notifyQuota = resolve;
  });
  const quotaGate = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  let generationRequests = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', async (route) => {
    notifyQuota();
    await quotaGate;
    return route.fulfill({ json: availableQuota() });
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({ json: draftEntryDetailFixture }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    return route.abort('failed');
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await quotaRequested;
  await clickEntryMenuItem(page, '日記を編集');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('編集途中の日記を保護する架空の追記');
  releaseQuota();

  await expect(page.getByRole('region', { name: '本日の漫画生成枠' })).toContainText(
    '本日の残り生成枠は3回です。',
  );
  await expect(page.getByRole('region', { name: '漫画生成の確認' })).toHaveCount(0);
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(
    '編集途中の日記を保護する架空の追記',
  );
  expect(generationRequests).toBe(0);
});

test('削除中に届いたCAPTCHA tokenを破棄し、削除失敗後に新しい確認を取得できる', async ({
  page,
}) => {
  await installLiveSession(page);
  await installTurnstileFake(page, { delayFirstGenerationCallback: 'token' });
  let releaseDelete!: () => void;
  let notifyDelete!: () => void;
  const deleteRequested = new Promise<void>((resolve) => {
    notifyDelete = resolve;
  });
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let generationRequests = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'DELETE')
      return route.fulfill({ json: draftEntryDetailFixture });
    notifyDelete();
    await deleteGate;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend details are not displayed',
          requestId: 'delete-dependency-request',
          retryable: true,
        },
      },
    });
  });
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
    route.fulfill({ json: generationFixtures(entryId, generationId).succeeded }),
  );
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' },
    }),
  );
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());
  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '4コマにする' }).click();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha)))
    .toBe(true);
  await clickEntryMenuItem(page, '日記を削除');
  const deleteDialogTitle = 'この日記を削除しますか？';
  const confirmDelete = clickAppDialogButton(page, deleteDialogTitle, '削除する');
  await deleteRequested;
  await page.evaluate(() => window.__releaseE2eGenerationCaptcha?.());
  expect(generationRequests).toBe(0);
  releaseDelete();
  await confirmDelete;

  await expect(page.getByRole('alert')).toBeVisible();
  const retryButton = page.getByRole('button', { name: '新しい確認を取得' });
  await expect(retryButton).toBeVisible();
  await retryButton.click();
  await expect.poll(() => generationRequests).toBe(1);
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
});
