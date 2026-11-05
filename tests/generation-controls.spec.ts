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
} from './fixtures/ui';

const entryId = draftEntryDetailFixture.id;
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherEntryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const activeGenerationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const retryGenerationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const activeUnknownGeneration = generationFixtures(otherEntryId, activeGenerationId).unknown;

declare global {
  interface Window {
    __e2eTurnstileEvents?: Array<{ action: string | null; token: string }>;
    __e2eTurnstileExecuteEvents?: Array<{ action: string | null }>;
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
      // 再読み込み後も古いtokenの使い回しを検出できるよう連番を保つ。
      const attemptsKey = '__e2eGenerationCaptchaAttempts';
      let generationAttempts = Number(sessionStorage.getItem(attemptsKey) ?? 0);
      window.__e2eTurnstileEvents = [];
      window.__e2eTurnstileExecuteEvents = [];
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
          window.__e2eTurnstileExecuteEvents?.push({ action });
          if (action === 'generate' && failOnFirstGeneration && generationAttempts === 0) {
            generationAttempts++;
            sessionStorage.setItem(attemptsKey, String(generationAttempts));
            window.setTimeout(() => widget['error-callback'](), 0);
            return;
          }
          if (action === 'generate') {
            generationAttempts++;
            sessionStorage.setItem(attemptsKey, String(generationAttempts));
          }
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

async function generationCaptchaExecutions(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      window.__e2eTurnstileExecuteEvents?.filter(({ action }) => action === 'generate').length ?? 0,
  );
}

test('利用枠を手動更新して別job完了後の操作可否を反映し、入力を保つ', async ({ page }) => {
  let currentQuota = availableQuota(activeGenerationId);
  let quotaRequests = 0;
  let releaseRefresh!: () => void;
  let notifyRefresh!: () => void;
  const refreshRequested = new Promise<void>((resolve) => {
    notifyRefresh = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', async (route) => {
    quotaRequests++;
    if (quotaRequests > 1) {
      notifyRefresh();
      await refreshGate;
    }
    return route.fulfill({ json: currentQuota });
  });
  await page.route(`**/api/v1/generations/${activeGenerationId}`, (route) =>
    route.fulfill({ json: activeUnknownGeneration }),
  );
  await page.route('**/api/v1/entries/*/generations', (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    return route.fulfill({ status: 500, json: {} });
  });

  await page.goto('/new');
  const quotaStatus = page.getByRole('region', { name: '本日の漫画生成枠' });
  await expect(quotaStatus).toContainText('別の漫画の結果を確認中です');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '利用枠更新中も保つ架空の日記';
  await diary.fill(draft);
  currentQuota = { ...availableQuota(null), remainingToday: 2 };

  const refreshClick = quotaStatus.getByRole('button', { name: '利用枠を再確認' }).click();
  await refreshRequested;
  await expect(quotaStatus.getByRole('button', { name: '利用枠を確認しています…' })).toBeDisabled();
  releaseRefresh();
  await refreshClick;

  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled();
  await expect(diary).toHaveValue(draft);
  await expect(page.locator('[aria-label="本日の漫画生成枠"]')).toContainText(
    '本日の残り生成枠は2回です。',
  );
  expect(quotaRequests).toBe(2);
  expect(generationPosts).toBe(0);
});

test('タブ復帰で利用枠を更新し、生成を自動で始めない', async ({ page }) => {
  let currentQuota = availableQuota(activeGenerationId);
  let quotaRequests = 0;
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => {
    quotaRequests++;
    return route.fulfill({ json: currentQuota });
  });
  await page.route(`**/api/v1/generations/${activeGenerationId}`, (route) =>
    route.fulfill({ json: activeUnknownGeneration }),
  );
  await page.route('**/api/v1/entries/*/generations', (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    return route.fulfill({ status: 500, json: {} });
  });

  await page.goto('/new');
  const quotaStatus = page.getByRole('region', { name: '本日の漫画生成枠' });
  await expect(quotaStatus).toContainText('別の漫画の結果を確認中です');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = 'タブ復帰後にも保つ架空の日記';
  await diary.fill(draft);
  currentQuota = availableQuota(null);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));

  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled();
  await expect(diary).toHaveValue(draft);
  expect(quotaRequests).toBe(2);
  expect(generationPosts).toBe(0);
});

