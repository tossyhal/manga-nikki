import { expect, test, type Page } from '@playwright/test';
import type { Entry } from '../src/shared/schemas';
import { jstToday } from '../src/shared/schemas';
import { draftEntryDetailFixture, mockClientConfigFixture } from './fixtures/client-config';

function makeEntry(index: number, diaryDate: string, body: string): Entry {
  return {
    id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    diaryDate,
    body,
    revision: 1,
    latestGenerationId: null,
    createdAt: `${diaryDate}T12:00:00.000Z`,
    updatedAt: `${diaryDate}T12:00:00.000Z`,
  };
}

function parts(value: string) {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
}

function monthKey(value: string) {
  return value.slice(0, 7);
}

function shiftMonth(value: string, amount: number) {
  const { year, month } = parts(`${value}-01`);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftDay(value: string, amount: number) {
  const { year, month, day } = parts(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function dateLabel(value: string) {
  const { year, month, day } = parts(value);
  return `${year}年${month}月${day}日`;
}

async function useMockConfig(page: Page) {
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
}

test('同じ日の21件目まで取得して、正確な件数と記録を表示する', async ({ page }) => {
  const today = jstToday();
  const firstPage = Array.from({ length: 20 }, (_, index) =>
    makeEntry(
      100 - index,
      today,
      index === 0 ? '同日の最初の架空日記' : `同日に記録した架空日記${index + 1}`,
    ),
  );
  const requestedCursors: string[] = [];
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor') ?? '';
    requestedCursors.push(cursor);
    return route.fulfill({
      json: cursor
        ? { items: [makeEntry(80, today, '同日に記録した21件目の架空日記')], nextCursor: null }
        : { items: firstPage, nextCursor: 'fixture-cursor-20' },
    });
  });

  await page.goto('/library');

  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  const { month, day } = parts(today);
  const selectedDayHeading = calendarPanel.locator('.library-day-heading');
  await expect(selectedDayHeading).toBeVisible();
  await expect(selectedDayHeading).toContainText(`${month}月${day}日`);
  await expect(selectedDayHeading).toContainText('21件');
  const dayControls = calendarPanel.getByRole('navigation', { name: '選択日の記録のページ送り' });
  const daySummaries = calendarPanel.locator('.entry-history-summary');
  const visibleSummaries = new Set<string>();
  for (let index = 0; index < 11; index++) {
    await expect(dayControls).toContainText(`${index + 1}ページ目`);
    const summaries = await daySummaries.allTextContents();
    expect(summaries).toHaveLength(index < 10 ? 2 : 1);
    summaries.forEach((summary) => visibleSummaries.add(summary));
    if (index < 10) await dayControls.getByRole('button', { name: '次へ' }).click();
  }
  await expect(page.getByRole('button', { name: `${dateLabel(today)}、記録21件` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(visibleSummaries.size).toBe(21);
  expect(visibleSummaries).toContain('同日の最初の架空日記');
  expect(visibleSummaries).toContain('同日に記録した21件目の架空日記');
  expect(requestedCursors.filter(Boolean)).toEqual(['fixture-cursor-20']);
  await expect(dayControls).toContainText('11ページ目');
  await expect(dayControls.getByRole('button', { name: '次へ' })).toBeDisabled();
  await dayControls.getByRole('button', { name: '前へ' }).click();
  await expect(dayControls).toContainText('10ページ目');
  for (let index = 0; index < 9; index++) {
    await dayControls.getByRole('button', { name: '前へ' }).click();
  }
  await expect(dayControls).toContainText('1ページ目');
  await expect(calendarPanel.getByRole('link', { name: /同日の最初の架空日記/ })).toBeVisible();
});

test('カレンダーの月範囲を確定し、一覧の続きをカーソルで取得する', async ({ page }) => {
  const today = jstToday();
  const previousMonth = shiftMonth(monthKey(today), -1);
  const lastDayOfPreviousMonth = new Date(
    Date.UTC(parts(`${previousMonth}-01`).year, parts(`${previousMonth}-01`).month, 0),
  ).getUTCDate();
  const previousMonthEnd = `${previousMonth}-${String(lastDayOfPreviousMonth).padStart(2, '0')}`;
  const firstPage = [
    makeEntry(1, today, '今月に書いた架空日記'),
    ...Array.from({ length: 19 }, (_, index) =>
      makeEntry(20 - index, previousMonthEnd, `先月の架空日記${index + 1}`),
    ),
  ];
  const nextPage = [makeEntry(21, `${previousMonth}-01`, 'ページをまたいだ架空日記')];
  const requestedCursors: string[] = [];

  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor') ?? '';
    requestedCursors.push(cursor);
    return route.fulfill({
      json: cursor
        ? { items: nextPage, nextCursor: null }
        : { items: firstPage, nextCursor: 'fixture-cursor-20' },
    });
  });

  await page.goto('/library');
  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  await expect(calendarPanel.getByRole('link', { name: /今月に書いた架空日記/ })).toBeVisible();
  await expect(
    calendarPanel.getByRole('heading', {
      name: `${parts(today).year}年${parts(today).month}月`,
    }),
  ).toBeVisible();
  expect(requestedCursors.filter(Boolean)).toEqual([]);

  await page.getByRole('tab', { name: 'リスト' }).click();
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  const listControls = listPanel.getByRole('navigation', { name: '記録一覧のページ送り' });
  const listSummaries = listPanel.locator('.entry-history-summary');
  for (let index = 0; index < 6; index++) {
    await listControls.getByRole('button', { name: '次へ' }).click();
  }
  await expect(listControls).toContainText('7ページ目');
  await expect(listSummaries).toHaveText([
    '先月の架空日記18',
    '先月の架空日記19',
    'ページをまたいだ架空日記',
  ]);
  await expect(listPanel.getByRole('link', { name: /ページをまたいだ架空日記/ })).toBeVisible();
  await expect(listControls.getByRole('button', { name: '次へ' })).toBeDisabled();
  expect(requestedCursors.filter(Boolean)).toEqual(['fixture-cursor-20']);
  await listControls.getByRole('button', { name: '前へ' }).click();
  await expect(listControls).toContainText('6ページ目');
  await expect(listSummaries).toHaveText([
    '先月の架空日記15',
    '先月の架空日記16',
    '先月の架空日記17',
  ]);
});

test('一覧のカーソル取得中にカレンダーへ切り替えても表示とURLを保つ', async ({ page }) => {
  const today = jstToday();
  const previousMonth = shiftMonth(monthKey(today), -1);
  const firstPage = Array.from({ length: 20 }, (_, index) =>
    makeEntry(
      100 - index,
      index === 19 ? `${previousMonth}-01` : today,
      `切替確認用の架空日記${index + 1}`,
    ),
  );
  let releaseCursor!: () => void;
  let signalCursorRequest!: () => void;
  const cursorGate = new Promise<void>((resolve) => {
    releaseCursor = resolve;
  });
  const cursorRequested = new Promise<void>((resolve) => {
    signalCursorRequest = resolve;
  });
  const cursorRequests: string[] = [];

  await useMockConfig(page);
  await page.route('**/api/v1/entries**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor)
      return route.fulfill({
        json: { items: firstPage, nextCursor: 'fixture-cursor-20' },
      });

    cursorRequests.push(cursor);
    signalCursorRequest();
    await cursorGate;
    return route.fulfill({
      json: {
        items: [makeEntry(80, `${previousMonth}-01`, 'カーソル取得後の架空日記')],
        nextCursor: null,
      },
    });
  });

  await page.goto(`/library?view=list&month=${monthKey(today)}&day=${today}&listPage=6&dayPage=1`);
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  const listControls = listPanel.getByRole('navigation', { name: '記録一覧のページ送り' });
  await expect(listControls).toContainText('6ページ目');
  const nextPage = listControls.getByRole('button', { name: '次へ' });
  await expect(nextPage).toBeEnabled();

  const cursorResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/entries' && url.searchParams.has('cursor');
  });
  const calendarTab = page.getByRole('tab', { name: 'カレンダー' });
  try {
    await nextPage.click();
    await cursorRequested;
    await calendarTab.click();
    await expect(calendarTab).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('calendar');
  } finally {
    releaseCursor();
  }
  await cursorResponse;
  await expect(calendarTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('calendar');
  await expect(listPanel).toBeHidden();
  expect(cursorRequests).toEqual(['fixture-cursor-20']);
});

