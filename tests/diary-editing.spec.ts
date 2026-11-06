import { expect, test, type Page } from '@playwright/test';
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

async function navigateThroughAppDialog<T>(
  page: Page,
  action: () => Promise<T>,
  title: string,
  buttonName: string,
): Promise<T> {
  const actionPromise = action();
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
  await clickAppDialogButton(page, title, buttonName);
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
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await expect(diary).not.toHaveAttribute('aria-label');
  const updatedBody = '😀'.repeat(1000);
  await page.getByLabel('日付', { exact: true }).fill('2026-01-02');
  await diary.fill(updatedBody);
  await expect(page.getByText('1000 / 1,000', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(page.locator('.detail-date-row time')).toHaveAttribute('datetime', '2026-01-02');
  await expect(page.getByText('編集前の日記から生成された漫画です。')).toBeVisible();
  await page.getByText('元の日記を読む', { exact: true }).click();
  await expect(page.getByText(updatedBody, { exact: true })).toBeVisible();
  expect(patch).toEqual({ expectedRevision: 1, diaryDate: '2026-01-02', body: updatedBody });
});

test('編集保存直後の遅延再取得で同じrevisionの別タブ生成結果を表示する', async ({ page }) => {
  const latestGeneration = generationFixtures(entryId, generationId, 2).succeeded;
  const updatedEntry: Entry = {
    id: entryId,
    diaryDate: draftEntryDetailFixture.diaryDate,
    body: '編集後の日記です。',
    revision: 2,
    latestGenerationId: generationId,
    createdAt: draftEntryDetailFixture.createdAt,
    updatedAt: draftEntryDetailFixture.updatedAt,
  };
  const latestDetail: EntryDetail = {
    ...updatedEntry,
    latestGeneration: null,
  };
  let releaseLatestRead!: () => void;
  let notifyLatestRead!: () => void;
  const latestReadRequested = new Promise<void>((resolve) => {
    notifyLatestRead = resolve;
  });
  const latestReadGate = new Promise<void>((resolve) => {
    releaseLatestRead = resolve;
  });
  let patchSaved = false;

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: latestGeneration }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      patchSaved = true;
      return route.fulfill({ json: updatedEntry });
    }
    if (!patchSaved) return route.fulfill({ json: draftEntryDetailFixture });
    notifyLatestRead();
    await latestReadGate;
    return route.fulfill({ json: latestDetail });
  });
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({ json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' } }),
  );

  await page.goto(`/entries/${entryId}`);
  await expect(page.locator('.diary')).toHaveText(draftEntryDetailFixture.body);
  await clickEntryMenuItem(page, '日記を編集');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(updatedEntry.body);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await latestReadRequested;
  releaseLatestRead();

  await expect(page.locator('.comic')).toBeVisible();
  await expect(page.locator('.detail-date-row time')).toHaveAttribute(
    'datetime',
    updatedEntry.diaryDate,
  );
  await expect(page.getByRole('heading', { name: 'いつもの一日' })).toBeVisible();
  await expect(page.getByText('漫画の状態を確認できません')).toHaveCount(0);
});

test('編集保存が成功した後の再取得失敗でも保留中の遷移を続ける', async ({ page }) => {
  let releasePatch!: () => void;
  let notifyPatch!: () => void;
  const patchRequested = new Promise<void>((resolve) => {
    notifyPatch = resolve;
  });
  const patchGate = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  let patchSaved = false;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      notifyPatch();
      await patchGate;
      patchSaved = true;
      const update = route.request().postDataJSON() as {
        expectedRevision: number;
        diaryDate: string;
        body: string;
      };
      return route.fulfill({
        json: {
          id: entryId,
          diaryDate: update.diaryDate,
          body: update.body,
          revision: 2,
          latestGenerationId: null,
          createdAt: draftEntryDetailFixture.createdAt,
          updatedAt: draftEntryDetailFixture.updatedAt,
        } satisfies Entry,
      });
    }
    if (!patchSaved) return route.fulfill({ json: draftEntryDetailFixture });
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend refresh error',
          requestId: 'saved-entry-refresh-error-e2e',
          retryable: true,
        },
      },
    });
  });

  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('保存成功後の再取得確認用の日記');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await patchRequested;
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releasePatch();

  await expect(page).toHaveURL('/');
});