test('quota.resetAtの日次境界で再取得し、入力を保持する', async ({ page }) => {
  let quotaRequests = 0;
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => {
    quotaRequests++;
    const quota =
      quotaRequests === 1
        ? {
            remainingToday: 0,
            activeGenerationId: null,
            resetAt: new Date(Date.now() + 1500).toISOString(),
            generationAvailable: true,
          }
        : availableQuota(null);
    return route.fulfill({ json: quota });
  });
  await page.route('**/api/v1/entries/*/generations', (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    return route.fulfill({ status: 500, json: {} });
  });

  await page.goto('/new');
  const quotaStatus = page.getByRole('region', { name: '本日の漫画生成枠' });
  await expect(quotaStatus).toContainText('本日の生成上限に達しています');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '日次更新後にも保つ架空の日記';
  await diary.fill(draft);

  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled({
    timeout: 7000,
  });
  await expect(diary).toHaveValue(draft);
  expect(quotaRequests).toBe(2);
  expect(generationPosts).toBe(0);
});

test('日次境界前の利用枠要求が終わった後に一度だけ再取得する', async ({ page }) => {
  const resetAt = new Date(Date.now() + 1000).toISOString();
  const oldQuota = {
    remainingToday: 0,
    activeGenerationId: null,
    resetAt,
    generationAvailable: true,
  };
  let quotaRequests = 0;
  let releaseRefresh!: () => void;
  let notifyRefresh!: () => void;
  const refreshRequested = new Promise<void>((resolve) => {
    notifyRefresh = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', async (route) => {
    quotaRequests++;
    if (quotaRequests === 2) {
      notifyRefresh();
      await refreshGate;
      return route.fulfill({ json: oldQuota });
    }
    return route.fulfill({ json: quotaRequests === 1 ? oldQuota : availableQuota() });
  });
  await page.route('**/api/v1/entries/*/generations', (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    return route.fulfill({ status: 500, json: {} });
  });

  await page.goto('/new');
  const quotaStatus = page.getByRole('region', { name: '本日の漫画生成枠' });
  await expect(quotaStatus).toContainText('本日の生成上限に達しています');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '遅れてきた日次境界の再取得後にも保つ日記';
  await diary.fill(draft);
  const refreshClick = quotaStatus.getByRole('button', { name: '利用枠を再確認' }).click();
  await refreshRequested;
  await page.waitForTimeout(2600);
  releaseRefresh();
  await refreshClick;

  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled();
  await expect(diary).toHaveValue(draft);
  await expect(quotaStatus).toContainText('本日の残り生成枠は3回です。');
  expect(quotaRequests).toBe(3);
  expect(generationPosts).toBe(0);
});

test('初回の利用枠応答が日次境界を越えた場合も再取得する', async ({ page }) => {
  const resetAt = new Date(Date.now() + 800).toISOString();
  const oldQuota = {
    remainingToday: 0,
    activeGenerationId: null,
    resetAt,
    generationAvailable: true,
  };
  let quotaRequests = 0;
  let releaseInitial!: () => void;
  let notifyInitial!: () => void;
  const initialRequested = new Promise<void>((resolve) => {
    notifyInitial = resolve;
  });
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', async (route) => {
    quotaRequests++;
    if (quotaRequests === 1) {
      notifyInitial();
      await initialGate;
      return route.fulfill({ json: oldQuota });
    }
    return route.fulfill({ json: availableQuota() });
  });
  await page.route('**/api/v1/entries/*/generations', (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    return route.fulfill({ status: 500, json: {} });
  });

  await page.goto('/new');
  await initialRequested;
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '初回応答が日次境界を越えても保持する日記';
  await diary.fill(draft);
  await page.waitForTimeout(1400);
  releaseInitial();

  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled();
  await expect(diary).toHaveValue(draft);
  await expect(page.getByRole('region', { name: '本日の漫画生成枠' })).toContainText(
    '本日の残り生成枠は3回です。',
  );
  expect(quotaRequests).toBe(2);
  expect(generationPosts).toBe(0);
});