test('記録表示タブはtabとtabpanelを結び、矢印・Home・Endで操作できる', async ({ page }) => {
  const today = jstToday();
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({ json: { items: [makeEntry(1, today, '今日の架空日記')], nextCursor: null } }),
  );

  await page.goto('/library');
  const tabs = page.getByRole('tablist', { name: '記録の表示方法' });
  const calendarTab = tabs.getByRole('tab', { name: 'カレンダー' });
  const listTab = tabs.getByRole('tab', { name: 'リスト' });
  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });

  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(calendarTab).toHaveAttribute('id', 'library-calendar-tab');
  await expect(calendarTab).toHaveAttribute('aria-controls', 'library-calendar-panel');
  await expect(calendarPanel).toHaveAttribute('id', 'library-calendar-panel');
  await expect(calendarPanel).toHaveAttribute('aria-labelledby', 'library-calendar-tab');
  await expect(calendarTab).toHaveAttribute('aria-selected', 'true');
  await expect(listTab).toHaveAttribute('aria-selected', 'false');

  await calendarTab.focus();
  await page.keyboard.press('End');
  await expect(listTab).toBeFocused();
  await expect(listTab).toHaveAttribute('aria-selected', 'true');
  await expect(listPanel).toHaveAttribute('id', 'library-list-panel');
  await expect(listPanel).toHaveAttribute('aria-labelledby', 'library-list-tab');

  await page.keyboard.press('ArrowLeft');
  await expect(calendarTab).toBeFocused();
  await expect(calendarTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(listTab).toBeFocused();
  await expect(listTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(calendarTab).toBeFocused();
  await expect(calendarTab).toHaveAttribute('aria-selected', 'true');
});

