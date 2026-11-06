import { expect, test, type Locator, type Page } from '@playwright/test';
import { generationFixtures, panelsComic } from '../src/shared/fixtures';
import { jstToday, type Entry, type EntryDetail, type Generation } from '../src/shared/schemas';
import { draftEntryDetailFixture, mockClientConfigFixture } from './fixtures/client-config';
import { clickEntryMenuItem, expectDefaultLibraryLocation } from './fixtures/ui';

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

async function expectMainToFit(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector('#main');
        if (!(main instanceof HTMLElement)) throw new Error('本文領域がありません');
        return main.scrollHeight - main.clientHeight;
      }),
    )
    .toBeLessThanOrEqual(1);
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
      await expect(
        page.getByRole('tabpanel', { name: 'リスト' }).locator('.entry-history-card'),
      ).toHaveCount(1);
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

test('詳細メニューは外側操作とTab離脱で閉じ、Escapeと矢印キーを保つ', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.goto(`/entries/${entryId}`);

  const trigger = page.getByRole('button', { name: 'その他の操作' });
  const menu = page.getByRole('menu', { name: '記録の操作' });
  const edit = page.getByRole('menuitem', { name: '日記を編集' });
  const remove = page.getByRole('menuitem', { name: '日記を削除' });

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(edit).toBeFocused();
  await page.locator('.detail-title').click();
  await expect(menu).toHaveCount(0);

  await trigger.click();
  await expect(edit).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Home');
  await expect(edit).toBeFocused();
  await page.keyboard.press('End');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(edit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);

  await trigger.click();
  await expect(menu).toBeVisible();
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('null relatedTargetのblur後にtriggerを再タップしてもメニューを再度開かない', async ({
  page,
}) => {
  await installMockUiRoutes(page);
  await page.goto(`/entries/${entryId}`);

  const trigger = page.getByRole('button', { name: 'その他の操作' });
  const menu = page.getByRole('menu', { name: '記録の操作' });
  await trigger.click();
  await expect(menu).toBeVisible();

  const sawNullRelatedTarget = await page.evaluate(() => {
    const triggerButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="その他の操作"]',
    );
    const menuItem = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    const anchor = document.querySelector<HTMLDivElement>('.detail-menu-anchor');
    if (!triggerButton || !menuItem || !anchor) throw new Error('詳細メニューがありません');
    let sawNullRelatedTarget = false;
    anchor.addEventListener(
      'focusout',
      (event) => {
        if (event.target === menuItem) sawNullRelatedTarget = event.relatedTarget === null;
      },
      true,
    );
    menuItem.focus();
    triggerButton.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0 }),
    );
    triggerButton.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', button: 0 }),
    );
    menuItem.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    triggerButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return sawNullRelatedTarget;
  });
  expect(sawNullRelatedTarget).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('null relatedTargetのblur後も編集と削除のmenuitemを実行できる', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.goto(`/entries/${entryId}`);

  const trigger = page.getByRole('button', { name: 'その他の操作' });
  const menu = page.getByRole('menu', { name: '記録の操作' });
  const clickItemAfterNullBlur = async (name: string) =>
    page.evaluate((itemName) => {
      const anchor = document.querySelector<HTMLDivElement>('.detail-menu-anchor');
      const item = [
        ...(anchor?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
      ].find((button) => button.textContent?.includes(itemName));
      if (!anchor || !item) throw new Error(`menuitem「${itemName}」がありません`);
      let sawNullRelatedTarget = false;
      anchor.addEventListener(
        'focusout',
        (event) => {
          if (event.target instanceof HTMLElement)
            sawNullRelatedTarget = event.relatedTarget === null;
        },
        true,
      );
      item.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0 }),
      );
      item.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', button: 0 }),
      );
      (document.activeElement as HTMLElement | null)?.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
      );
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return sawNullRelatedTarget;
    }, name);

  await trigger.click();
  await expect(menu).toBeVisible();
  expect(await clickItemAfterNullBlur('日記を編集')).toBe(true);
  await expect(page.getByLabel('今日はどんな日だった？', { exact: true })).toBeVisible();

  await page.reload();
  await trigger.click();
  await expect(menu).toBeVisible();
  expect(await clickItemAfterNullBlur('日記を削除')).toBe(true);
  await expect(page.getByRole('dialog', { name: 'この日記を削除しますか？' })).toBeVisible();
});