test('再生成中と失敗後も最後に保存した漫画を表示し、最新jobの状態を併記する', async ({ page }) => {
  const previousSuccess = generationFixtures(entryId, generationId, 1).succeeded;
  const retryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  let latestGeneration: Generation = previousSuccess;
  let currentDetail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: previousSuccess.id,
    latestGeneration: previousSuccess,
    lastSuccessfulGeneration: previousSuccess,
  };
  let status: 'queued' | 'failed' = 'queued';
  let statusRequests = 0;

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const update = route.request().postDataJSON() as {
        expectedRevision: number;
        diaryDate: string;
        body: string;
      };
      currentDetail = {
        ...currentDetail,
        diaryDate: update.diaryDate,
        body: update.body,
        revision: currentDetail.revision + 1,
      };
      return route.fulfill({
        json: {
          id: currentDetail.id,
          diaryDate: currentDetail.diaryDate,
          body: currentDetail.body,
          revision: currentDetail.revision,
          latestGenerationId: currentDetail.latestGenerationId,
          createdAt: currentDetail.createdAt,
          updatedAt: currentDetail.updatedAt,
        } satisfies Entry,
      });
    }
    return route.fulfill({ json: currentDetail });
  });
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    latestGeneration = generationFixtures(entryId, retryId, 2).queued;
    currentDetail = {
      ...currentDetail,
      latestGenerationId: retryId,
      latestGeneration,
      lastSuccessfulGeneration: previousSuccess,
    };
    return route.fulfill({
      status: 202,
      json: {
        generationId: retryId,
        status: 'queued',
        statusUrl: `/api/v1/generations/${retryId}`,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, (route) =>
    route.fulfill({ json: previousSuccess }),
  );
  await page.route(`**/api/v1/generations/${retryId}`, (route) => {
    statusRequests++;
    latestGeneration =
      status === 'failed' ? generationFixtures(entryId, retryId, 2).failed : latestGeneration;
    return route.fulfill({ json: latestGeneration });
  });
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({ json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' } }),
  );

  await page.goto(`/entries/${entryId}`);
  await expect(page.locator('.comic')).toBeVisible();
  await clickEntryMenuItem(page, '日記を編集');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill('編集した日記です。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('編集前の日記から生成された漫画です。')).toBeVisible();
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();

  await expect(page.locator('.detail-toolbar')).toContainText('漫画をつくっています');
  await expect(page.locator('.comic')).toBeVisible();
  await expect(page.locator('.detail-date-row time')).toHaveCount(1);
  await expect.poll(() => statusRequests).toBeGreaterThan(0);
  expect(latestGeneration.status).toBe('queued');

  status = 'failed';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading', { name: '日記は保存されています' })).toBeVisible();
  await expect(page.locator('.comic')).toBeVisible();
  await expect(page.getByText('編集前の日記から生成された漫画です。')).toBeVisible();
});

test('ホームで既知の旧漫画と状態取得失敗を別々に案内する', async ({ page }) => {
  const oldSuccess = generationFixtures(entryId, generationId, 1).succeeded;
  const oldFailure = generationFixtures(entryId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1).failed;
  const unavailableId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const editedEntry: Entry = {
    ...draftEntryDetailFixture,
    revision: 2,
    latestGenerationId: oldFailure.id,
  };
  const unavailableEntry: Entry = {
    ...draftEntryDetailFixture,
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    body: '状態確認に失敗した記録です。',
    latestGenerationId: unavailableId,
  };
  const detail: EntryDetail = {
    ...editedEntry,
    latestGeneration: oldFailure,
    lastSuccessfulGeneration: oldSuccess,
  };

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [editedEntry, unavailableEntry], nextCursor: null } }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/entries/${unavailableEntry.id}`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: '一時的に利用できません。',
          requestId: 'fixture-request',
          retryable: true,
        },
      },
    }),
  );
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({ json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' } }),
  );

  await page.goto('/');
  await page.getByRole('heading', { name: '最近の記録' }).scrollIntoViewIfNeeded();
  const oldComicCard = page.locator('.entry-history-card').filter({ hasText: '編集前の漫画' });
  await expect(oldComicCard).toBeVisible();
  await expect(oldComicCard).not.toContainText('生成失敗');
  await expect(oldComicCard.locator('img')).toHaveAttribute('src', '/sample-comic.svg');
  const unavailableCard = page
    .locator('.entry-history-card')
    .filter({ hasText: '状態確認に失敗した記録です。' });
  await expect(unavailableCard).toContainText('状態を確認できません');
});

test('編集後の旧generationが失敗済みなら一覧に編集済みと表示する', async ({ page }) => {
  const oldFailure = generationFixtures(entryId, generationId, 1).failed;
  const editedEntry: Entry = {
    ...draftEntryDetailFixture,
    revision: 2,
    latestGenerationId: oldFailure.id,
  };
  const detail: EntryDetail = { ...editedEntry, latestGeneration: oldFailure };

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [editedEntry], nextCursor: null } }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: detail }));

  await page.goto('/');
  await page.getByRole('heading', { name: '最近の記録' }).scrollIntoViewIfNeeded();
  const card = page.locator('.entry-history-card').filter({ hasText: '編集済み' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('状態を確認しています');
});

test('ホームと一覧で漫画画像の取得失敗を読める', async ({ page }) => {
  const todayGeneration = generationFixtures(entryId, generationId).succeeded;
  const recentEntryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const recentGenerationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const todayEntry: Entry = {
    ...draftEntryDetailFixture,
    diaryDate: jstToday(),
    latestGenerationId: todayGeneration.id,
  };
  const recentEntry: Entry = {
    ...draftEntryDetailFixture,
    id: recentEntryId,
    diaryDate: '2026-01-01',
    body: '画像取得に失敗した最近の記録です。',
    latestGenerationId: recentGenerationId,
  };
  const recentGeneration = generationFixtures(recentEntryId, recentGenerationId).succeeded;
  const details = new Map<string, EntryDetail>([
    [
      todayEntry.id,
      {
        ...todayEntry,
        latestGeneration: todayGeneration,
        lastSuccessfulGeneration: todayGeneration,
      },
    ],
    [
      recentEntry.id,
      {
        ...recentEntry,
        latestGeneration: recentGeneration,
        lastSuccessfulGeneration: recentGeneration,
      },
    ],
  ]);

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [todayEntry, recentEntry], nextCursor: null } }),
  );
  for (const [id, entryDetail] of details) {
    await page.route(`**/api/v1/entries/${id}`, (route) => route.fulfill({ json: entryDetail }));
  }
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: '一時的に利用できません。',
          requestId: 'fixture-image-request',
          retryable: true,
        },
      },
    }),
  );

  await page.goto('/');
  await expect(page.locator('.home-today-content')).toContainText('漫画画像を表示できません。');
  await page.getByRole('heading', { name: '最近の記録' }).scrollIntoViewIfNeeded();
  const recentCard = page.locator('.entry-history-card').filter({ hasText: recentEntry.body });
  await expect(recentCard.locator('.entry-history-preview-error')).toHaveText(
    '漫画画像を表示できません。',
  );
});

test('保存中はヘッダーの編集取消を無効にし、完了後に最新の日記を表示する', async ({ page }) => {
  let currentDetail: EntryDetail = { ...draftEntryDetailFixture };
  let releasePatch!: () => void;
  let notifyPatch!: () => void;
  const patchReceived = new Promise<void>((resolve) => {
    notifyPatch = resolve;
  });
  const patchGate = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: currentDetail });

    const update = route.request().postDataJSON() as {
      expectedRevision: number;
      diaryDate: string;
      body: string;
    };
    notifyPatch();
    await patchGate;
    currentDetail = {
      ...currentDetail,
      diaryDate: update.diaryDate,
      body: update.body,
      revision: 2,
    };
    const updatedEntry: Entry = {
      id: currentDetail.id,
      diaryDate: currentDetail.diaryDate,
      body: currentDetail.body,
      revision: currentDetail.revision,
      latestGenerationId: currentDetail.latestGenerationId,
      createdAt: currentDetail.createdAt,
      updatedAt: '2026-01-03T00:00:00Z',
    };
    return route.fulfill({ json: updatedEntry });
  });

  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const updatedBody = '保存完了後に表示する最新の日記';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(updatedBody);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await patchReceived;

  try {
    await expect(
      page.locator('.detail-edit-toolbar').getByRole('button', { name: '編集をやめる' }),
    ).toBeDisabled();
    await expect(
      page.locator('#edit-entry-form').getByRole('button', { name: '編集をやめる', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    releasePatch();
  }

  await expect(page.locator('.diary')).toHaveText(updatedBody);
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveCount(0);
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
    const menu = await openEntryMenu(page);
    await expect(menu.getByRole('menuitem', { name: '日記を編集' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: '日記を削除' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('編集フォーム表示中に生成状態が後着しても入力と操作を一貫させる', async ({ page }) => {
  let releaseQuota!: () => void;
  let notifyQuota!: () => void;
  const quotaRequested = new Promise<void>((resolve) => {
    notifyQuota = resolve;
  });
  const quotaGate = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  let releasePoll!: () => void;
  let notifyPoll!: () => void;
  const pollRequested = new Promise<void>((resolve) => {
    notifyPoll = resolve;
  });
  const pollGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let generationReads = 0;

  await configureDetail(page);
  await page.route('**/api/v1/me/quota', async (route) => {
    notifyQuota();
    await quotaGate;
    return route.fulfill({
      json: {
        remainingToday: 2,
        activeGenerationId: generationId,
        resetAt: '2099-01-02T00:00:00Z',
        generationAvailable: true,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    generationReads++;
    if (generationReads === 1)
      return route.fulfill({ json: generationFixtures(entryId, generationId).queued });
    if (generationReads === 2) {
      notifyPoll();
      await pollGate;
    }
    return route.fulfill({ json: generationFixtures(entryId, generationId).failed });
  });

  await page.goto(`/entries/${entryId}`);
  await quotaRequested;
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '生成状態が後着しても保つ編集内容';
  await diary.fill(draft);

  releaseQuota();
  await pollRequested;
  await expect(page.locator('#edit-entry-form')).toHaveCount(1);
  await expect(diary).toHaveValue(draft);
  await expect(diary).toBeDisabled();
  await expect(page.locator('.detail-edit-pending-note')).toContainText(
    '生成中のため変更を保存できません',
  );
  await expect(
    page.locator('.detail-edit-toolbar').getByRole('button', { name: '保存', exact: true }),
  ).toBeDisabled();

  releasePoll();
  await expect(diary).toBeEnabled();
  await expect(diary).toHaveValue(draft);
  await expect(
    page.locator('.detail-edit-toolbar').getByRole('button', { name: '保存', exact: true }),
  ).toBeEnabled();
});

test('生成中の編集フォームへ後着エラーを一度だけ表示する', async ({ page }) => {
  let releaseQuota!: () => void;
  let notifyQuota!: () => void;
  const quotaRequested = new Promise<void>((resolve) => {
    notifyQuota = resolve;
  });
  const quotaGate = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  let generationReads = 0;
  let releasePoll!: () => void;
  let notifyPoll!: () => void;
  const pollRequested = new Promise<void>((resolve) => {
    notifyPoll = resolve;
  });
  const pollGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  await configureDetail(page);
  await page.route('**/api/v1/me/quota', async (route) => {
    notifyQuota();
    await quotaGate;
    return route.fulfill({
      json: {
        remainingToday: 2,
        activeGenerationId: generationId,
        resetAt: '2099-01-02T00:00:00Z',
        generationAvailable: true,
      },
    });
  });
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    generationReads++;
    if (generationReads === 1)
      return route.fulfill({ json: generationFixtures(entryId, generationId).queued });
    if (generationReads === 2) {
      notifyPoll();
      await pollGate;
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'backend generation error',
            requestId: 'generation-poll-failure-e2e',
            retryable: true,
          },
        },
      });
    }
    return route.fulfill({ json: generationFixtures(entryId, generationId).queued });
  });

  await page.goto(`/entries/${entryId}`);
  await quotaRequested;
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill('生成状態を確認中に保持する架空の入力');
  releaseQuota();
  await pollRequested;
  await expect(diary).toBeDisabled();
  releasePoll();

  const alert = page.locator('#edit-entry-form [role="alert"]');
  await expect(alert).toContainText('一時的に利用できません');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(alert).toBeFocused();
  await expect(diary).toHaveValue('生成状態を確認中に保持する架空の入力');
  await expect(diary).toBeDisabled();
});

for (const outcome of ['success', 'failure'] as const) {
  test(`保存結果が離脱確認へ${outcome === 'success' ? '成功状態' : '未保存状態'}を反映する`, async ({
    page,
  }) => {
    let currentDetail: EntryDetail = { ...draftEntryDetailFixture };
    let releasePatch!: () => void;
    let notifyPatch!: () => void;
    const patchRequested = new Promise<void>((resolve) => {
      notifyPatch = resolve;
    });
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    await page.route('**/api/v1/config', (route) =>
      route.fulfill({ json: mockClientConfigFixture }),
    );
    await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fulfill({ json: currentDetail });
      const update = route.request().postDataJSON() as {
        diaryDate: string;
        body: string;
      };
      notifyPatch();
      await patchGate;
      if (outcome === 'failure')
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: '保存できませんでした。',
              requestId: 'blocked-save-e2e',
              retryable: true,
            },
          },
        });
      currentDetail = {
        ...currentDetail,
        ...update,
        revision: 2,
      };
      return route.fulfill({
        json: {
          id: currentDetail.id,
          diaryDate: currentDetail.diaryDate,
          body: currentDetail.body,
          revision: currentDetail.revision,
          latestGenerationId: currentDetail.latestGenerationId,
          createdAt: currentDetail.createdAt,
          updatedAt: '2026-01-03T00:00:00Z',
        } satisfies Entry,
      });
    });

    await page.goto(`/entries/${entryId}`);
    await clickEntryMenuItem(page, '日記を編集');
    const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
    const draft = `離脱確認中に保存${outcome}`;
    await diary.fill(draft);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await patchRequested;
    await page.getByRole('link', { name: '記録', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '処理中です' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('保存に失敗すると');
    await expect(dialog.getByRole('button', { name: '移動する' })).toBeVisible();

    releasePatch();
    if (outcome === 'success') {
      await expect(page).toHaveURL(/\/library(?:\?|$)/);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      const dirtyDialog = page.getByRole('dialog', {
        name: '入力内容が保存されていません',
      });
      await expect(dirtyDialog).toBeVisible();
      await expect(dirtyDialog.getByRole('button', { name: '保存せずに離れる' })).toBeVisible();
      await expect(diary).toHaveValue(draft);
      await clickAppDialogButton(page, '入力内容が保存されていません', '入力に戻る');
      await expect(diary).toHaveValue(draft);
      await page.getByRole('link', { name: '記録', exact: true }).click();
      await clickAppDialogButton(page, '入力内容が保存されていません', '保存せずに離れる');
      await expect(page).toHaveURL(/\/library(?:\?|$)/);
    }
  });
}

for (const failure of [
  { status: 401, code: 'AUTH_EXPIRED', mode: 'live' as const },
  { status: 409, code: 'REVISION_CONFLICT', mode: 'mock' as const },
  { status: 503, code: 'DEPENDENCY_UNAVAILABLE', mode: 'mock' as const },
]) {
  test(`${failure.status}保存失敗後も編集中の入力を保持する`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
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
    await clickEntryMenuItem(page, '日記を編集');
    const draft = '失敗しても画面に残す架空の入力';
    await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(draft);
    await page.getByRole('button', { name: '保存', exact: true }).click();

    const errorAlert = page.getByRole('alert');
    await expect(errorAlert).toContainText(
      failure.status === 401
        ? '匿名セッションを確認できません。'
        : failure.code === 'REVISION_CONFLICT'
          ? '記録が更新されています。最新の内容を読み込んでから操作してください。'
          : '一時的に利用できません。時間をおいて再操作してください。',
    );
    await expect(errorAlert).toBeFocused();
    await expect(errorAlert).toBeInViewport();
    const alertBottom = await errorAlert.evaluate(
      (element) => element.getBoundingClientRect().bottom,
    );
    const navigationTop = await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(alertBottom).toBeLessThanOrEqual(navigationTop);
    await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(draft);
  });
}

test('同じ入力エラーを再試行しても再びalertへfocusして本文を保持する', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  let patchCount = 0;
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (route.request().method() === 'PATCH') {
      patchCount++;
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: 'UNEXPECTED_PATCH',
            message: 'validation error must prevent PATCH',
            requestId: 'validation-focus-e2e',
            retryable: false,
          },
        },
      });
    }
    return route.fulfill({ json: draftEntryDetailFixture });
  });

  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const invalidBody = '   ';
  const errorText = '日付は今日以前、本文は1〜1,000文字で入力してください。';
  await diary.fill(invalidBody);

  const errorAlert = page.getByRole('alert');
  const expectVisibleErrorAboveNavigation = async () => {
    await expect(errorAlert).toContainText(errorText);
    await expect(errorAlert).toBeFocused();
    await expect(errorAlert).toBeInViewport();
    const alertBottom = await errorAlert.evaluate(
      (element) => element.getBoundingClientRect().bottom,
    );
    const navigationTop = await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(alertBottom).toBeLessThanOrEqual(navigationTop);
  };

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expectVisibleErrorAboveNavigation();
  await expect(diary).toHaveValue(invalidBody);
  expect(patchCount).toBe(0);

  await diary.focus();
  await expect(diary).toBeFocused();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expectVisibleErrorAboveNavigation();
  await expect(diary).toHaveValue(invalidBody);
  expect(patchCount).toBe(0);
});

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
  await clickEntryMenuItem(page, '日記を編集');
  const draft = '別タブに上書きされない入力';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '最新の記録を読み込む' })).toBeVisible();
  const initialReads = getCount;
  expect(initialReads).toBeGreaterThan(0);

  const conflictDialogTitle = '最新の記録を読み込みますか？';
  await page
    .locator('#edit-entry-form')
    .getByRole('button', { name: '最新の記録を読み込む', exact: true })
    .click();
  await clickAppDialogButton(page, conflictDialogTitle, '編集に戻る');
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(draft);
  expect(getCount).toBe(initialReads);

  await page
    .locator('#edit-entry-form')
    .getByRole('button', { name: '最新の記録を読み込む', exact: true })
    .click();
  await clickAppDialogButton(page, conflictDialogTitle, '最新の記録を読み込む');
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(latest.body);
  expect(getCount).toBe(initialReads + 1);
});

test('409後にcleanな入力で最新記録の再読込が失敗したら保留中の移動を取り消す', async ({ page }) => {
  let patchAttempted = false;
  let releaseLatestRead!: () => void;
  let notifyLatestRead!: () => void;
  const latestReadRequested = new Promise<void>((resolve) => {
    notifyLatestRead = resolve;
  });
  const latestReadGate = new Promise<void>((resolve) => {
    releaseLatestRead = resolve;
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      patchAttempted = true;
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'REVISION_CONFLICT',
            message: '別の画面で変更されています。',
            requestId: 'entry-reload-failure-conflict-e2e',
            retryable: false,
          },
        },
      });
    }
    if (!patchAttempted) return route.fulfill({ json: draftEntryDetailFixture });
    notifyLatestRead();
    await latestReadGate;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: '最新の記録を読み込めませんでした。',
          requestId: 'entry-reload-failure-e2e',
          retryable: true,
        },
      },
    });
  });

  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill('競合した架空の日記');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '最新の記録を読み込む' })).toBeVisible();

  await diary.fill(draftEntryDetailFixture.body);
  await page
    .locator('#edit-entry-form')
    .getByRole('button', { name: '最新の記録を読み込む', exact: true })
    .click();
  await latestReadRequested;
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseLatestRead();

  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.locator('#edit-entry-form [role="alert"]')).toContainText(
    '一時的に利用できません',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(diary).toHaveValue(draftEntryDetailFixture.body);
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
  await clickEntryMenuItem(page, '日記を編集');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('生成競合後も保持する架空の日記');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '最新の記録を読み込む' })).toBeVisible();

  await page
    .locator('#edit-entry-form')
    .getByRole('button', { name: '最新の記録を読み込む', exact: true })
    .click();
  await clickAppDialogButton(page, '最新の記録を読み込みますか？', '最新の記録を読み込む');
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  const menu = await openEntryMenu(page);
  await expect(menu.getByRole('menuitem', { name: '日記を編集' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '日記を削除' })).toBeVisible();
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveCount(0);
});

test('生成受付の409後に最新状態が進行中なら受付エラーを解除する', async ({ page }) => {
  const queued = generationFixtures(entryId, generationId, 1).queued;
  const running = generationFixtures(entryId, generationId, 1).running;
  const succeeded = generationFixtures(entryId, generationId, 1).succeeded;
  const latest: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: queued,
  };
  let entryReads = 0;
  let generationReads = 0;
  let generationSubmitted = false;
  let releaseFirstPoll!: () => void;
  let notifyFirstPoll!: () => void;
  let releaseTerminalPoll!: () => void;
  let notifyTerminalPoll!: () => void;
  const firstPollGate = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });
  const firstPollRequested = new Promise<void>((resolve) => {
    notifyFirstPoll = resolve;
  });
  const terminalPollGate = new Promise<void>((resolve) => {
    releaseTerminalPoll = resolve;
  });
  const terminalPollRequested = new Promise<void>((resolve) => {
    notifyTerminalPoll = resolve;
  });
  await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries/*/generations', (route) => {
    generationSubmitted = true;
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'ENTRY_BUSY',
          message: 'この記録はすでに生成中です。',
          requestId: 'e2e-entry-busy',
          retryable: false,
        },
      },
    });
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    entryReads++;
    return route.fulfill({ json: generationSubmitted ? latest : draftEntryDetailFixture });
  });
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    generationReads++;
    if (generationReads === 1) {
      notifyFirstPoll();
      await firstPollGate;
      return route.fulfill({ json: running });
    }
    notifyTerminalPoll();
    await terminalPollGate;
    return route.fulfill({ json: succeeded });
  });
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({ json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00Z' } }),
  );

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();

  await firstPollRequested;
  releaseFirstPoll();
  await expect(page.getByRole('heading', { name: '画像を描いています' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const advancePolling = page.clock.runFor(5100);
  await terminalPollRequested;
  releaseTerminalPoll();
  await advancePolling;
  await expect(page.getByRole('heading', { name: succeeded.comic.title })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(entryReads).toBeGreaterThanOrEqual(2);
  expect(generationReads).toBeGreaterThanOrEqual(2);
});

test('未来日は保存せず、日付と本文を保持する', async ({ page }) => {
  let patchCount = 0;
  await configureDetail(page);
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (route.request().method() === 'PATCH') patchCount++;
    return route.fulfill({ json: draftEntryDetailFixture });
  });
  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const date = page.getByLabel('日付', { exact: true });
  const today = (await date.getAttribute('max')) ?? '2026-11-03';
  const future = nextDate(today);
  await date.fill(future);
  const draft = '未来の日付では保存しない架空の日記';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(date).toHaveValue(future);
  expect(await date.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(
    true,
  );
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(draft);
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
  await expectDefaultLibraryLocation(page);

  await configureDetail(page);
  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill('いったん変えて元に戻す');
  await diary.fill(draftEntryDetailFixture.body);
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expectDefaultLibraryLocation(page);
  expect(dialogCount).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('未保存確認はモーダルとして背景のフォーカスを止め、Escapeで入力に戻る', async ({ page }) => {
  await page.goto('/new');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = 'Escape後も残す架空の日記';
  await diary.fill(draft);

  const recordLink = page.getByRole('link', { name: '記録', exact: true });
  await recordLink.click();
  const title = '入力内容が保存されていません';
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  const actionSizes = await dialog.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const { width, height } = button.getBoundingClientRect();
      return [Math.round(width * 10) / 10, Math.round(height * 10) / 10];
    }),
  );
  expect(actionSizes[0]).toEqual(actionSizes[1]);
  expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  await recordLink.focus();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/new$/);
  await expect(diary).toHaveValue(draft);

  await recordLink.click();
  await clickAppDialogButton(page, title, '保存せずに離れる');
  await expectDefaultLibraryLocation(page);
});

test('アプリ内リンクと戻る/進むの確認を取り消した場合は入力が残る', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '日記を書く', exact: true }).first().click();
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '確認を取り消しても残す架空の日記';
  await diary.fill(draft);

  await navigateThroughAppDialog(
    page,
    () => page.getByRole('link', { name: '記録', exact: true }).click(),
    '入力内容が保存されていません',
    '入力に戻る',
  );
  await expect(page).toHaveURL(/\/new$/);
  await expect(diary).toHaveValue(draft);

  await navigateThroughAppDialog(
    page,
    () => page.goBack(),
    '入力内容が保存されていません',
    '入力に戻る',
  );
  await expect(page).toHaveURL(/\/new$/);
  await expect(diary).toHaveValue(draft);

  await navigateThroughAppDialog(
    page,
    () => page.goBack(),
    '入力内容が保存されていません',
    '保存せずに離れる',
  );
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/new$/);
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expectDefaultLibraryLocation(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/new$/);
  const forwardDraft = '進む操作でも確認する架空の日記';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(forwardDraft);

  await navigateThroughAppDialog(
    page,
    () => page.goForward(),
    '入力内容が保存されていません',
    '入力に戻る',
  );
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(
    forwardDraft,
  );

  await navigateThroughAppDialog(
    page,
    () => page.goForward(),
    '入力内容が保存されていません',
    '保存せずに離れる',
  );
  await expectDefaultLibraryLocation(page);
});

test('詳細編集の未保存入力はアプリ内移動とhard reload前に確認する', async ({ page }) => {
  await configureDetail(page);
  await page.goto(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  const draft = '詳細編集で保護する架空の日記';
  await diary.fill(draft);

  await navigateThroughAppDialog(
    page,
    () => page.getByRole('link', { name: '記録', exact: true }).click(),
    '入力内容が保存されていません',
    '入力に戻る',
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
  const menu = await openEntryMenu(page);
  await expect(menu.getByRole('menuitem', { name: '日記を編集' })).toBeVisible();
  await expect(page.getByText(draft, { exact: true })).toHaveCount(0);
});

test('保存中に選んだ一覧への移動を保存完了後も維持する', async ({ page }) => {
  const savedEntry: Entry = {
    id: entryId,
    diaryDate: jstToday(),
    body: '一覧への移動を維持する架空の日記',
    revision: 1,
    latestGenerationId: null,
    createdAt: draftEntryDetailFixture.createdAt,
    updatedAt: draftEntryDetailFixture.updatedAt,
  };
  let releasePost!: () => void;
  let notifyPost!: () => void;
  const postRequested = new Promise<void>((resolve) => {
    notifyPost = resolve;
  });
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    notifyPost();
    await postGate;
    return route.fulfill({ status: 201, json: savedEntry });
  });
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [savedEntry], nextCursor: null } }),
  );

  await page.goto('/new');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(savedEntry.body);
  await page.getByRole('button', { name: '下書き保存' }).click();
  await postRequested;
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();

  releasePost();
  await expectDefaultLibraryLocation(page);
  await expect(page.locator('.entry-history-card').first()).toContainText(savedEntry.body);
});

test('保存済み日記の漫画受付が失敗したら保留中の移動を取り消す', async ({ page }) => {
  const savedEntry: Entry = {
    id: entryId,
    diaryDate: draftEntryDetailFixture.diaryDate,
    body: '受付失敗後も画面に残す架空の日記',
    revision: 1,
    latestGenerationId: null,
    createdAt: draftEntryDetailFixture.createdAt,
    updatedAt: draftEntryDetailFixture.updatedAt,
  };
  let releaseGeneration!: () => void;
  let notifyGeneration!: () => void;
  const generationRequested = new Promise<void>((resolve) => {
    notifyGeneration = resolve;
  });
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: savedEntry })
      : route.continue(),
  );
  await page.route('**/api/v1/entries/*/generations', async (route) => {
    notifyGeneration();
    await generationGate;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend generation error',
          requestId: 'generation-failure-e2e',
          retryable: true,
        },
      },
    });
  });

  await page.goto('/new');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill(savedEntry.body);
  await page.getByRole('button', { name: '4コマにする' }).click();
  await generationRequested;
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseGeneration();

  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(diary).toHaveValue(savedEntry.body);
  await expect(page.getByRole('alert')).toContainText('一時的に利用できません');
  await expect(page.getByRole('heading', { name: '日記を保存しました' })).toBeVisible();
});

test('保存後に利用枠がなくなった場合も保存済み記録への導線を表示する', async ({ page }) => {
  const savedEntry: Entry = {
    id: entryId,
    diaryDate: jstToday(),
    body: '保存後の利用枠再確認で案内する架空の日記',
    revision: 1,
    latestGenerationId: null,
    createdAt: draftEntryDetailFixture.createdAt,
    updatedAt: draftEntryDetailFixture.updatedAt,
  };
  let entryPosted = false;
  let releaseQuota!: () => void;
  let notifyQuota!: () => void;
  const quotaRequested = new Promise<void>((resolve) => {
    notifyQuota = resolve;
  });
  const quotaGate = new Promise<void>((resolve) => {
    releaseQuota = resolve;
  });
  let generationPosts = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/me/quota', async (route) => {
    if (entryPosted) {
      notifyQuota();
      await quotaGate;
      return route.fulfill({
        json: {
          remainingToday: 0,
          activeGenerationId: null,
          resetAt: '2099-01-02T00:00:00Z',
          generationAvailable: true,
        },
      });
    }
    return route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: '2099-01-02T00:00:00Z',
        generationAvailable: true,
      },
    });
  });
  await page.route('**/api/v1/entries', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    entryPosted = true;
    return route.fulfill({ status: 201, json: savedEntry });
  });
  await page.route('**/api/v1/entries/*/generations', (route) => {
    if (route.request().method() === 'POST') generationPosts++;
    return route.fulfill({ status: 500, json: {} });
  });

  await page.goto('/new');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill(savedEntry.body);
  await expect(page.getByRole('button', { name: '4コマにする', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();
  await quotaRequested;
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseQuota();

  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '日記を保存しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: '保存した記録を見る' })).toHaveAttribute(
    'href',
    `/entries/${entryId}`,
  );
  await expect(diary).toHaveValue(savedEntry.body);
  expect(generationPosts).toBe(0);
});

test('削除成功後も処理中に選んだ戻る操作を維持する', async ({ page }) => {
  const listEntry: Entry = { ...draftEntryDetailFixture, diaryDate: jstToday() };
  let releaseDelete!: () => void;
  let notifyDelete!: () => void;
  const deleteRequested = new Promise<void>((resolve) => {
    notifyDelete = resolve;
  });
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [listEntry], nextCursor: null } }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'DELETE')
      return route.fulfill({ json: draftEntryDetailFixture });
    notifyDelete();
    await deleteGate;
    return route.fulfill({ json: { deleted: true } });
  });

  await page.goto('/');
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expectDefaultLibraryLocation(page);
  await page.locator('.entry-history-card').first().click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を削除');
  const confirmDelete = clickAppDialogButton(page, 'この日記を削除しますか？', '削除する');
  await deleteRequested;
  await confirmDelete;

  void page.goBack().catch(() => null);
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseDelete();
  await expectDefaultLibraryLocation(page);
});

test('削除中のpollingエラーで保留中の移動を取り消さない', async ({ page }) => {
  const listEntry: Entry = { ...draftEntryDetailFixture, diaryDate: jstToday() };
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: generationFixtures(entryId, generationId).queued,
  };
  let generationReads = 0;
  let releasePoll!: () => void;
  let notifyPoll!: () => void;
  const pollRequested = new Promise<void>((resolve) => {
    notifyPoll = resolve;
  });
  const pollGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let releaseDelete!: () => void;
  let notifyDelete!: () => void;
  const deleteRequested = new Promise<void>((resolve) => {
    notifyDelete = resolve;
  });
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  await configureDetail(page, detail);
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [listEntry], nextCursor: null } }),
  );
  await page.route(`**/api/v1/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fulfill({ json: detail });
    notifyDelete();
    await deleteGate;
    return route.fulfill({ json: { deleted: true } });
  });
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    generationReads++;
    if (generationReads === 2) {
      notifyPoll();
      await pollGate;
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'backend polling error',
            requestId: 'delete-polling-error-e2e',
            retryable: true,
          },
        },
      });
    }
    return route.fulfill({ json: detail.latestGeneration });
  });

  await page.goto('/');
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expectDefaultLibraryLocation(page);
  await page.locator('.entry-history-card').first().click();
  await expect(page.getByRole('heading', { name: '漫画をつくっています' })).toBeVisible();
  await pollRequested;
  await clickEntryMenuItem(page, '日記を削除');
  const confirmDelete = clickAppDialogButton(page, 'この日記を削除しますか？', '削除する');
  await deleteRequested;
  await confirmDelete;

  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  const busyDialog = page.getByRole('dialog', { name: '処理中です' });
  await expect(busyDialog).toBeVisible();
  releasePoll();
  await expect(page.locator('.detail-page [role="alert"]')).toContainText('一時的に利用できません');
  await expect(busyDialog).toBeVisible();
  releaseDelete();

  await expect(page).toHaveURL('/');
});