test('320px幅でもカレンダー日付ボタンの左右端を操作できる', async ({ page }) => {
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/library');

  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  const dateButtons = calendarPanel.locator('.library-calendar .library-day-button');
  await expect(calendarPanel.getByRole('table')).toBeVisible();
  await expect(dateButtons.first()).toBeEnabled();

  const buttonEdges = await dateButtons.evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      const y = bounds.top + bounds.height / 2;
      const leftTarget = document.elementFromPoint(bounds.left + 2, y);
      const rightTarget = document.elementFromPoint(bounds.right - 2, y);
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        height: bounds.height,
        leftIsHitTarget: leftTarget === button || button.contains(leftTarget),
        rightIsHitTarget: rightTarget === button || button.contains(rightTarget),
      };
    }),
  );

  expect(buttonEdges.length).toBeGreaterThan(0);
  for (const bounds of buttonEdges) {
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(320);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.leftIsHitTarget).toBe(true);
    expect(bounds.rightIsHitTarget).toBe(true);
  }
});

test('詳細から戻る・下部ナビ・ブラウザ戻るで記録のURL状態を復元する', async ({ page }) => {
  const today = jstToday();
  const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const detail = {
    ...draftEntryDetailFixture,
    diaryDate: today,
    body: '2ページ目から開いた架空の記録',
  };
  const entries = Array.from({ length: 7 }, (_, index) =>
    makeEntry(index + 1, today, index === 3 ? detail.body : `同日の架空記録${index + 1}`),
  ).map((entry, index) => (index === 3 ? { ...entry, id: entryId } : entry));
  const libraryUrl = `/library?view=list&month=${monthKey(today)}&day=${today}&listPage=2&dayPage=3`;

  await useMockConfig(page);
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: `${today}T15:00:00.000Z`,
        generationAvailable: true,
      },
    }),
  );
  await page.route('**/api/v1/entries**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && pathname === `/api/v1/entries/${entryId}`) {
      return route.fulfill({ json: detail });
    }
    if (route.request().method() === 'GET' && pathname === '/api/v1/entries') {
      return route.fulfill({ json: { items: entries, nextCursor: null } });
    }
    return route.continue();
  });

  const expectRestoredList = async () => {
    await expect(page).toHaveURL(libraryUrl);
    const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
    await expect(page.getByRole('tab', { name: 'リスト' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(listPanel.locator('.entry-history-card')).toHaveCount(3);
    await expect(listPanel.getByRole('navigation', { name: '記録一覧のページ送り' })).toContainText(
      '2ページ目',
    );
    await expect(
      listPanel.getByRole('link', { name: /2ページ目から開いた架空の記録/ }),
    ).toBeVisible();
  };
  const openEntry = async () => {
    await page
      .getByRole('tabpanel', { name: 'リスト' })
      .getByRole('link', { name: /2ページ目から開いた架空の記録/ })
      .click();
    await expect(page).toHaveURL(`/entries/${entryId}`);
  };

  await page.goto(libraryUrl);
  await expectRestoredList();
  await openEntry();
  await page.goBack();
  await expectRestoredList();

  await openEntry();
  await page.getByRole('link', { name: '記録の一覧へ戻る' }).click();
  await expectRestoredList();

  await openEntry();
  await page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .getByRole('link', { name: '記録' })
    .click();
  await expectRestoredList();
  await page.getByRole('tab', { name: 'カレンダー' }).click();
  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  await expect(
    calendarPanel.getByRole('button', { name: `${dateLabel(today)}、記録7件` }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    calendarPanel.getByRole('navigation', { name: '選択日の記録のページ送り' }),
  ).toContainText('3ページ目');
});

test('前月の全件取得中は空日として表示せず、6週分のカレンダーを保つ', async ({ page }) => {
  const today = jstToday();
  const previousMonth = shiftMonth(monthKey(today), -1);
  const lastDayOfPreviousMonth = new Date(
    Date.UTC(parts(`${previousMonth}-01`).year, parts(`${previousMonth}-01`).month, 0),
  ).getUTCDate();
  const previousMonthEnd = `${previousMonth}-${String(lastDayOfPreviousMonth).padStart(2, '0')}`;
  const emptyDate = `${previousMonth}-10`;
  let releaseCoverage!: () => void;
  let notifyCoverage!: () => void;
  const coverageGate = new Promise<void>((resolve) => {
    releaseCoverage = resolve;
  });
  const coverageRequested = new Promise<void>((resolve) => {
    notifyCoverage = resolve;
  });

  await useMockConfig(page);
  await page.route('**/api/v1/entries**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) {
      return route.fulfill({
        json: {
          items: [makeEntry(1, today, '現在月の架空日記')],
          nextCursor: 'current-month-cursor',
        },
      });
    }
    if (cursor === 'current-month-cursor') {
      return route.fulfill({
        json: {
          items: [makeEntry(2, previousMonthEnd, '前月末の架空日記')],
          nextCursor: 'previous-month-cursor',
        },
      });
    }
    notifyCoverage();
    await coverageGate;
    return route.fulfill({
      json: {
        items: [makeEntry(3, `${previousMonth}-01`, '前月初日の架空日記')],
        nextCursor: null,
      },
    });
  });

  await page.goto('/library');
  await expect(page.getByRole('button', { name: '前の月' })).toBeEnabled();
  await page.getByRole('button', { name: '前の月' }).click();
  await coverageRequested;

  const calendar = page.getByRole('table', {
    name: `${parts(`${previousMonth}-01`).year}年${parts(`${previousMonth}-01`).month}月のカレンダー`,
  });
  await expect(calendar.locator('tbody tr')).toHaveCount(6);
  await expect(page.locator('.library-calendar-status')).toHaveText(
    'この月の記録を読み込んでいます…',
  );
  await expect(page.locator('.library-day-empty')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: dateLabel(emptyDate), exact: true }),
  ).toBeDisabled();

  releaseCoverage();
  await expect(page.locator('.library-calendar-status')).toBeEmpty();
  const emptyDateButton = page.getByRole('button', { name: dateLabel(emptyDate), exact: true });
  await expect(emptyDateButton).toBeEnabled();
  await emptyDateButton.click();
  await expect(page.locator('.library-day-empty')).toContainText('この日の記録はありません');
});