test('primary画面と詳細画面の下部ナビをviewport下端から12px離す', async ({ page }) => {
  await installMockUiRoutes(page);

  const viewports = [
    { width: 1280, height: 900 },
    { width: 393, height: 852 },
    { width: 390, height: 700 },
  ];
  await page.setViewportSize({ width: 390, height: 700 });
  const routeBoundsByViewport = new Map<
    string,
    Array<{ path: string; bounds: { x: number; y: number; width: number; height: number } }>
  >();
  for (const path of ['/', `/entries/${entryId}`]) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const expectedWidth = viewport.width >= 960 ? 360 : Math.min(390, viewport.width - 40);
      await expect
        .poll(async () => {
          const bounds = await nav.boundingBox();
          if (!bounds) return null;
          return {
            x: Math.round(bounds.x * 10) / 10,
            y: Math.round(bounds.y * 10) / 10,
            width: Math.round(bounds.width * 10) / 10,
            height: Math.round(bounds.height * 10) / 10,
          };
        })
        .toEqual({
          x: (viewport.width - expectedWidth) / 2,
          y: viewport.height - 80,
          width: expectedWidth,
          height: 68,
        });
      const bounds = await nav.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) continue;
      const key = `${viewport.width}x${viewport.height}`;
      const routeBounds = routeBoundsByViewport.get(key) ?? [];
      routeBounds.push({ path, bounds });
      routeBoundsByViewport.set(key, routeBounds);
      expect(bounds.height).toBe(68);
      expect(bounds.width).toBe(expectedWidth);
      expect(bounds.x).toBeCloseTo((viewport.width - bounds.width) / 2, 0);
      expect(viewport.height - bounds.y - bounds.height).toBeCloseTo(12, 0);
    }
  }
  for (const viewport of viewports) {
    const routeBounds = routeBoundsByViewport.get(`${viewport.width}x${viewport.height}`) ?? [];
    const homeBounds = routeBounds.find(({ path }) => path === '/')?.bounds;
    const detailBounds = routeBounds.find(({ path }) => path === `/entries/${entryId}`)?.bounds;
    expect(detailBounds?.x).toBe(homeBounds?.x);
    expect(detailBounds?.y).toBe(homeBounds?.y);
    expect(detailBounds?.width).toBe(homeBounds?.width);
    expect(detailBounds?.height).toBe(homeBounds?.height);
  }
});

test('Home・入力・記録・詳細は主要幅で横にはみ出さない', async ({ page }) => {
  await installMockUiRoutes(page);

  const widths = [1440, 1280, 800, 640, 430, 393, 320];
  await page.setViewportSize({ width: 320, height: 844 });
  const paths = ['/', '/new', '/library', `/entries/${entryId}`];
  for (const path of paths) {
    await page.goto(path);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });

      if (path === '/') {
        await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
        await expect(page.locator('.home-today-hero')).toBeVisible();
      } else if (path === '/new') {
        const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
        await expect(diary).toBeVisible();
        await diary.fill(longBody);
      } else if (path === '/library') {
        await expect(
          page.getByRole('tabpanel', { name: 'カレンダー' }).locator('.entry-history-card'),
        ).toHaveCount(1);
      } else {
        await expect(page.locator('.entry-draft-card .diary')).toBeVisible();
      }

      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const main = document.querySelector('#main');
            if (!(main instanceof HTMLElement)) throw new Error('本文領域がありません');
            return main.scrollWidth - main.clientWidth;
          }),
        )
        .toBeLessThanOrEqual(0);

      if (path === '/new') {
        const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
        await diary.fill('');
        await expect(diary).toHaveValue('');
        await expect(page).toHaveURL(/\/new$/);
      }
    }
  }
});

