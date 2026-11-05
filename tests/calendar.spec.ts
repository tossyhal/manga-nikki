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
  await useMockConfig(page);
  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );

  await page.goto('/library');

  const library = page.getByRole('region', { name: '記録' });
  await expect(library.getByRole('heading', { name: 'まだ記録がありません' })).toBeVisible();
  await expect(library.getByRole('link', { name: '日記を書く' })).toHaveAttribute('href', '/new');
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
  await expect(page.getByText('以前の記録にはアクセスできない状態です。')).toBeVisible();
  await expect(page.getByRole('link', { name: '新しい日記を書く' })).toHaveAttribute(
    'href',
    '/new',
  );
});
