import { expect, test, type Page } from '@playwright/test';
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

async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const bounds = (element: Element | null) => {
      if (!element) throw new Error('画面要素がありません');
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map((value) => Math.round(value * 10) / 10);
    };
    const navItems = Array.from(document.querySelectorAll('.bottom-nav-item'));
    return {
      brand: bounds(document.querySelector('.app-header .brand')),
      headerAction: bounds(document.querySelector('.app-header-action')),
      main: bounds(document.querySelector('#main')),
      nav: bounds(document.querySelector('.bottom-nav')),
      items: navItems.map((item) => ({
        link: bounds(item),
        icon: bounds(item.querySelector('.bottom-nav-icon')),
        label: bounds(item.querySelector('.bottom-nav-label')),
      })),
    };
  });
}

test('下部ナビは現在位置のラベルと等幅の3つの遷移先を保つ', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const destinations = [
    { path: '/', activeName: 'ホーム' },
    { path: '/new', activeName: '日記を書く' },
    { path: '/library', activeName: '記録' },
  ];

  for (const { path, activeName } of destinations) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
    const links = nav.getByRole('link');
    await expect(links).toHaveCount(3);

    const activeLink = nav.getByRole('link', { name: activeName, exact: true });
    await expect(activeLink).toHaveAttribute('aria-current', 'page');
    await expect(activeLink.locator('.bottom-nav-label')).toHaveAttribute('aria-hidden', 'false');
    await expect(activeLink.locator('.bottom-nav-label')).toHaveCSS('visibility', 'visible');
    for (const { activeName: otherName } of destinations) {
      if (otherName === activeName) continue;
      const otherLink = nav.getByRole('link', { name: otherName, exact: true });
      await expect(otherLink).not.toHaveAttribute('aria-current', 'page');
      await expect(otherLink.locator('.bottom-nav-label')).toHaveAttribute('aria-hidden', 'true');
      await expect(otherLink.locator('.bottom-nav-label')).toHaveCSS('visibility', 'hidden');
    }

    const widths = await links.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const iconBoxes = await links.locator('.bottom-nav-icon').evaluateAll((elements) =>
      elements.map((element) => {
        const { top, width, height } = element.getBoundingClientRect();
        return { top, width, height };
      }),
    );
    expect(iconBoxes.every(({ width, height }) => width === 28 && height === 28)).toBe(true);
    expect(
      Math.max(...iconBoxes.map(({ top }) => top)) - Math.min(...iconBoxes.map(({ top }) => top)),
    ).toBe(0);
  }
});

test('共通ヘッダーと下部ナビの座標は3ルートと記録切替で変わらない', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 393, height: 852 });

  const snapshots: Awaited<ReturnType<typeof shellGeometry>>[] = [];
  for (const path of ['/', '/new', '/library']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: '漫画日記 ホーム' })).toBeVisible();
    if (path === '/') {
      await expect(page.getByRole('heading', { name: '今日の記録' })).toHaveClass(/sr-only/);
      await expect(page.locator('.home-today-hero')).toBeVisible();
    }
    if (path === '/new') await expect(page.getByLabel('日記', { exact: true })).toBeVisible();
    if (path === '/library') {
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('button', { name: '一覧で見る' })).toBeVisible();
      snapshots.push(await shellGeometry(page));
      await page.getByRole('button', { name: '一覧で見る' }).click();
      await expect(page.getByRole('button', { name: 'カレンダーで見る' })).toBeVisible();
      await expect(page.locator('.entry-history-card')).toHaveCount(1);
      snapshots.push(await shellGeometry(page));
    } else {
      snapshots.push(await shellGeometry(page));
    }
  }

  for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
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
        const diary = page.getByLabel('日記', { exact: true });
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
        const diary = page.getByLabel('日記', { exact: true });
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
      if (path === '/new') await expect(page.getByLabel('日記', { exact: true })).toBeVisible();
      if (path === '/library') {
        await expect(page.getByRole('table')).toBeVisible();
        await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(6);
      }

      const expectNoPrimaryScroll = async () => {
        const scroll = await page.evaluate(() => {
          const main = document.querySelector('#main');
          if (!main) throw new Error('本文領域がありません');
          return {
            document: document.documentElement.scrollHeight - window.innerHeight,
            main: main.scrollHeight - main.clientHeight,
          };
        });
        expect(scroll.document).toBeLessThanOrEqual(1);
        expect(scroll.main).toBeLessThanOrEqual(1);
      };

      await expectNoPrimaryScroll();
      if (path === '/library') {
        await page.getByRole('button', { name: '一覧で見る' }).click();
        await expect(page.locator('.entry-history-card')).toHaveCount(3);
        await expectNoPrimaryScroll();
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
  const diary = page.getByLabel('日記', { exact: true });
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

test('オフライン通知と拡大表示がある短い画面でも記録ページ送りへ到達する', async ({ page }) => {
  await installMockUiRoutes(page, makeEntries(20));
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto('/library');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '一覧で見る' }).click();
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
  await expect(page.getByLabel('日記', { exact: true })).toBeVisible();
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
  expect(layout.picker.right).toBeLessThanOrEqual(layout.row.right + 1);
  expect(
    layout.picker.right <= layout.save.left || layout.save.right <= layout.picker.left,
  ).toBe(true);
  expect(layout.save.right).toBeCloseTo(layout.row.right, 0);
  expect(
    Math.abs(
      layout.save.top + layout.save.bottom - layout.control.top - layout.control.bottom,
    ),
  ).toBeLessThanOrEqual(2);
  expect(layout.icon.left).toBeGreaterThanOrEqual(layout.time.right);
  expect(layout.icon.left - layout.time.right).toBeLessThanOrEqual(12);
  expect(
    Math.abs(
      layout.icon.top + layout.icon.bottom - layout.picker.top - layout.picker.bottom,
    ),
  ).toBeLessThanOrEqual(2);

  const body = '日付と保存ボタンの表示を確認する架空の日記';
  await page.getByLabel('日記', { exact: true }).fill(body);
  await page.getByRole('button', { name: '下書き保存' }).click();
  await expect(page).toHaveURL(/\/entries\//);
  await expect(page.getByRole('heading', { name: '下書きを保存しました' })).toBeVisible();
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  await page.reload();
  await expect(page.locator('.entry-draft-card .diary')).toHaveText(body);

  await clickEntryMenuItem(page, '日記を編集');
  await page.getByLabel('日付', { exact: true }).focus();
  const detailDateRow = page.locator('.detail-edit-form .date-row');
  await expect(detailDateRow).toHaveCSS('outline-style', 'solid');
  await expect(detailDateRow).toHaveCSS('outline-width', '2px');
  await expect(detailDateRow).toHaveCSS('outline-color', 'rgb(85, 85, 85)');

  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto('/new');
  await page.addStyleTag({
    content: '.date-display, .date-row > .button-text { font-size: 200% !important; }',
  });
  const largeBody = '文字拡大時の保存を確認する架空の日記';
  await page.getByLabel('日記', { exact: true }).fill(largeBody);
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
  await expect(page.getByRole('heading', { name: '下書きを保存しました' })).toBeVisible();
  await expect(page.locator('.draft-saved-card')).toBeVisible();
  await page.reload();
  await expect(page.locator('.entry-draft-card .diary')).toHaveText(largeBody);
});