test('終端polling後に返った古いactive-generation応答で成功状態を戻さない', async ({ page }) => {
  const queued = generationFixtures(entryId, generationId).queued;
  const running = generationFixtures(entryId, generationId).running;
  const succeeded = generationFixtures(entryId, generationId).succeeded;
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: queued,
  };
  let quotaRequests = 0;
  let activateNextQuota = false;
  let generationReads = 0;
  let releaseActiveRead!: () => void;
  let notifyActiveRead!: () => void;
  const activeReadStarted = new Promise<void>((resolve) => {
    notifyActiveRead = resolve;
  });
  const activeReadGate = new Promise<void>((resolve) => {
    releaseActiveRead = resolve;
  });
  await page.clock.install();
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) => {
    quotaRequests++;
    const activeGenerationId = activateNextQuota ? generationId : null;
    activateNextQuota = false;
    return route.fulfill({ json: availableQuota(activeGenerationId) });
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    generationReads++;
    if (generationReads === 1) return route.fulfill({ json: queued });
    if (generationReads === 2) {
      notifyActiveRead();
      await activeReadGate;
      return route.fulfill({ json: running });
    }
    return route.fulfill({ json: succeeded });
  });
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' },
    }),
  );

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  await expect.poll(() => quotaRequests).toBe(1);
  await page.clock.runFor(1200);
  activateNextQuota = true;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await activeReadStarted;

  await page.clock.runFor(4000);
  await expect(page.getByRole('heading', { name: succeeded.comic.title })).toBeVisible();
  await expect.poll(() => quotaRequests).toBe(3);
  releaseActiveRead();
  await expect.poll(() => generationReads).toBe(3);
  await expect(page.getByRole('heading', { name: succeeded.comic.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toHaveCount(0);
});

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
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({
      json: {
        ...entryDetail,
        latestGenerationId: generation?.id ?? null,
        latestGeneration: generation,
      },
    }),
  );
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
  let latestGeneration: Generation | null = null;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: availableQuota(latestGeneration?.status === 'unknown' ? generationId : null),
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({
      json: {
        ...draftEntryDetailFixture,
        latestGenerationId: latestGeneration?.id ?? null,
        latestGeneration,
      },
    }),
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
    latestGeneration = firstGeneration;
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

  await page.clock.install();
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
  await expect.poll(() => generationReads).toBe(1);

  const readsAfterUnknown = generationReads;
  await page.clock.runFor(5200);
  // 仮想タイマーが発行した通信の通知も観測してから、リクエスト数を検査する。
  await page.waitForTimeout(500);
  expect(generationRequests).toHaveLength(2);
  expect(generationReads).toBe(readsAfterUnknown);
  await expect(page.getByRole('button', { name: '新しい確認を取得' })).toHaveCount(0);
});