test('月移動と空日の作成日付、未来日の制約を保つ', async ({ page }) => {
  const today = jstToday();
  const previousMonth = shiftMonth(monthKey(today), -1);
  const emptyDate = `${previousMonth}-05`;
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({ json: { items: [makeEntry(1, today, '今日の架空日記')], nextCursor: null } }),
  );

  await page.goto('/library');
  await expect(
    page.getByRole('heading', { name: `${parts(today).year}年${parts(today).month}月` }),
  ).toBeVisible();
  await page.getByRole('button', { name: '前の月' }).click();
  await expect(
    page.getByRole('heading', {
      name: `${parts(`${previousMonth}-01`).year}年${parts(`${previousMonth}-01`).month}月`,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: dateLabel(emptyDate), exact: true }).click();
  await expect(page.getByText('この日の記録はありません')).toBeVisible();
  await expect(page.getByRole('link', { name: 'この日の日記を書く' })).toHaveAttribute(
    'href',
    `/new?date=${emptyDate}`,
  );

  await page.getByRole('button', { name: '次の月' }).click();
  const tomorrow = shiftDay(today, 1);
  if (monthKey(tomorrow) === monthKey(today)) {
    const futureDay = page.getByRole('button', {
      name: `${dateLabel(tomorrow)}、未来の日付`,
    });
    await expect(futureDay).toBeEnabled();
    await futureDay.click();
    await expect(page.locator('#library-selected-date')).toHaveText(
      `${parts(tomorrow).month}月${parts(tomorrow).day}日`,
    );
    await expect(page.locator('.library-day-empty')).toContainText('この日の記録はありません');
    await expect(page.getByRole('link', { name: 'この日の日記を書く' })).toHaveCount(0);
  } else {
    await expect(page.getByRole('button', { name: '次の月' })).toBeDisabled();
  }
});

