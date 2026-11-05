import { expect, test, type Locator, type Page } from '@playwright/test';
import { jstToday, type Entry, type EntryDetail } from '../src/shared/schemas';
import { draftEntryDetailFixture, mockClientConfigFixture } from './fixtures/client-config';
import { clickEntryMenuItem } from './fixtures/ui';

const entryId = draftEntryDetailFixture.id;
const today = jstToday();
const longBody = 'A'.repeat(200);
const detailFixture: EntryDetail = {
  ...draftEntryDetailFixture,
  diaryDate: today,
  body: longBody,
};
const entryFixture: Entry = {
  id: entryId,
  diaryDate: today,
  body: longBody,
  revision: 1,
  latestGenerationId: null,
  createdAt: `${today}T12:00:00.000Z`,
  updatedAt: `${today}T12:00:00.000Z`,
};

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...entryFixture,
    id: `20000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    body: `画面確認用の架空記録${index + 1}`,
  }));
}

async function installMockUiRoutes(page: Page, entries: Entry[] = [entryFixture]) {
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
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
      return route.fulfill({ json: detailFixture });
    }
    if (route.request().method() === 'GET' && pathname === '/api/v1/entries')
      return route.fulfill({ json: { items: entries, nextCursor: null } });
    return route.continue();
  });
}

async function dateTextMetrics(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      text: element.textContent?.trim(),
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      color: style.color,
    };
  });
}

async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const bounds = (element: Element | null) => {
      if (!element) throw new Error('画面要素がありません');
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map((value) => Math.round(value * 10) / 10);
    };
    return {
      main: bounds(document.querySelector('#main')),
      nav: bounds(document.querySelector('.bottom-nav')),
    };
  });
}

async function gapAboveBottomNav(target: Locator) {
  return target.evaluate((element) => {
    const nav = document.querySelector('.bottom-nav');
    if (!nav) throw new Error('下部ナビがありません');
    return nav.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });
}

test('下部ナビは現在位置のラベルと等幅の3つの遷移先を保つ', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const destinations = [
    { path: '/', activeName: 'ホーム', label: 'ホーム' },
    { path: '/new', activeName: '日記を書く', label: '書く' },
    { path: '/library', activeName: '記録', label: '記録' },
  ];

  for (const { path, activeName } of destinations) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
    const links = nav.getByRole('link');
    await expect(links).toHaveCount(3);
    await expect(nav).toHaveCSS('height', '68px');

    const activeLink = nav.getByRole('link', { name: activeName, exact: true });
    await expect(activeLink).toHaveAttribute('aria-current', 'page');
    for (const { activeName: linkName, label: labelText } of destinations) {
      const link = nav.getByRole('link', { name: linkName, exact: true });
      const label = link.locator('.bottom-nav-label');
      const isActive = linkName === activeName;
      await expect(label).toHaveText(labelText);
      await expect(label).toHaveAttribute('aria-hidden', String(!isActive));
      await expect(label).toHaveCSS('display', isActive ? 'block' : 'none');
      if (!isActive) await expect(link).not.toHaveAttribute('aria-current', 'page');
    }

    const widths = await links.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const touchHeights = await links.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    );
    expect(Math.min(...touchHeights)).toBeGreaterThanOrEqual(44);
    const activeIndex = destinations.findIndex(({ activeName: name }) => name === activeName);
    const tabGeometry = await links.evaluateAll((elements) =>
      elements.map((element) => {
        const icon = element.querySelector('.bottom-nav-icon');
        const label = element.querySelector('.bottom-nav-label');
        if (!icon || !label) throw new Error('下部ナビの要素がありません');

        const linkBounds = element.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        const labelBounds = label.getBoundingClientRect();
        return {
          linkCenterY: linkBounds.top + linkBounds.height / 2,
          iconCenterY: iconBounds.top + iconBounds.height / 2,
          iconWidth: iconBounds.width,
          iconHeight: iconBounds.height,
          labelDisplay: getComputedStyle(label).display,
          labelHeight: labelBounds.height,
          groupCenterY: (iconBounds.top + labelBounds.bottom) / 2,
        };
      }),
    );
    for (const [index, tab] of tabGeometry.entries()) {
      expect(tab.iconWidth).toBe(28);
      expect(tab.iconHeight).toBe(28);
      if (index === activeIndex) {
        expect(tab.labelDisplay).toBe('block');
        expect(tab.labelHeight).toBe(18);
        expect(Math.abs(tab.groupCenterY - tab.linkCenterY)).toBeLessThanOrEqual(0.5);
        expect(tab.linkCenterY - tab.iconCenterY).toBeCloseTo(9.5, 1);
      } else {
        expect(tab.labelDisplay).toBe('none');
        expect(tab.labelHeight).toBe(0);
        expect(Math.abs(tab.iconCenterY - tab.linkCenterY)).toBeLessThanOrEqual(0.5);
      }
    }
  }
});

test('primary routeは共通ヘッダーを表示せず、見出しとmain・下部ナビを保つ', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 393, height: 852 });

  const snapshots: Awaited<ReturnType<typeof shellGeometry>>[] = [];
  const documentTitles: string[] = [];
  let homeDateText: Awaited<ReturnType<typeof dateTextMetrics>> | undefined;
  let entryDateText: Awaited<ReturnType<typeof dateTextMetrics>> | undefined;
  const pageHeadings = new Map([
    ['/', '今日の記録'],
    ['/new', '日記を書く'],
    ['/library', '記録'],
  ]);
  for (const [path, heading] of pageHeadings) {
    await page.goto(path);
    await expect(page.locator('.app-header')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '漫画日記 ホーム' })).toHaveCount(0);
    await expect(
      page.locator('#main').getByRole('heading', { level: 1, name: heading }),
    ).toBeVisible();
    documentTitles.push(await page.title());
    if (path === '/') {
      await expect(page.getByRole('heading', { name: heading })).toHaveClass(/sr-only/);
      await expect(page.locator('.home-today-hero')).toBeVisible();
      homeDateText = await dateTextMetrics(page, '.home-date');
    }
    if (path === '/new') {
      await expect(page.getByRole('heading', { name: heading })).toHaveClass(/sr-only/);
      const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
      await expect(diary).toBeVisible();
      await expect(diary).not.toHaveAttribute('aria-label');
      entryDateText = await dateTextMetrics(page, '.date-display time');
    }
    if (path === '/library') {
      await expect(page.getByRole('table')).toBeVisible();
      const tabs = page.getByRole('tablist', { name: '記録の表示方法' });
      const listTab = tabs.getByRole('tab', { name: 'リスト' });
      await expect(tabs).toBeVisible();
      snapshots.push(await shellGeometry(page));
      await listTab.click();
      await expect(page.locator('.entry-history-card')).toHaveCount(1);
      snapshots.push(await shellGeometry(page));
    } else {
      snapshots.push(await shellGeometry(page));
    }
  }

  expect(documentTitles).toEqual(['ホーム | 漫画日記', '日記を書く | 漫画日記', '記録 | 漫画日記']);
  for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
  for (const snapshot of snapshots) expect(snapshot.main[1]).toBeLessThanOrEqual(16);
  expect(homeDateText).toEqual(entryDateText);
});

test('pathname遷移ではmainへfocusし、記録タブのquery更新ではtab focusを保つ', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.goto('/');

  const main = page.locator('#main');
  const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await navigation.getByRole('link', { name: '日記を書く' }).click();
  await expect(main).toBeFocused();
  await navigation.getByRole('link', { name: '記録' }).click();
  await expect(main).toBeFocused();

  const tabs = page.getByRole('tablist', { name: '記録の表示方法' });
  const calendarTab = tabs.getByRole('tab', { name: 'カレンダー' });
  const listTab = tabs.getByRole('tab', { name: 'リスト' });
  await calendarTab.focus();
  await page.keyboard.press('End');
  await expect(listTab).toBeFocused();
  await expect(listTab).toHaveAttribute('aria-selected', 'true');
});

test('primary画面と詳細画面の下部ナビをviewport下端から12px離す', async ({ page }) => {
  await installMockUiRoutes(page);

  for (const viewport of [
    { width: 390, height: 700 },
    { width: 393, height: 852 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const routeBounds: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const path of ['/', `/entries/${entryId}`]) {
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
      const bounds = await nav.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) continue;
      routeBounds.push(bounds);
      expect(bounds.height).toBe(68);
      expect(bounds.width).toBe(Math.min(390, viewport.width - 40));
      expect(bounds.x).toBeCloseTo((viewport.width - bounds.width) / 2, 0);
      expect(viewport.height - bounds.y - bounds.height).toBeCloseTo(12, 0);
    }
    expect(routeBounds[1]?.x).toBe(routeBounds[0]?.x);
    expect(routeBounds[1]?.y).toBe(routeBounds[0]?.y);
    expect(routeBounds[1]?.width).toBe(routeBounds[0]?.width);
    expect(routeBounds[1]?.height).toBe(routeBounds[0]?.height);
  }
});

test('Home・入力・記録・詳細は主要幅で横にはみ出さない', async ({ page }) => {
  await installMockUiRoutes(page);

  const widths = [320, 393, 430, 1280];
  const paths = ['/', '/new', '/library', `/entries/${entryId}`];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of paths) {
      await page.goto(path);

      if (path === '/') {
        await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
      } else if (path === '/new') {
        const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
        await expect(diary).toBeVisible();
        await diary.fill(longBody);
      } else if (path === '/library') {
        await expect(page.locator('.entry-history-card')).toHaveCount(1);
      } else {
        await expect(page.locator('.entry-draft-card .diary')).toBeVisible();
      }

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(width);

      if (path === '/new') {
        const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
        await diary.fill('');
        await expect(diary).toHaveValue('');
      }
    }
  }
});

test('通常の高さではHome・入力・6週カレンダー・20件一覧にスクロールを出さない', async ({
  page,
}) => {
  await installMockUiRoutes(page, makeEntries(20));

  for (const viewport of [
    { width: 393, height: 852 },
    { width: 390, height: 769 },
    { width: 393, height: 724 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of ['/', '/new', '/library']) {
      await page.goto(path);
      if (path === '/') {
        await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
        await expect(page.locator('.home-today-hero')).toBeVisible();
      }
      if (path === '/new')
        await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
      if (path === '/library') {
        await expect(page.getByRole('table')).toBeVisible();
        await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(6);
      }

      const expectNoPrimaryScroll = async () => {
        const scroll = await page.evaluate(() => {
          const main = document.querySelector('#main');
          if (!main) throw new Error('本文領域がありません');
          const overflow = (selector: string) => {
            const element = document.querySelector(selector);
            return element ? element.scrollHeight - element.clientHeight : 0;
          };
          return {
            document: document.documentElement.scrollHeight - window.innerHeight,
            main: main.scrollHeight - main.clientHeight,
            libraryPage: overflow('.library-page'),
            dayRecords: overflow('.library-day-records'),
            listRecords: overflow('.library-list-records'),
          };
        });
        expect(scroll.document).toBeLessThanOrEqual(1);
        expect(scroll.main).toBeLessThanOrEqual(1);
        expect(scroll.libraryPage).toBeLessThanOrEqual(1);
        expect(scroll.dayRecords).toBeLessThanOrEqual(1);
        expect(scroll.listRecords).toBeLessThanOrEqual(1);
      };

      await expectNoPrimaryScroll();
      if (path === '/new') {
        const cta = page.locator('.primary-action-dock > .button');
        await expect(cta).toBeVisible();
        expect(await gapAboveBottomNav(cta)).toBeGreaterThanOrEqual(14);
      }
      if (path === '/library') {
        const calendarPager = page.getByRole('navigation', {
          name: '選択日の記録のページ送り',
        });
        await expect(calendarPager).toBeVisible();
        expect(await gapAboveBottomNav(calendarPager)).toBeGreaterThanOrEqual(14);
        await page.getByRole('tab', { name: 'リスト' }).click();
        await expect(page.locator('.entry-history-card')).toHaveCount(3);
        await expectNoPrimaryScroll();
        const listPager = page.getByRole('navigation', { name: '記録一覧のページ送り' });
        await expect(listPager).toBeVisible();
        expect(await gapAboveBottomNav(listPager)).toBeGreaterThanOrEqual(14);
      }
    }
  }
});

test('日記にフォーカスしても下部ナビの位置を保つ', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 390, height: 769 });
  await page.goto('/new');
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  const initialBounds = await nav.boundingBox();
  const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
  await diary.fill(longBody);
  await diary.focus();
  const focusedBounds = await nav.boundingBox();

  expect(initialBounds).not.toBeNull();
  expect(focusedBounds).not.toBeNull();
  expect(focusedBounds?.x).toBe(initialBounds?.x);
  expect(focusedBounds?.y).toBe(initialBounds?.y);
  expect(focusedBounds?.width).toBe(initialBounds?.width);
  expect(focusedBounds?.height).toBe(initialBounds?.height);
});

test('入力カードはviewportが高くなると利用可能な高さに合わせて伸びる', async ({ page }) => {
  await installMockUiRoutes(page);

  const cardHeights: number[] = [];
  for (const height of [700, 852]) {
    await page.setViewportSize({ width: 393, height });
    await page.goto('/new');
    const card = page.locator('.entry-editor-card');
    await expect(card).toBeVisible();
    const bounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    cardHeights.push(bounds?.height ?? 0);
  }

  expect(cardHeights[1]).toBeGreaterThan(cardHeights[0] + 40);
});

test('オフライン通知と拡大表示がある短い画面でも記録ページ送りへ到達する', async ({ page }) => {
  await installMockUiRoutes(page, makeEntries(20));
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto('/library');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('tab', { name: 'リスト' }).click();
  await expect(page.locator('.entry-history-card')).toHaveCount(3);
  await page.context().setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'オフラインです。' })).toBeVisible();
  await page.evaluate(() => document.body.style.setProperty('zoom', '1.5'));

  const controls = page.getByRole('navigation', { name: '記録一覧のページ送り' });
  await controls.scrollIntoViewIfNeeded();
  await expect(controls).toBeInViewport();
  await controls.getByRole('button', { name: '次へ' }).click();
  await expect(controls).toContainText('2ページ目');
});

test('日付ピッカーに視覚フォーカスを示し、拡大時も保存操作へ到達できる', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/new');
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();
  const newDatePicker = page.getByLabel('日付', { exact: true });
  await newDatePicker.focus();
  await expect(page.locator('.date-control')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.date-control')).toHaveCSS('outline-width', '2px');
  await expect(page.locator('.date-control')).toHaveCSS('outline-color', 'rgb(85, 85, 85)');

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`要素がありません: ${selector}`);
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return {
      row: rect('.date-row'),
      control: rect('.date-control'),
      picker: rect('.date-picker-input'),
      time: rect('.date-display time'),
      icon: rect('.date-display svg'),
      save: rect('.date-row button'),
    };
  });
  expect(layout.picker.left).toBeGreaterThanOrEqual(layout.control.left);
  expect(layout.picker.right).toBeLessThanOrEqual(layout.control.right + 1);
  expect(layout.control.bottom - layout.control.top).toBeGreaterThanOrEqual(44);
  expect(layout.picker.right <= layout.save.left || layout.save.right <= layout.picker.left).toBe(
    true,
  );
  expect(layout.save.right).toBeCloseTo(layout.row.right, 0);
  expect(
    Math.abs(layout.save.top + layout.save.bottom - layout.control.top - layout.control.bottom),
  ).toBeLessThanOrEqual(2);
  expect(layout.icon.left).toBeGreaterThanOrEqual(layout.time.right);
  expect(layout.icon.left - layout.time.right).toBeLessThanOrEqual(12);
  expect(
    Math.abs(layout.icon.top + layout.icon.bottom - layout.picker.top - layout.picker.bottom),
  ).toBeLessThanOrEqual(2);

  const body = '日付と保存ボタンの表示を確認する架空の日記';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(body);
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(
    page.getByRole('heading', { name: '日記を保存しました', exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.locator('.detail-toolbar h1')).toHaveText(body);
  await expect(page.getByRole('heading', { name: '下書きを保存しました' })).toHaveCount(0);
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  await page.reload();
  await expect(page.locator('.entry-draft-card .diary')).toHaveText(body);

  await clickEntryMenuItem(page, '日記を編集');
  await page.getByLabel('日付', { exact: true }).focus();
  const detailDateRow = page.locator('.detail-edit-form .date-row');
  await expect(detailDateRow).toHaveCSS('outline-style', 'solid');
  await expect(detailDateRow).toHaveCSS('outline-width', '2px');
  await expect(detailDateRow).toHaveCSS('outline-color', 'rgb(85, 85, 85)');
  const editDateControl = await detailDateRow.locator('.date-control').boundingBox();
  expect(editDateControl?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto('/new');
  await page.addStyleTag({
    content: '.date-display, .date-row > .button-text { font-size: 200% !important; }',
  });
  const largeBody = '文字拡大時の保存を確認する架空の日記';
  await page.getByLabel('今日はどんな日だった？', { exact: true }).fill(largeBody);
  const largeSaveButton = page.getByRole('button', { name: '下書き保存' });
  await largeSaveButton.scrollIntoViewIfNeeded();
  await expect(largeSaveButton).toBeInViewport();
  await expect(largeSaveButton).toBeEnabled();
  const largeDateRow = await page.evaluate(() => {
    const row = document.querySelector('.date-row');
    const picker = document.querySelector('.date-picker-input');
    const save = document.querySelector('.date-row button');
    if (!row || !picker || !save) throw new Error('日付行の操作要素がありません');
    const rowBounds = row.getBoundingClientRect();
    const pickerBounds = picker.getBoundingClientRect();
    const saveBounds = save.getBoundingClientRect();
    const saveTarget = document.elementFromPoint(
      saveBounds.left + saveBounds.width / 2,
      saveBounds.top + saveBounds.height / 2,
    );
    return {
      height: rowBounds.height,
      rowLeft: rowBounds.left,
      rowRight: rowBounds.right,
      pickerLeft: pickerBounds.left,
      pickerRight: pickerBounds.right,
      pickerTop: pickerBounds.top,
      pickerBottom: pickerBounds.bottom,
      saveLeft: saveBounds.left,
      saveRight: saveBounds.right,
      saveTop: saveBounds.top,
      saveBottom: saveBounds.bottom,
      saveReceivesPointer: Boolean(saveTarget && save.contains(saveTarget)),
    };
  });
  expect(largeDateRow.height).toBeGreaterThan(44);
  expect(largeDateRow.pickerLeft).toBeGreaterThanOrEqual(largeDateRow.rowLeft - 1);
  expect(largeDateRow.pickerRight).toBeLessThanOrEqual(largeDateRow.rowRight + 1);
  expect(largeDateRow.saveLeft).toBeGreaterThanOrEqual(largeDateRow.rowLeft - 1);
  expect(largeDateRow.saveRight).toBeLessThanOrEqual(largeDateRow.rowRight + 1);
  expect(
    largeDateRow.pickerRight <= largeDateRow.saveLeft ||
      largeDateRow.saveRight <= largeDateRow.pickerLeft ||
      largeDateRow.pickerBottom <= largeDateRow.saveTop ||
      largeDateRow.saveBottom <= largeDateRow.pickerTop,
  ).toBe(true);
  expect(largeDateRow.saveReceivesPointer).toBe(true);
  await largeSaveButton.click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(
    page.getByRole('heading', { name: '日記を保存しました', exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.locator('.detail-toolbar h1')).toHaveText(largeBody);
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  await page.reload();
  await expect(page.locator('.entry-draft-card .diary')).toHaveText(largeBody);
});