test('生成用CAPTCHAが失敗しても保存済みの日記を残して取り直せる', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page, { failFirstGeneration: true });
  const generation = generationFixtures(entryId, generationId).succeeded;
  let latestGeneration: Generation | null = null;
  let generationRequests = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({
      json: {
        ...draftEntryDetailFixture,
        latestGenerationId: latestGeneration?.id ?? null,
        latestGeneration,
      },
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    generationRequests++;
    latestGeneration = generation;
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

test('生成状態を参照できない間は受付せず、状態の再確認で復帰する', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  await page.addInitScript(() => {
    window.history.replaceState(
      { key: 'e2e-start-generation', usr: { startGeneration: true }, idx: 0 },
      '',
      window.location.href,
    );
  });
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: null,
  };
  const succeeded = generationFixtures(entryId, generationId).succeeded;
  let generationReads = 0;
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/generations/${generationId}`, (route) => {
    generationReads++;
    if (generationReads === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'backend details are not displayed',
            requestId: 'generation-state-unavailable',
            retryable: true,
          },
        },
      });
    return route.fulfill({ json: succeeded });
  });
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' },
    }),
  );
  await page.route('**/api/v1/entries/*/generations', (route) => {
    generationPosts++;
    return route.abort();
  });
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByRole('alert')).toContainText(
    '状態が確認できるまで新しい生成は受け付けません。',
  );
  await expect(page.getByRole('button', { name: '状態を再確認する' })).toBeVisible();
  await expect(page.getByRole('button', { name: '4コマにする' })).toHaveCount(0);
  expect(generationReads).toBe(1);
  expect(generationPosts).toBe(0);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: '4コマにする' })).toHaveCount(0);
  expect(generationReads).toBe(1);
  expect(generationPosts).toBe(0);
  expect(await generationCaptchaExecutions(page)).toBe(0);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);

  await page.getByRole('button', { name: '状態を再確認する' }).click();
  await expect(page.getByRole('heading', { level: 1, name: succeeded.comic.title })).toBeVisible();
  expect(generationReads).toBe(2);
  expect(generationPosts).toBe(0);
  expect(await generationCaptchaExecutions(page)).toBe(0);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
});

test('同じ記録のjobを利用枠カードで別記録として案内しない', async ({ page }) => {
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: null,
  };
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({ json: availableQuota(generationId) }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend generation state is unavailable',
          requestId: 'same-entry-generation-unavailable',
          retryable: true,
        },
      },
    }),
  );

  await page.goto(`/entries/${entryId}`);
  const quotaStatus = page.getByRole('region', { name: '本日の漫画生成枠' });
  await expect(quotaStatus).toBeVisible();
  await expect(quotaStatus).not.toContainText('別の漫画を作成しています');
  await expect(quotaStatus).not.toContainText('別の漫画の結果を確認中です');
});

for (const activeGenerationState of ['unknown', 'unavailable'] as const) {
  test(`別記録の${activeGenerationState === 'unknown' ? '結果確認中' : '状態参照失敗'}は新規受付を止める`, async ({
    page,
  }) => {
    await installLiveSession(page);
    await installTurnstileFake(page);
    await page.addInitScript(() => {
      window.history.replaceState(
        { key: 'e2e-start-generation', usr: { startGeneration: true }, idx: 0 },
        '',
        window.location.href,
      );
    });
    let activeGenerationReads = 0;
    let generationPosts = 0;
    await page.route('**/api/v1/config', (route) =>
      route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
    );
    await page.route('**/api/v1/me/quota', (route) =>
      route.fulfill({ json: availableQuota(activeGenerationId) }),
    );
    await page.route(`**/api/v1/entries/${entryId}`, (route) =>
      route.fulfill({ json: draftEntryDetailFixture }),
    );
    await page.route(`**/api/v1/entries/${otherEntryId}`, (route) =>
      route.fulfill({
        json: {
          ...draftEntryDetailFixture,
          id: otherEntryId,
          latestGenerationId: activeGenerationId,
          latestGeneration: activeUnknownGeneration,
        },
      }),
    );
    await page.route(`**/api/v1/generations/${activeGenerationId}`, (route) => {
      activeGenerationReads++;
      if (activeGenerationState === 'unknown')
        return route.fulfill({ json: activeUnknownGeneration });
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'backend details are not displayed',
            requestId: 'active-generation-unavailable',
            retryable: true,
          },
        },
      });
    });
    await page.route('**/api/v1/entries/*/generations', (route) => {
      generationPosts++;
      return route.abort();
    });

    await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());
    const waitForActiveGeneration = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === `/api/v1/generations/${activeGenerationId}`,
      );
    const detailActiveResponse = waitForActiveGeneration();
    await page.goto(`/entries/${entryId}`);
    await (await detailActiveResponse).finished();
    const quotaStatus = page.getByRole('region', { name: '本日の漫画生成枠' });
    if (activeGenerationState === 'unknown') {
      await expect(quotaStatus).toContainText(
        '別の漫画の結果を確認中です。自動では再生成しません。',
      );
      await expect(page.getByRole('link', { name: '進行中の記録を見る' })).toHaveAttribute(
        'href',
        `/entries/${otherEntryId}`,
      );
    } else {
      await expect(quotaStatus).toContainText('別の漫画を作成しています。');
      await expect(quotaStatus).toContainText('記録の一覧から進行状況を確認してください。');
      await expect(page.getByRole('link', { name: '進行中の記録を見る' })).toHaveCount(0);
    }
    await expect(
      page.getByRole('button', { name: '進行中の漫画を確認してください' }),
    ).toBeDisabled();
    expect(activeGenerationReads).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(
      page.getByRole('button', { name: '進行中の漫画を確認してください' }),
    ).toBeDisabled();
    expect(generationPosts).toBe(0);
    expect(await generationCaptchaExecutions(page)).toBe(0);
    expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);

    if (activeGenerationState === 'unknown') {
      await page.getByRole('link', { name: '進行中の記録を見る' }).click();
      await expect(page).toHaveURL(new RegExp(`/entries/${otherEntryId}$`));
      await expect(page.getByRole('heading', { name: '生成結果を確認中' })).toBeVisible();
    }

    const newActiveResponse = waitForActiveGeneration();
    await page.goto('/new');
    await (await newActiveResponse).finished();
    await page
      .getByLabel('今日はどんな日だった？', { exact: true })
      .fill('生成中の別記録がある場合の架空日記');
    if (activeGenerationState === 'unknown') {
      await expect(quotaStatus).toContainText(
        '別の漫画の結果を確認中です。自動では再生成しません。',
      );
      await expect(page.getByRole('link', { name: '進行中の記録を見る' })).toHaveAttribute(
        'href',
        `/entries/${otherEntryId}`,
      );
    } else {
      await expect(quotaStatus).toContainText('別の漫画を作成しています。');
      await expect(quotaStatus).toContainText('記録の一覧から進行状況を確認してください。');
      await expect(page.getByRole('link', { name: '進行中の記録を見る' })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: '下書きとして保存' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '4コマにする' })).toHaveCount(0);
    expect(generationPosts).toBe(0);
  });
}

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

  const responseWait = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
    );
  });
  releaseRequest();
  const delayedResponse = await responseWait;
  await delayedResponse.finished();
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
    const generationRequests: Array<{ key: string; token: string; expectedRevision: number }> = [];
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
      const body = route.request().postDataJSON() as {
        captchaToken: string;
        expectedRevision: number;
      };
      generationRequests.push({
        key: route.request().headers()['idempotency-key'] ?? '',
        token: body.captchaToken,
        expectedRevision: body.expectedRevision,
      });
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
    expect(generationRequests).toHaveLength(0);
    const patchResponseWait = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/v1/entries/${entryId}`,
    );
    releasePatch();
    const patchResponse = await patchResponseWait;
    await patchResponse.finished();

    await expect(page.locator('.diary')).toHaveText('保存処理を確認する架空の日記');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新しい確認を取得' })).toHaveCount(0);
    const createButton = page.getByRole('button', { name: '4コマにする' });
    await expect(createButton).toBeEnabled();
    const generationResponseWait = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
      );
    });
    await createButton.click();
    const generationResponse = await generationResponseWait;
    await generationResponse.finished();
    expect(generationRequests).toEqual([
      {
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        token: 'generation-token-e2e-2',
        expectedRevision: 2,
      },
    ]);
  });
}