test('記録全体が空なら新規作成への導線を表示する', async ({ page }) => {
  const today = jstToday();
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );

  await page.goto('/library');

  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  await expect(calendarPanel.getByRole('table')).toBeVisible();
  await expect(calendarPanel.getByRole('link', { name: 'この日の日記を書く' })).toHaveAttribute(
    'href',
    `/new?date=${today}`,
  );

  await page.getByRole('tab', { name: 'リスト' }).click();
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  await expect(listPanel.getByRole('heading', { name: 'まだ記録がありません' })).toBeVisible();
  await expect(listPanel.getByRole('link', { name: '日記を書く' })).toHaveAttribute('href', '/new');
});

test('セッションを失った記録一覧は以前の記録にアクセスできない状態を説明する', async ({ page }) => {
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: {
          message: 'session unavailable',
          code: 'AUTH_REQUIRED',
          requestId: 'fixture-request',
          retryable: false,
        },
      },
    }),
  );

  await page.goto('/library');

  await expect(page.getByRole('heading', { name: '記録を表示できません' })).toBeVisible();
  const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
  await expect(calendarPanel.getByText('以前の記録にはアクセスできない状態です。')).toBeVisible();
  await expect(calendarPanel.getByRole('link', { name: '新しい日記を書く' })).toHaveAttribute(
    'href',
    '/new',
  );
});

test('Homeは開いたままJST日付が変わると日付表示と今日の記録を更新する', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T14:59:00.000Z') });
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({
      json: {
        items: [
          makeEntry(110, '2026-11-05', '前日の架空日記'),
          makeEntry(111, '2026-11-06', '今日に切り替わった架空日記'),
        ],
        nextCursor: null,
      },
    }),
  );

  await page.goto('/');

  const homeDate = page.locator('.home-date');
  await expect(homeDate).toHaveAttribute('datetime', '2026-11-05');
  await expect(page.getByRole('heading', { name: '前日の架空日記' })).toBeVisible();

  await page.clock.runFor(60_001);

  await expect(homeDate).toHaveAttribute('datetime', '2026-11-06');
  await expect(page.getByRole('heading', { name: '今日に切り替わった架空日記' })).toBeVisible();
});

test('日付選択中にJST日付が変わると新しい今日を選べて、本文を保持する', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T14:59:00.000Z') });
  await useMockConfig(page);
  await page.route('**/api/v1/me/quota', (route) =>
    route.fulfill({
      json: {
        remainingToday: 3,
        activeGenerationId: null,
        resetAt: '2026-11-06T15:00:00.000Z',
        generationAvailable: true,
      },
    }),
  );

  await page.goto('/new?date=2026-11-05');
  const dateTrigger = page.getByRole('button', { name: '日付', exact: true });
  const selectedDate = dateTrigger.locator('time');
  const diaryInput = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diaryInput.fill('日付境界をまたいで入力している架空の日記です。');
  await expect(selectedDate).toHaveAttribute('datetime', '2026-11-05');
  await dateTrigger.click();
  const dateDialog = page.getByRole('dialog');
  const newlyFutureDate = dateDialog.getByRole('button', { name: '2026年11月6日', exact: true });
  await expect(newlyFutureDate).toBeDisabled();

  await page.clock.runFor(60_001);

  await expect(selectedDate).toHaveAttribute('datetime', '2026-11-05');
  await expect(newlyFutureDate).toBeEnabled();
  await expect(newlyFutureDate).toHaveAttribute('aria-current', 'date');
  await newlyFutureDate.click();
  await expect(selectedDate).toHaveAttribute('datetime', '2026-11-06');
  await expect(diaryInput).toHaveValue('日付境界をまたいで入力している架空の日記です。');
});

