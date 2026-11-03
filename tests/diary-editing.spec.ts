import { expect, test, type Page } from '@playwright/test';
import { generationFixtures } from '../src/shared/fixtures';
import type { Entry, EntryDetail } from '../src/shared/schemas';
import {
  draftEntryDetailFixture,
  liveClientConfigFixture,
  mockClientConfigFixture,
} from './fixtures/client-config';

const entryId = draftEntryDetailFixture.id;
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: '2026-01-02T00:00:00Z',
        generationAvailable: true,
      },
    }),
  );
});

async function configureDetail(page: Page, detail = draftEntryDetailFixture) {
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));
  if (detail.latestGenerationId && detail.latestGeneration) {
    await page.route(`**/api/v1/generations/${detail.latestGenerationId}`, (route) =>
      route.fulfill({ json: detail.latestGeneration }),
    );
  }
}

async function setLiveSession(page: Page) {
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

async function respondToNextDialog<T>(
  page: Page,
  action: () => Promise<T>,
  accept: boolean,
  type: 'confirm' | 'beforeunload' = 'confirm',
): Promise<T> {
  const dialogPromise = page.waitForEvent('dialog');
  const actionPromise = action();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe(type);
  if (accept) await dialog.accept();
  else await dialog.dismiss();
  return actionPromise;
}

function nextDate(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date fixture: ${date}`);
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1))
    .toISOString()
    .slice(0, 10);
}

test('詳細の日付と1,000個のUnicode文字をrevision付きで保存し、古い漫画を案内する', async ({
  page,
}) => {
  const generation = generationFixtures(entryId, generationId, 1).succeeded;
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: generation,
  };
  let currentDetail = detail;
  let patch: { expectedRevision: number; diaryDate: string; body: string } | undefined;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: generation }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: currentDetail });
    const payload = route.request().postDataJSON() as {
      expectedRevision: number;
      diaryDate: string;
      body: string;
    };
    patch = payload;
    currentDetail = {
      ...currentDetail,
      diaryDate: payload.diaryDate,
      body: payload.body,
      revision: 2,
    };
    const updated: Entry = {
      id: currentDetail.id,
      diaryDate: currentDetail.diaryDate,
      body: currentDetail.body,
      revision: currentDetail.revision,
      latestGenerationId: currentDetail.latestGenerationId,
      createdAt: currentDetail.createdAt,
      updatedAt: currentDetail.updatedAt,
    };
    return route.fulfill({ json: updated });
  });

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '日記を編集' }).click();
  const diary = page.getByLabel('日記', { exact: true });
  const updatedBody = '😀'.repeat(1000);
  await page.getByLabel('日付', { exact: true }).fill('2026-01-02');
  await diary.fill(updatedBody);
  await expect(page.getByText('1000 / 1,000文字')).toBeVisible();
  await page.getByRole('button', { name: '変更を保存' }).click();

  await expect(page.getByText('2026-01-02 / 固定サンプル')).toBeVisible();
  await expect(page.getByText('編集前の日記から生成された漫画です。')).toBeVisible();
  await expect(page.getByText(updatedBody, { exact: true })).toBeVisible();
  expect(patch).toEqual({ expectedRevision: 1, diaryDate: '2026-01-02', body: updatedBody });
});

test('生成待ち・生成中の日記では編集操作を表示しない', async ({ page }) => {
  for (const status of ['queued', 'running'] as const) {
    const generation = generationFixtures(entryId, generationId, 1)[status];
    const detail: EntryDetail = {
      ...draftEntryDetailFixture,
      latestGenerationId: generationId,
      latestGeneration: generation,
    };
    await configureDetail(page, detail);
    await page.goto(`/entries/${entryId}`);
    await expect(page.getByRole('button', { name: '日記を編集' })).toHaveCount(0);
    await expect(
      page.getByText(
        status === 'queued' ? '受付済みです。生成を待っています。' : '画像を描いています。',
      ),
    ).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const failure of [
  { status: 401, code: 'AUTH_EXPIRED', mode: 'live' as const },
  { status: 409, code: 'REVISION_CONFLICT', mode: 'mock' as const },
  { status: 503, code: 'DEPENDENCY_UNAVAILABLE', mode: 'mock' as const },
]) {
  test(`${failure.status}保存失敗後も編集中の入力を保持する`, async ({ page }) => {
    if (failure.mode === 'live') {
      await setLiveSession(page);
      await page.route('**/api/v1/config', (route) =>
        route.fulfill({ json: liveClientConfigFixture }),
      );
    } else {
      await page.route('**/api/v1/config', (route) =>
        route.fulfill({ json: mockClientConfigFixture }),
      );
    }
    await page.route(`**/api/v1/entries/${entryId}`, (route) => {
      if (route.request().method() !== 'PATCH')
        return route.fulfill({ json: draftEntryDetailFixture });
      return route.fulfill({
        status: failure.status,
        json: {
          error: {
            code: failure.code,
            message: '保存できませんでした。',
            requestId: 'e2e-request-id',
            retryable: failure.status === 503,
          },
        },
      });
    });

    await page.goto(`/entries/${entryId}`);
    await page.getByRole('button', { name: '日記を編集' }).click();
    const draft = '失敗しても画面に残す架空の入力';
    await page.getByLabel('日記', { exact: true }).fill(draft);
    await page.getByRole('button', { name: '変更を保存' }).click();

    await expect(page.getByRole('alert')).toContainText(
      failure.status === 401
        ? '匿名セッションを確認できません。'
        : failure.code === 'REVISION_CONFLICT'
          ? '記録が更新されています。最新の内容を読み込んでから操作してください。'
          : '必要な機能を確認できないため、漫画の受付を停止しています。',
    );
    await expect(page.getByLabel('日記', { exact: true })).toHaveValue(draft);
  });
}

test('409後は利用者が選んだ場合だけ最新を読み込み、キャンセル時は入力を保つ', async ({ page }) => {
  const latest: EntryDetail = {
    ...draftEntryDetailFixture,
    body: '別タブで保存された最新の日記',
    revision: 2,
  };
  let getCount = 0;
  let patchAttempted = false;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() === 'GET') {
      getCount++;
      return route.fulfill({ json: patchAttempted ? latest : draftEntryDetailFixture });
    }
    patchAttempted = true;
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'REVISION_CONFLICT',
          message: '別の画面で変更されています。',
          requestId: 'e2e-request-id',
          retryable: false,
        },
      },
    });
  });

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '日記を編集' }).click();
  const draft = '別タブに上書きされない入力';
  await page.getByLabel('日記', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByRole('button', { name: '最新の記録を読み込む' })).toBeVisible();
  const initialReads = getCount;
  expect(initialReads).toBeGreaterThan(0);

  await respondToNextDialog(
    page,
    () => page.getByRole('button', { name: '最新の記録を読み込む' }).click(),
    false,
  );
  await expect(page.getByLabel('日記', { exact: true })).toHaveValue(draft);
  expect(getCount).toBe(initialReads);

  await respondToNextDialog(
    page,
    () => page.getByRole('button', { name: '最新の記録を読み込む' }).click(),
    true,
  );
  await expect(page.getByLabel('日記', { exact: true })).toHaveValue(latest.body);
  expect(getCount).toBe(initialReads + 1);
});

test('生成開始後の409を最新読込すると編集を閉じる', async ({ page }) => {
  const latest: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: generationFixtures(entryId, generationId, 1).queued,
  };
  let patchAttempted = false;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: latest.latestGeneration }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (route.request().method() === 'PATCH') {
      patchAttempted = true;
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'ENTRY_BUSY',
            message: '生成中の日記は編集できません。',
            requestId: 'e2e-request-id',
            retryable: false,
          },
        },
      });
    }
    return route.fulfill({ json: patchAttempted ? latest : draftEntryDetailFixture });
  });

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '日記を編集' }).click();
  await page.getByLabel('日記', { exact: true }).fill('生成競合後も保持する架空の日記');
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByRole('button', { name: '最新の記録を読み込む' })).toBeVisible();

  await respondToNextDialog(
    page,
    () => page.getByRole('button', { name: '最新の記録を読み込む' }).click(),
    true,
  );
  await expect(page.getByText('受付済みです。生成を待っています。')).toBeVisible();
  await expect(page.getByRole('button', { name: '日記を編集' })).toHaveCount(0);
  await expect(page.getByLabel('日記', { exact: true })).toHaveCount(0);
});

test('未来日は保存せず、日付と本文を保持する', async ({ page }) => {
  let patchCount = 0;
  await configureDetail(page);
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (route.request().method() === 'PATCH') patchCount++;
    return route.fulfill({ json: draftEntryDetailFixture });
  });
  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '日記を編集' }).click();
  const date = page.getByLabel('日付', { exact: true });
  const today = (await date.getAttribute('max')) ?? '2026-11-03';
  const future = nextDate(today);
  await date.fill(future);
  const draft = '未来の日付では保存しない架空の日記';
  await page.getByLabel('日記', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '変更を保存' }).click();

  await expect(date).toHaveValue(future);
  expect(await date.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(
    true,
  );
  await expect(page.getByLabel('日記', { exact: true })).toHaveValue(draft);
  expect(patchCount).toBe(0);
});

test('変更がない入力画面では離脱確認を表示しない', async ({ page }) => {
  let dialogCount = 0;
  page.on('dialog', (dialog) => {
    dialogCount++;
    void dialog.dismiss();
  });

  await page.goto('/new');
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);

  await configureDetail(page);
  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '日記を編集' }).click();
  const diary = page.getByLabel('日記', { exact: true });
  await diary.fill('いったん変えて元に戻す');
  await diary.fill(draftEntryDetailFixture.body);
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  expect(dialogCount).toBe(0);
});

test('アプリ内リンクと戻る/進むの確認を取り消した場合は入力が残る', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  const diary = page.getByLabel('日記', { exact: true });
  const draft = '確認を取り消しても残す架空の日記';
  await diary.fill(draft);

  await respondToNextDialog(
    page,
    () => page.getByRole('link', { name: '記録', exact: true }).click(),
    false,
  );
  await expect(page).toHaveURL(/\/new$/);
  await expect(diary).toHaveValue(draft);

  await respondToNextDialog(page, () => page.goBack(), false);
  await expect(page).toHaveURL(/\/new$/);
  await expect(diary).toHaveValue(draft);

  await respondToNextDialog(page, () => page.goBack(), true);
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/new$/);
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/new$/);
  const forwardDraft = '進む操作でも確認する架空の日記';
  await page.getByLabel('日記', { exact: true }).fill(forwardDraft);

  await respondToNextDialog(page, () => page.goForward(), false);
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByLabel('日記', { exact: true })).toHaveValue(forwardDraft);

  await respondToNextDialog(page, () => page.goForward(), true);
  await expect(page).toHaveURL(/\/library$/);
});

test('詳細編集の未保存入力はアプリ内移動とhard reload前に確認する', async ({ page }) => {
  await configureDetail(page);
  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '日記を編集' }).click();
  const diary = page.getByLabel('日記', { exact: true });
  const draft = '詳細編集で保護する架空の日記';
  await diary.fill(draft);

  await respondToNextDialog(
    page,
    () => page.getByRole('link', { name: '記録', exact: true }).click(),
    false,
  );
  await expect(page).toHaveURL(new RegExp(`/entries/${entryId}$`));
  await expect(diary).toHaveValue(draft);

  const stayedAtDetail = page.waitForEvent('dialog');
  void page.reload().catch(() => null);
  const reloadPrompt = await stayedAtDetail;
  expect(reloadPrompt.type()).toBe('beforeunload');
  await reloadPrompt.dismiss();
  await expect(page).toHaveURL(new RegExp(`/entries/${entryId}$`));
  await expect(diary).toHaveValue(draft);

  const load = page.waitForEvent('load');
  const leavingSite = page.waitForEvent('dialog');
  void page.reload().catch(() => null);
  const leavePrompt = await leavingSite;
  expect(leavePrompt.type()).toBe('beforeunload');
  await leavePrompt.accept();
  await load;
  await expect(page.getByRole('button', { name: '日記を編集' })).toBeVisible();
  await expect(page.getByText(draft, { exact: true })).toHaveCount(0);
});

for (const accept of [false, true]) {
  test(`保存処理中の離脱を${accept ? '承認' : 'キャンセル'}する`, async ({ page }) => {
    let requestStarted!: () => void;
    let releaseRequest!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const requestHold = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route('**/api/v1/entries', async (route) => {
      if (route.request().method() === 'POST') {
        requestStarted();
        await requestHold;
      }
      await route.continue();
    });

    await page.goto('/new');
    const draft = '保存処理中も確認する架空の日記';
    await page.getByLabel('日記', { exact: true }).fill(draft);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '下書き保存' }).click();
    await started;
    await expect(page.getByRole('button', { name: '保存しています…' })).toBeDisabled();

    await respondToNextDialog(
      page,
      () => page.getByRole('link', { name: '記録', exact: true }).click(),
      accept,
    );
    if (accept) await expect(page).toHaveURL(/\/library$/);
    else {
      await expect(page).toHaveURL(/\/new$/);
      await expect(page.getByLabel('日記', { exact: true })).toHaveValue(draft);
    }

    releaseRequest();
    if (accept) await expect(page).toHaveURL(/\/library$/);
    else await expect(page).toHaveURL(/\/entries\//);
  });
}

test('削除応答後に別記録を編集中なら新しい画面の状態を維持する', async ({ page }) => {
  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill('削除応答を待つAの記録');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  const firstId = new URL(page.url()).pathname.split('/').at(-1);
  expect(firstId).toBeTruthy();

  await page.goto('/new');
  await page.getByLabel('日記', { exact: true }).fill('編集中に保護するBの記録');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  const secondId = new URL(page.url()).pathname.split('/').at(-1);
  expect(secondId).toBeTruthy();
  expect(firstId).not.toBe(secondId);

  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteStarted!: () => void;
  const deletionStarted = new Promise<void>((resolve) => {
    deleteStarted = resolve;
  });
  await page.route(`**/api/v1/entries/${firstId}`, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    deleteStarted();
    await deleteGate;
    await route.fulfill({ json: { deleted: true } });
  });

  await page.goto(`/entries/${firstId}`);
  await respondToNextDialog(
    page,
    () => page.getByRole('button', { name: '記録を削除' }).click(),
    true,
  );
  await deletionStarted;

  await respondToNextDialog(
    page,
    () => page.getByRole('link', { name: '← 記録の一覧' }).click(),
    true,
  );
  await expect(page).toHaveURL(/\/library$/);
  await page.getByText('編集中に保護するBの記録', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/entries/${secondId}$`));
  await page.getByRole('button', { name: '日記を編集' }).click();
  const diary = page.getByLabel('日記', { exact: true });
  const editedBody = '削除Aの完了後も保持するBの未保存本文';
  await diary.fill(editedBody);

  const deletionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().endsWith(`/api/v1/entries/${firstId}`),
  );
  releaseDelete();
  await deletionResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  await expect(page).toHaveURL(new RegExp(`/entries/${secondId}$`));
  await expect(diary).toHaveValue(editedBody);
  const leaveDialogPromise = page.waitForEvent('dialog');
  const leaveNavigation = page.getByRole('link', { name: '← 記録の一覧' }).click();
  const leaveDialog = await leaveDialogPromise;
  expect(leaveDialog.message()).toContain('未保存の入力があります');
  await leaveDialog.dismiss();
  await leaveNavigation;
  await expect(page).toHaveURL(new RegExp(`/entries/${secondId}$`));
  await expect(diary).toHaveValue(editedBody);
});