test('状態確認後の生成補完GET失敗で保留中の移動を取り消す', async ({ page }) => {
  const detail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: null,
  };
  let releaseGenerationLookup!: () => void;
  let notifyGenerationLookup!: () => void;
  const generationLookupRequested = new Promise<void>((resolve) => {
    notifyGenerationLookup = resolve;
  });
  const generationLookupGate = new Promise<void>((resolve) => {
    releaseGenerationLookup = resolve;
  });
  let generationLookups = 0;
  let entryReads = 0;

  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    generationLookups++;
    if (generationLookups > 1) {
      notifyGenerationLookup();
      await generationLookupGate;
    }
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend generation lookup error',
          requestId: 'generation-reference-unavailable-e2e',
          retryable: true,
        },
      },
    });
  });
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    entryReads++;
    return route.fulfill({ json: detail });
  });

  await page.goto(`/entries/${entryId}`);
  await expect(page.getByRole('heading', { name: '漫画の状態を確認できません' })).toBeVisible();
  await page.getByRole('button', { name: '状態を再確認する' }).click();
  await generationLookupRequested;
  expect(entryReads).toBeGreaterThan(1);
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseGenerationLookup();

  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.locator('.detail-page p[role="alert"]')).toContainText(
    '一時的に利用できません',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('受付後の生成補完GET失敗で保留中の移動を取り消し、受付再確認を残す', async ({ page }) => {
  const acceptedDetail: EntryDetail = {
    ...draftEntryDetailFixture,
    latestGenerationId: generationId,
    latestGeneration: null,
  };
  let releaseGenerationLookup!: () => void;
  let notifyGenerationLookup!: () => void;
  const generationLookupRequested = new Promise<void>((resolve) => {
    notifyGenerationLookup = resolve;
  });
  const generationLookupGate = new Promise<void>((resolve) => {
    releaseGenerationLookup = resolve;
  });
  let receiptAccepted = false;
  let entryReadsAfterReceipt = 0;
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
  await page.route(`**/api/v1/entries/${entryId}`, (route) => {
    if (!receiptAccepted) return route.fulfill({ json: draftEntryDetailFixture });
    entryReadsAfterReceipt++;
    return route.fulfill({ json: acceptedDetail });
  });
  await page.route(`**/api/v1/generations/${generationId}`, async (route) => {
    notifyGenerationLookup();
    await generationLookupGate;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'backend generation lookup error',
          requestId: 'generation-receipt-reference-error-e2e',
          retryable: true,
        },
      },
    });
  });
  await page.route(`**/api/v1/entries/${entryId}/generations`, (route) => {
    receiptAccepted = true;
    return route.fulfill({
      status: 202,
      json: {
        generationId,
        status: 'queued',
        statusUrl: `/api/v1/generations/${generationId}`,
      },
    });
  });

  await page.goto(`/entries/${entryId}`);
  await page.getByRole('button', { name: '4コマにする', exact: true }).click();
  await generationLookupRequested;
  expect(entryReadsAfterReceipt).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'ホーム', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseGenerationLookup();

  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.locator('.detail-page [role="alert"]')).toContainText(
    '受付結果を受け取りましたが、状態を読み込めません。受付結果を再確認してください。',
  );
  await expect(page.getByRole('button', { name: '受付結果を確認', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('削除失敗時は保留中の移動を取り消してエラーを残す', async ({ page }) => {
  const listEntry: Entry = { ...draftEntryDetailFixture, diaryDate: jstToday() };
  let releaseDelete!: () => void;
  let notifyDelete!: () => void;
  const deleteRequested = new Promise<void>((resolve) => {
    notifyDelete = resolve;
  });
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  await configureDetail(page);
  await page.route('**/api/v1/entries?*', (route) =>
    route.fulfill({ json: { items: [listEntry], nextCursor: null } }),
  );
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
          message: '削除できませんでした。',
          requestId: 'delete-failure-e2e',
          retryable: true,
        },
      },
    });
  });

  await page.goto('/');
  await page.getByRole('link', { name: '記録', exact: true }).click();
  await expectDefaultLibraryLocation(page);
  await page.locator('.entry-history-card').first().click();
  await expect(page).toHaveURL(`/entries/${entryId}`);
  await clickEntryMenuItem(page, '日記を削除');
  const confirmDelete = clickAppDialogButton(page, 'この日記を削除しますか？', '削除する');
  await deleteRequested;
  await confirmDelete;
  void page.goBack().catch(() => null);
  await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
  releaseDelete();

  await expect(page).toHaveURL(`/entries/${entryId}`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('一時的に利用できません');
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
    await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(draft);
    await page.getByRole('button', { name: '下書き保存' }).click();
    await started;
    await expect(page.getByRole('button', { name: '保存しています…' })).toBeDisabled();

    await navigateThroughAppDialog(
      page,
      () => page.getByRole('link', { name: '記録', exact: true }).click(),
      '処理中です',
      accept ? '移動する' : '入力に戻る',
    );
    if (accept) await expectDefaultLibraryLocation(page);
    else {
      await expect(page).toHaveURL(/\/new$/);
      await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toHaveValue(draft);
    }

    releaseRequest();
    if (accept) await expectDefaultLibraryLocation(page);
    else await expect(page).toHaveURL(/\/entries\//);
  });
}