test('Libraryはタブ復帰時に今日の判定を更新し、選択日を保つ', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T14:59:00.000Z') });
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  const libraryUrl = '/library?view=calendar&month=2026-11&day=2026-11-06&listPage=1&dayPage=1';

  await page.goto(libraryUrl);

  const selectedDay = page.getByRole('button', { name: '2026年11月6日、未来の日付' });
  await expect(selectedDay).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: 'この日の日記を書く' })).toHaveCount(0);

  await page.clock.setFixedTime(new Date('2026-11-05T15:01:00.000Z'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  const todayButton = page.getByRole('button', { name: '2026年11月6日' });
  await expect(todayButton).toHaveAttribute('aria-current', 'date');
  await expect(todayButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: 'この日の日記を書く' })).toHaveAttribute(
    'href',
    '/new?date=2026-11-06',
  );
  await expect(page).toHaveURL(libraryUrl);
});

test('一覧を再入場すると先頭から取り直し、遅延応答を混ぜない', async ({ page }) => {
  const today = jstToday();
  const previousMonth = shiftMonth(monthKey(today), -1);
  const firstPage = Array.from({ length: 20 }, (_, index) =>
    makeEntry(
      300 - index,
      index === 19 ? `${previousMonth}-01` : today,
      `読み込み前の架空日記${index + 1}`,
    ),
  );
  const refreshedPage = Array.from({ length: 20 }, (_, index) =>
    makeEntry(
      600 - index,
      index === 19 ? `${previousMonth}-01` : today,
      `再読み込み後の架空日記${index + 1}`,
    ),
  );
  let firstPageRequests = 0;
  let notifyStaleRequest!: () => void;
  let releaseStaleResponse!: () => void;
  let notifyStaleSettled!: () => void;
  const staleRequested = new Promise<void>((resolve) => {
    notifyStaleRequest = resolve;
  });
  const staleGate = new Promise<void>((resolve) => {
    releaseStaleResponse = resolve;
  });
  const staleSettled = new Promise<void>((resolve) => {
    notifyStaleSettled = resolve;
  });

  await useMockConfig(page);
  await page.route('**/api/v1/entries**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) {
      firstPageRequests += 1;
      const refreshed = firstPageRequests > 1;
      return route.fulfill({
        json: {
          items: refreshed ? refreshedPage : firstPage,
          nextCursor: refreshed ? 'cursor-after-refresh' : 'cursor-before-refresh',
        },
      });
    }
    if (cursor === 'cursor-before-refresh') {
      notifyStaleRequest();
      await staleGate;
      try {
        await route.fulfill({
          json: {
            items: [makeEntry(990, today, '遅れて届いた古い架空日記')],
            nextCursor: null,
          },
        });
      } catch {
        // Refresh aborts this request; the browser may have already closed its route.
      } finally {
        notifyStaleSettled();
      }
      return;
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });

  const libraryUrl = `/library?view=list&month=${monthKey(today)}&day=${today}&listPage=8&dayPage=4`;
  await page.goto(libraryUrl);
  await staleRequested;

  try {
    await page.locator('.bottom-nav').getByRole('link', { name: '日記を書く' }).click();
    await expect(page).toHaveURL('/new');
    await page.locator('.bottom-nav').getByRole('link', { name: '記録' }).click();
    await expect(page).toHaveURL(/\/library(?:\?.*)?$/);
    await page.getByRole('tab', { name: 'リスト' }).click();
    await expect(page).toHaveURL(
      `/library?view=list&month=${monthKey(today)}&day=${today}&listPage=1&dayPage=1`,
    );
    const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
    await expect(listPanel.locator('.entry-history-card')).toHaveCount(3);
    await expect(listPanel).toContainText('再読み込み後の架空日記1');
    await expect(listPanel).not.toContainText('読み込み前の架空日記');

    releaseStaleResponse();
    await staleSettled;
    await expect(listPanel.locator('.entry-history-card')).toHaveCount(3);
    await expect(listPanel).not.toContainText('遅れて届いた古い架空日記');
    await expect(listPanel).toContainText('再読み込み後の架空日記1');
  } finally {
    releaseStaleResponse();
  }
});