test('生成失敗後に編集・再保存して改訂番号を更新し、新しい受付へ進む', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  const failedGeneration = generationFixtures(entryId, generationId).failed;
  const retriedGeneration = generationFixtures(entryId, retryGenerationId, 2).queued;
  let currentEntry: EntryDetail = { ...draftEntryDetailFixture };
  const patchRequests: Array<{ expectedRevision: number; diaryDate: string; body: string }> = [];
  const generationRequests: Array<{
    key: string;
    captchaToken: string;
    expectedRevision: number;
  }> = [];
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const update = route.request().postDataJSON() as {
        expectedRevision: number;
        diaryDate: string;
        body: string;
      };
      patchRequests.push(update);
      currentEntry = {
        ...currentEntry,
        diaryDate: update.diaryDate,
        body: update.body,
        revision: currentEntry.revision + 1,
        latestGenerationId: generationId,
        latestGeneration: failedGeneration,
        updatedAt: '2026-01-02T00:00:00Z',
      };
      return route.fulfill({
        json: {
          id: currentEntry.id,
          diaryDate: currentEntry.diaryDate,
          body: currentEntry.body,
          revision: currentEntry.revision,
          latestGenerationId: currentEntry.latestGenerationId,
          createdAt: currentEntry.createdAt,
          updatedAt: currentEntry.updatedAt,
        },
      });
    }
    return route.fulfill({ json: currentEntry });
  });
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      captchaToken: string;
    };
    generationRequests.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      captchaToken: body.captchaToken,
      expectedRevision: body.expectedRevision,
    });
    const nextGenerationId = generationRequests.length === 1 ? generationId : retryGenerationId;
    currentEntry = {
      ...currentEntry,
      latestGenerationId: nextGenerationId,
      latestGeneration: generationRequests.length === 1 ? failedGeneration : retriedGeneration,
    };
    return route.fulfill({
      status: 202,
      json: {
        generationId: nextGenerationId,
        status: 'queued',
        statusUrl: `/api/v1/generations/${nextGenerationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: failedGeneration }),
  );
  await page.route(`**/api/v1/generations/${retryGenerationId}`, (route) =>
    route.fulfill({ json: retriedGeneration }),
  );
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  const firstResponseWait = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
    );
  });
  await page.getByRole('button', { name: '4コマにする' }).click();
  const firstResponse = await firstResponseWait;
  await firstResponse.finished();
  const sameRevisionRetry = page.getByRole('button', { name: '4コマにする', exact: true });
  const expectFailedStateWithoutSameRevisionRetry = async () => {
    await expect(page.getByRole('heading', { name: '漫画を生成できませんでした' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      '本文を編集して保存すると新しく受付できます。',
    );
    await expect(page.getByRole('region', { name: '本日の漫画生成枠' })).toContainText(
      '本日の残り生成枠は3回です。',
    );
    await expect
      .poll(
        async () =>
          (await sameRevisionRetry.count()) === 0 || !(await sameRevisionRetry.isEnabled()),
      )
      .toBe(true);
    expect(generationRequests).toHaveLength(1);
    expect(generationRequests[0]).toMatchObject({
      expectedRevision: 1,
      captchaToken: 'generation-token-e2e-1',
    });
  };
  await expectFailedStateWithoutSameRevisionRetry();
  await page.reload();
  await expectFailedStateWithoutSameRevisionRetry();

  await clickEntryMenuItem(page, '日記を編集');
  const updatedBody = '失敗後に編集して保存する架空の日記';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(updatedBody);
  const patchResponseWait = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/api/v1/entries/${entryId}`,
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const patchResponse = await patchResponseWait;
  await patchResponse.finished();
  await expect(page.getByRole('button', { name: '4コマにする' })).toBeEnabled();
  await expect(page.locator('#original-diary summary')).toHaveText('元の日記を読む');
  await page.locator('#original-diary summary').click();
  await expect(page.locator('#original-diary .diary')).toHaveText(updatedBody);
  expect(patchRequests).toEqual([
    { expectedRevision: 1, diaryDate: draftEntryDetailFixture.diaryDate, body: updatedBody },
  ]);

  const retryResponseWait = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
    );
  });
  await page.getByRole('button', { name: '4コマにする' }).click();
  const retryResponse = await retryResponseWait;
  await retryResponse.finished();
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[0]?.expectedRevision).toBe(1);
  expect(generationRequests[1]).toMatchObject({
    expectedRevision: 2,
    captchaToken: 'generation-token-e2e-2',
  });
  expect(generationRequests[1]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(generationRequests[1]?.key).not.toBe(generationRequests[0]?.key);
});