test('削除応答後に別記録を編集中なら新しい画面の状態を維持する', async ({ page }) => {
  await page.goto('/new');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill('削除応答を待つAの記録');
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  const firstId = new URL(page.url()).pathname.split('/').at(-1);
  expect(firstId).toBeTruthy();

  await page.goto('/new');
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill('編集中に保護するBの記録');
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
  await clickEntryMenuItem(page, '日記を削除');
  const deleteDialogTitle = 'この日記を削除しますか？';
  const confirmDelete = clickAppDialogButton(page, deleteDialogTitle, '削除する');
  await deletionStarted;
  await confirmDelete;

  await navigateThroughAppDialog(
    page,
    () => page.getByRole('link', { name: '記録の一覧へ戻る' }).click(),
    '処理中です',
    '移動する',
  );
  await expectDefaultLibraryLocation(page);
  await page
    .getByRole('tabpanel', { name: 'カレンダー' })
    .getByRole('link', { name: /編集中に保護するBの記録/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/entries/${secondId}$`));
  await clickEntryMenuItem(page, '日記を編集');
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
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
  await navigateThroughAppDialog(
    page,
    () => page.getByRole('link', { name: '記録', exact: true }).click(),
    '入力内容が保存されていません',
    '入力に戻る',
  );
  await expect(page).toHaveURL(new RegExp(`/entries/${secondId}$`));
  await expect(diary).toHaveValue(editedBody);
});

for (const leaveBeforeReceipt of [false, true]) {
  test(`漫画受付中の移動で${leaveBeforeReceipt ? '結果未確定を通知し再受付を促さない' : '受付済みを通知して保存した記録へ案内する'}`, async ({
    page,
  }) => {
    let releaseGeneration!: () => void;
    let notifyGeneration!: () => void;
    const generationRequested = new Promise<void>((resolve) => {
      notifyGeneration = resolve;
    });
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let generationPosts = 0;
    const generation = generationFixtures(entryId, generationId).queued;
    await page.route('**/api/v1/config', (route) =>
      route.fulfill({ json: mockClientConfigFixture }),
    );
    await page.route('**/api/v1/entries', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 201, json: draftEntryDetailFixture })
        : route.continue(),
    );
    await page.route('**/api/v1/entries?*', (route) =>
      route.fulfill({ json: { items: [draftEntryDetailFixture], nextCursor: null } }),
    );
    await page.route(`**/api/v1/entries/${entryId}`, (route) =>
      route.fulfill({
        json: {
          ...draftEntryDetailFixture,
          latestGenerationId: generationId,
          latestGeneration: generation,
        },
      }),
    );
    await page.route(`**/api/v1/generations/${generationId}`, (route) =>
      route.fulfill({ json: generation }),
    );
    await page.route(`**/api/v1/entries/${entryId}/generations`, async (route) => {
      generationPosts++;
      notifyGeneration();
      await generationGate;
      return route.fulfill({
        status: 202,
        json: { generationId, status: 'queued', statusUrl: `/api/v1/generations/${generationId}` },
      });
    });
    await page.goto('/new');
    await page
      .getByLabel('今日はどんな日だった？', { exact: true })
      .fill('受付結果の通知を確認する架空の日記');
    await page.getByRole('button', { name: '4コマにする', exact: true }).click();
    await generationRequested;
    await page.getByRole('link', { name: '記録', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '処理中です' })).toBeVisible();
    if (leaveBeforeReceipt) {
      await clickAppDialogButton(page, '処理中です', '移動する');
      await expectDefaultLibraryLocation(page);
      await expect(page.locator('.app-notices').getByRole('status')).toContainText(
        '漫画の受付結果が未確定です。',
      );
      releaseGeneration();
    } else {
      releaseGeneration();
      await expectDefaultLibraryLocation(page);
      await expect(page.locator('.app-notices').getByRole('status')).toContainText(
        '日記を保存し、漫画を受け付けました。',
      );
    }
    await expect(page.getByRole('link', { name: '漫画の受付を続ける' })).toHaveCount(0);
    await page.getByRole('link', { name: '記録で確認する' }).click();
    await expect(page).toHaveURL(`/entries/${entryId}`);
    await expect(page.getByRole('heading', { name: '受付済み', exact: true })).toBeVisible();
    expect(generationPosts).toBe(1);
  });
}