test('デスクトップではページ幅を使い、漫画4コマを2列で表示する', async ({ page }) => {
  await installMockUiRoutes(page, makeEntries(20));

  const viewportWidths = [1280, 1440];
  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');

    const shell = await page.locator('.app-shell').boundingBox();
    const home = await page.locator('.home-page').boundingBox();
    const todaySection = await page.locator('.today-section').boundingBox();
    const recentRecords = await page.locator('.recent-records').boundingBox();
    expect(shell?.width).toBe(1120);
    expect(shell?.x).toBe((width - 1120) / 2);
    expect(home?.width).toBe(960);
    expect(todaySection).not.toBeNull();
    expect(recentRecords).not.toBeNull();
    expect((todaySection?.x ?? 0) + (todaySection?.width ?? 0)).toBeLessThan(recentRecords?.x ?? 0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await expectMainToFit(page);
    const homeDate = await dateTextMetrics(page, '.home-date');

    await page.goto('/new');
    const newEntry = await page.locator('.new-entry-page').boundingBox();
    const diary = await page.locator('.entry-editor-card').boundingBox();
    const writingColumn = await page.locator('.entry-form-fields').boundingBox();
    const supportColumn = await page.locator('.entry-compose-support').boundingBox();
    const actionRow = page.locator('.new-entry-form .primary-action-dock > .primary-action-row');
    expect(newEntry?.width).toBe(960);
    expect(diary?.width).toBeGreaterThanOrEqual(500);
    expect(diary?.height).toBeGreaterThan(600);
    expect((writingColumn?.x ?? 0) + (writingColumn?.width ?? 0)).toBeLessThan(
      supportColumn?.x ?? 0,
    );
    expect(supportColumn?.width).toBeGreaterThanOrEqual(280);
    await expect(actionRow).toBeVisible();
    await expect.poll(() => gapAboveBottomNav(actionRow)).toBeGreaterThanOrEqual(16);
    await expect.poll(() => gapAboveBottomNav(actionRow)).toBeLessThanOrEqual(32);
    expect(await dateTextMetrics(page, '.date-display time')).toEqual(homeDate);
    await expectMainToFit(page);

    await page.goto('/library');
    const calendar = await page.locator('.library-calendar').boundingBox();
    const selectedDay = await page.locator('.library-day-section').boundingBox();
    expect(calendar).not.toBeNull();
    expect(selectedDay).not.toBeNull();
    expect((calendar?.x ?? 0) + (calendar?.width ?? 0)).toBeLessThan(selectedDay?.x ?? 0);
    expect(calendar?.height).toBeLessThanOrEqual(320);
    expect(selectedDay?.height).toBeLessThanOrEqual(360);
    await expectMainToFit(page);

    await page.getByRole('tab', { name: 'リスト' }).click();
    await expect(page.getByRole('tabpanel', { name: 'リスト' })).toBeVisible();
    const listCards = page.locator('.library-list-records .entry-history-list .entry-history-card');
    await expect(listCards).toHaveCount(3);
    const listCardBounds = await listCards.evaluateAll((cards) =>
      cards.map((card) => card.getBoundingClientRect().left),
    );
    expect(new Set(listCardBounds).size).toBe(3);
    await expectMainToFit(page);
  }

  const panelGeneration: Generation = {
    ...generationFixtures(entryId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').succeeded,
    comic: panelsComic,
  };
  const panelEntry: EntryDetail = {
    ...detailFixture,
    latestGenerationId: panelGeneration.id,
    latestGeneration: panelGeneration,
  };
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
  await page.route(`**/api/v1/entries/${entryId}`, (route) => route.fulfill({ json: panelEntry }));
  await page.route('**/api/v1/assets/*/url', (route) =>
    route.fulfill({
      json: { url: '/sample-comic.svg', expiresAt: '2099-01-01T00:00:00.000Z' },
    }),
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/entries/${entryId}`);
  await expect(page.locator('.detail-page')).toHaveClass(/has-comic/);
  await expect(page.locator('.app-main')).toHaveCSS('padding-bottom', '104px');
  const detail = await page.locator('.detail-page').boundingBox();
  const comic = await page.locator('.detail-page > .comic').boundingBox();
  const comicActions = await page.locator('.detail-page > .comic-actions').boundingBox();
  expect(detail?.width).toBeGreaterThanOrEqual(1000);
  expect((comic?.x ?? 0) + (comic?.width ?? 0)).toBeLessThan(comicActions?.x ?? 0);
  await expect(page.locator('.comic.is-panels .comic-panel-card')).toHaveCount(4);
  const panelGrid = await page
    .locator('.comic.is-panels .comic-images')
    .evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
    );
  expect(panelGrid).toBe(2);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(1280);
});

test('短いデスクトップ画面の記録ビューは本文領域に収まる', async ({ page }) => {
  await installMockUiRoutes(page, makeEntries(20));
  await page.setViewportSize({ width: 1366, height: 650 });
  await page.goto('/library');

  const toolbarMetrics = await page.locator('.library-view-toolbar').evaluate((toolbar) => {
    const tabs = toolbar.querySelector('.library-view-tabs');
    if (!tabs) throw new Error('記録ツールバーの要素がありません');
    const centerY = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    const toolbarBounds = toolbar.getBoundingClientRect();
    const tabsBounds = tabs.getBoundingClientRect();
    return {
      tabsCenter: centerY(tabs),
      toolbarCenter: centerY(toolbar),
      widthRatio: tabsBounds.width / toolbarBounds.width,
    };
  });
  expect(Math.abs(toolbarMetrics.tabsCenter - toolbarMetrics.toolbarCenter)).toBeLessThanOrEqual(
    0.5,
  );
  expect(toolbarMetrics.widthRatio).toBeCloseTo(1, 1);
  await expect(page.locator('.library-refresh-button')).toHaveCount(0);

  const expectLibraryToFit = async (viewSelector: string) => {
    await expectMainToFit(page);
    await expect(page.locator('.library-page')).toHaveCSS('min-height', '0px');
    await expect(page.locator(viewSelector)).toHaveCSS('min-height', '0px');
  };

  await expect(page.locator('.library-calendar')).toBeVisible();
  await expectLibraryToFit('.library-calendar-view');

  await page.getByRole('tab', { name: 'リスト' }).click();
  await expect(page.getByRole('tabpanel', { name: 'リスト' })).toBeVisible();
  await expectLibraryToFit('.library-list-view');

  await page.route('**/api/v1/entries**', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: '一時的に利用できません。',
          requestId: 'fixture-request-id',
          retryable: true,
        },
      },
    }),
  );
  await page.goto('/library');
  await expect(page.locator('.library-tab-panel:not([hidden]) .library-state-view')).toBeVisible();
  await expectLibraryToFit('.library-tab-panel:not([hidden]) .library-state-view');
});

test('960x540の保存エラー操作を確認でき、CTAと下部ナビを離す', async ({ page }) => {
  await installMockUiRoutes(page);
  await page.route('**/api/v1/entries', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: '一時的に利用できません。',
          requestId: 'fixture-request-id',
          retryable: true,
        },
      },
    });
  });

  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/new');
  await page
    .getByLabel('今日はどんな日だった？', { exact: true })
    .fill('短い画面で保存エラーを確認する日記。');
  await page.getByRole('button', { name: '下書き保存' }).click();
  const errorCard = page.locator('.save-error-card');
  const retry = page.getByRole('button', { name: 'もう一度保存' });
  await expect(errorCard).toBeVisible();
  await expect(retry).toBeEnabled();
  await errorCard.scrollIntoViewIfNeeded();
  await expect(errorCard).toBeInViewport();
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();

  const layout = await page.evaluate(() => {
    const action = document.querySelector('.primary-action-row > .button');
    const nav = document.querySelector('.bottom-nav');
    if (!(action instanceof HTMLElement) || !nav)
      throw new Error('本文領域、保存操作、または下部ナビがありません');
    return {
      actionBottom: action.getBoundingClientRect().bottom,
      navTop: nav.getBoundingClientRect().top,
    };
  });
  expect(layout.navTop - layout.actionBottom).toBeGreaterThanOrEqual(23.5);
});

test('通常の高さではHome・入力・6週カレンダー・20件一覧にスクロールを出さない', async ({
  page,
}) => {
  await installMockUiRoutes(page, makeEntries(20));

  const viewports = [
    { width: 393, height: 852 },
    { width: 390, height: 769 },
    { width: 393, height: 724 },
    { width: 390, height: 700 },
  ];
  await page.setViewportSize({ width: 390, height: 700 });
  const readPrimaryScroll = async () =>
    page.evaluate(() => {
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
  const expectNoPrimaryScroll = async () => {
    await expect
      .poll(async () => Object.values(await readPrimaryScroll()).every((overflow) => overflow <= 1))
      .toBe(true);
    const scroll = await readPrimaryScroll();
    expect(scroll.document).toBeLessThanOrEqual(1);
    expect(scroll.main).toBeLessThanOrEqual(1);
    expect(scroll.libraryPage).toBeLessThanOrEqual(1);
    expect(scroll.dayRecords).toBeLessThanOrEqual(1);
    expect(scroll.listRecords).toBeLessThanOrEqual(1);
  };

  for (const path of ['/', '/new', '/library']) {
    await page.goto(path);
    if (path === '/library') await expectDefaultLibraryLocation(page);

    if (path === '/') {
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', { name: '今日の記録' })).toBeAttached();
        await expect(page.locator('.home-today-hero')).toBeVisible();
        await expectNoPrimaryScroll();
      }
    } else if (path === '/new') {
      const diary = page.getByLabel('今日はどんな日だった？', { exact: true });
      const cta = page.locator('.primary-action-dock > .primary-action-row > .button');
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await expect(diary).toBeVisible();
        await expectNoPrimaryScroll();
        await expect(cta).toBeVisible();
        await expect.poll(() => gapAboveBottomNav(cta)).toBeGreaterThanOrEqual(14);
      }
    } else {
      const tabs = page.getByRole('tablist', { name: '記録の表示方法' });
      const calendarTab = tabs.getByRole('tab', { name: 'カレンダー' });
      const listTab = tabs.getByRole('tab', { name: 'リスト' });
      const calendarPanel = page.getByRole('tabpanel', { name: 'カレンダー' });
      const calendarPager = calendarPanel.getByRole('navigation', {
        name: '選択日の記録のページ送り',
      });
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await expect(calendarTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('table')).toBeVisible();
        await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(6);
        await expectNoPrimaryScroll();
        await expect(calendarPager).toBeVisible();
        await expect.poll(() => gapAboveBottomNav(calendarPager)).toBeGreaterThanOrEqual(14);
      }

      await listTab.click();
      await expect(page).toHaveURL(/\/library\?view=list&/);
      const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
      const listPager = listPanel.getByRole('navigation', { name: '記録一覧のページ送り' });
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await expect(listTab).toHaveAttribute('aria-selected', 'true');
        await expect(calendarTab).toHaveAttribute('aria-selected', 'false');
        await expect(listPanel.locator('.entry-history-card')).toHaveCount(3);
        await expectNoPrimaryScroll();
        await expect(listPager).toBeVisible();
        await expect.poll(() => gapAboveBottomNav(listPager)).toBeGreaterThanOrEqual(14);
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

  const shortCardHeight = cardHeights[0];
  const tallCardHeight = cardHeights[1];
  if (shortCardHeight === undefined || tallCardHeight === undefined) {
    throw new Error('入力カードの高さを取得できませんでした');
  }
  expect(tallCardHeight).toBeGreaterThan(shortCardHeight + 40);
});

test('横長の短い入力画面では日付・本文・保存CTAを重ねず本文領域をスクロールできる', async ({
  page,
}) => {
  await installMockUiRoutes(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/new');

  const dateControl = page.locator('.date-control');
  const card = page.locator('.entry-editor-card');
  const primaryAction = page.locator('.primary-action-dock > .primary-action-row > .button');
  await expect(dateControl).toBeVisible();
  await expect(card).toBeVisible();
  await expect(primaryAction).toBeEnabled();

  const initialLayout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`要素がありません: ${selector}`);
      const { top, bottom } = element.getBoundingClientRect();
      return { top, bottom };
    };
    const main = document.querySelector('#main');
    if (!(main instanceof HTMLElement)) throw new Error('本文領域がありません');
    const mainBounds = main.getBoundingClientRect();
    return {
      date: bounds('.date-control'),
      card: bounds('.entry-editor-card'),
      action: bounds('.primary-action-dock > .primary-action-row > .button'),
      mainBottom: mainBounds.bottom,
    };
  });
  expect(initialLayout.date.bottom).toBeLessThanOrEqual(initialLayout.card.top);
  expect(initialLayout.card.bottom).toBeLessThanOrEqual(initialLayout.action.top);

  await primaryAction.scrollIntoViewIfNeeded();
  await expect(primaryAction).toBeInViewport();
  const scrolledLayout = await page.evaluate(() => {
    const main = document.querySelector('#main');
    const action = document.querySelector('.primary-action-dock > .primary-action-row > .button');
    if (!(main instanceof HTMLElement) || !(action instanceof HTMLElement))
      throw new Error('本文領域または保存操作がありません');
    const mainBounds = main.getBoundingClientRect();
    const actionBounds = action.getBoundingClientRect();
    return {
      mainTop: mainBounds.top,
      mainBottom: mainBounds.bottom,
      mainScrollTop: main.scrollTop,
      actionTop: actionBounds.top,
      actionBottom: actionBounds.bottom,
    };
  });
  expect(scrolledLayout.actionTop).toBeGreaterThanOrEqual(scrolledLayout.mainTop);
  expect(scrolledLayout.actionBottom).toBeLessThanOrEqual(scrolledLayout.mainBottom);
  if (initialLayout.action.bottom > initialLayout.mainBottom) {
    expect(scrolledLayout.mainScrollTop).toBeGreaterThan(0);
  }
});

test('オフライン通知と拡大表示がある短い画面でも記録ページ送りへ到達する', async ({ page }) => {
  await installMockUiRoutes(page, makeEntries(20));
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto('/library');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('tab', { name: 'リスト' }).click();
  const listPanel = page.getByRole('tabpanel', { name: 'リスト' });
  await expect(listPanel.locator('.entry-history-card')).toHaveCount(3);
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
      trigger: rect('.diary-date-trigger'),
      time: rect('.date-display time'),
      icon: rect('.date-display svg'),
      save: rect('.date-row > .button-text'),
    };
  });
  expect(layout.trigger.left).toBeGreaterThanOrEqual(layout.control.left);
  expect(layout.trigger.right).toBeLessThanOrEqual(layout.control.right + 1);
  expect(layout.control.bottom - layout.control.top).toBeGreaterThanOrEqual(44);
  expect(layout.trigger.right <= layout.save.left || layout.save.right <= layout.trigger.left).toBe(
    true,
  );
  expect(layout.save.right).toBeCloseTo(layout.row.right, 0);
  expect(
    Math.abs(layout.save.top + layout.save.bottom - layout.control.top - layout.control.bottom),
  ).toBeLessThanOrEqual(2);
  expect(layout.icon.left).toBeGreaterThanOrEqual(layout.time.right);
  expect(layout.icon.left - layout.time.right).toBeLessThanOrEqual(12);
  expect(
    Math.abs(layout.icon.top + layout.icon.bottom - layout.trigger.top - layout.trigger.bottom),
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
  const editDateControl = detailDateRow.locator('.date-control');
  await expect(editDateControl).toHaveCSS('outline-style', 'solid');
  await expect(editDateControl).toHaveCSS('outline-width', '2px');
  await expect(editDateControl).toHaveCSS('outline-color', 'rgb(85, 85, 85)');
  const editDateControlBounds = await editDateControl.boundingBox();
  expect(editDateControlBounds?.height ?? 0).toBeGreaterThanOrEqual(44);

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
    const trigger = document.querySelector('.diary-date-trigger');
    const save = document.querySelector('.date-row > .button-text');
    if (!row || !trigger || !save) throw new Error('日付行の操作要素がありません');
    const rowBounds = row.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const saveBounds = save.getBoundingClientRect();
    const saveTarget = document.elementFromPoint(
      saveBounds.left + saveBounds.width / 2,
      saveBounds.top + saveBounds.height / 2,
    );
    return {
      height: rowBounds.height,
      rowLeft: rowBounds.left,
      rowRight: rowBounds.right,
      triggerLeft: triggerBounds.left,
      triggerRight: triggerBounds.right,
      triggerTop: triggerBounds.top,
      triggerBottom: triggerBounds.bottom,
      saveLeft: saveBounds.left,
      saveRight: saveBounds.right,
      saveTop: saveBounds.top,
      saveBottom: saveBounds.bottom,
      saveReceivesPointer: Boolean(saveTarget && save.contains(saveTarget)),
    };
  });
  expect(largeDateRow.height).toBeGreaterThan(44);
  expect(largeDateRow.triggerLeft).toBeGreaterThanOrEqual(largeDateRow.rowLeft - 1);
  expect(largeDateRow.triggerRight).toBeLessThanOrEqual(largeDateRow.rowRight + 1);
  expect(largeDateRow.saveLeft).toBeGreaterThanOrEqual(largeDateRow.rowLeft - 1);
  expect(largeDateRow.saveRight).toBeLessThanOrEqual(largeDateRow.rowRight + 1);
  expect(
    largeDateRow.triggerRight <= largeDateRow.saveLeft ||
      largeDateRow.saveRight <= largeDateRow.triggerLeft ||
      largeDateRow.triggerBottom <= largeDateRow.saveTop ||
      largeDateRow.saveBottom <= largeDateRow.triggerTop,
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