test('生成APIと受付再確認の503には生成向けの再操作案内を表示する', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  const generationRequests: Array<{ key: string; captchaToken: string }> = [];
  let releaseRetry!: () => void;
  let notifyRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const retryRequestReceived = new Promise<void>((resolve) => {
    notifyRetry = resolve;
  });
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
    if (generationRequests.length === 2) {
      notifyRetry();
      return retryGate.then(() =>
        route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'backend details are not displayed',
              requestId: 'generation-dependency-request',
              retryable: true,
            },
          },
        }),
      );
    }
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
  const waitForGenerationResponse = () =>
    page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
      );
    });
  const firstResponseWait = waitForGenerationResponse();
  await page.getByRole('button', { name: '4コマにする' }).click();
  const firstResponse = await firstResponseWait;
  await firstResponse.finished();
  const message = '漫画の受付を利用できません。時間をおいて再操作してください。';
  await expect(page.getByRole('alert')).toContainText(message);
  const retryResponseWait = waitForGenerationResponse();
  await page.getByRole('button', { name: '受付結果を確認' }).click();
  await retryRequestReceived;
  const pendingButton = page.getByRole('button', {
    name: '受付結果を確認しています…',
    exact: true,
  });
  await expect(pendingButton).toBeDisabled();
  releaseRetry();
  const retryResponse = await retryResponseWait;
  await retryResponse.finished();
  await expect(page.getByRole('button', { name: '受付結果を確認', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText(message);
  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(generationRequests[1]?.key).toBe(generationRequests[0]?.key);
  expect(generationRequests.map(({ captchaToken }) => captchaToken)).toEqual([
    'generation-token-e2e-1',
    '',
  ]);
});

test('受付停止後の再確認は停止理由を保ち、同じ受付キーを使う', async ({ page }) => {
  await installLiveSession(page);
  await installTurnstileFake(page);
  const generationRequests: Array<{ key: string; captchaToken: string }> = [];
  let releaseRetry!: () => void;
  let notifyRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const retryRequestReceived = new Promise<void>((resolve) => {
    notifyRetry = resolve;
  });
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
    if (generationRequests.length === 2) {
      notifyRetry();
      return retryGate.then(() =>
        route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'GENERATION_DISABLED',
              message: 'backend details are not displayed',
              requestId: 'generation-disabled-request',
              retryable: false,
            },
          },
        }),
      );
    }
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
  const waitForGenerationResponse = () =>
    page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
      );
    });
  const firstResponseWait = waitForGenerationResponse();
  await page.getByRole('button', { name: '4コマにする' }).click();
  const firstResponse = await firstResponseWait;
  await firstResponse.finished();
  const stoppedMessage = '現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。';
  await expect(page.getByRole('alert')).toContainText(stoppedMessage);
  await expect(page.getByRole('button', { name: '受付結果を確認' })).toBeVisible();
  const retryResponseWait = waitForGenerationResponse();
  await page.getByRole('button', { name: '受付結果を確認' }).click();
  await retryRequestReceived;
  const pendingButton = page.getByRole('button', {
    name: '受付結果を確認しています…',
    exact: true,
  });
  await expect(pendingButton).toBeDisabled();
  releaseRetry();
  const retryResponse = await retryResponseWait;
  await retryResponse.finished();
  await expect(page.getByRole('button', { name: '受付結果を確認', exact: true })).toBeEnabled();
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
  let currentEntry: EntryDetail = { ...draftEntryDetailFixture };
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (route.request().method() === 'PATCH') {
      const update = route.request().postDataJSON() as { body: string; diaryDate: string };
      currentEntry = {
        ...currentEntry,
        body: update.body,
        diaryDate: update.diaryDate,
        revision: 2,
      };
    }
    return route.fulfill({ json: currentEntry });
  });
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
  expect(await page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha))).toBe(false);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
  expect(generationRequests).toBe(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha))).toBe(false);
  expect(await generationCaptchaExecutions(page)).toBe(0);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
  expect(generationRequests).toBe(0);

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.diary')).toHaveText('編集途中の日記を保護する架空の追記');
  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(await generationCaptchaExecutions(page)).toBe(0);
  expect(await page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha))).toBe(false);
  expect(generationRequests).toBe(0);
});

test('quota待ち中に編集しなければ自動生成用CAPTCHAを実行する', async ({ page }) => {
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
  const generationRequests: Array<{ key: string; captchaToken: string; expectedRevision: number }> =
    [];
  let latestGeneration: Generation | null = null;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', async (route) => {
    notifyQuota();
    await quotaGate;
    return route.fulfill({ json: availableQuota() });
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) =>
    route.fulfill({
      json: {
        ...draftEntryDetailFixture,
        latestGenerationId: latestGeneration?.id ?? null,
        latestGeneration,
      },
    }),
  );
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      captchaToken: string;
    };
    generationRequests.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      captchaToken: body.captchaToken,
      expectedRevision: body.expectedRevision,
    });
    latestGeneration = generationFixtures(entryId, generationId).queued;
    return route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'queued',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generationFixtures(entryId, generationId).queued }),
  );
  await page.route('https://manga-nikki-e2e.supabase.co/**', (route) => route.abort());

  await page.goto(`/entries/${entryId}`);
  await quotaRequested;
  await expect(page.locator('.entry-draft-card .diary')).toHaveText(draftEntryDetailFixture.body);
  await expect(page.getByRole('button', { name: 'その他の操作' })).toBeVisible();
  expect(await page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha))).toBe(false);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
  expect(generationRequests).toHaveLength(0);
  releaseQuota();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__releaseE2eGenerationCaptcha)))
    .toBe(true);
  expect(generationRequests).toHaveLength(0);
  expect(await generationCaptchaExecutions(page)).toBe(1);
  expect(await page.evaluate(() => window.__e2eTurnstileEvents ?? [])).toEqual([]);
  const generationResponseWait = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
    );
  });
  await page.evaluate(() => window.__releaseE2eGenerationCaptcha?.());
  const generationResponse = await generationResponseWait;
  await generationResponse.finished();
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  expect(generationRequests).toHaveLength(1);
  expect(generationRequests[0]).toMatchObject({
    key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    captchaToken: 'generation-token-e2e-1',
    expectedRevision: 1,
  });
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
  const generationRequests: Array<{ key: string; token: string; expectedRevision: number }> = [];
  let latestGeneration: Generation | null = null;
  await page.route('**/api/v1/config', (route) =>
    route.fulfill({ json: { ...liveClientConfigFixture, generationAvailable: true } }),
  );
  await page.route('**/api/v1/me/quota', (route) => route.fulfill({ json: availableQuota() }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'DELETE')
      return route.fulfill({
        json: {
          ...draftEntryDetailFixture,
          latestGenerationId: latestGeneration?.id ?? null,
          latestGeneration,
        },
      });
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
    const body = route.request().postDataJSON() as {
      captchaToken: string;
      expectedRevision: number;
    };
    generationRequests.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      token: body.captchaToken,
      expectedRevision: body.expectedRevision,
    });
    latestGeneration = generationFixtures(entryId, generationId).succeeded;
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
  await page.waitForTimeout(25);
  expect(generationRequests).toHaveLength(0);
  releaseDelete();
  await confirmDelete;

  await expect(page.getByRole('alert')).toBeVisible();
  const retryButton = page.getByRole('button', { name: '新しい確認を取得' });
  await expect(retryButton).toBeVisible();
  const generationResponseWait = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/entries/${entryId}/generations`
    );
  });
  await retryButton.click();
  const generationResponse = await generationResponseWait;
  await generationResponse.finished();
  await expect(page.getByRole('heading', { level: 1, name: 'いつもの一日' })).toBeVisible();
  expect(generationRequests).toEqual([
    {
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      token: 'generation-token-e2e-2',
      expectedRevision: 1,
    },
  ]);
});
