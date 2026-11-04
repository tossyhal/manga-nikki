import { expect, test, type Page } from '@playwright/test';
import { jstToday, type Entry, type EntryDetail } from '../src/shared/schemas';
import { draftEntryDetailFixture, mockClientConfigFixture } from './fixtures/client-config';

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

async function installMockUiRoutes(page: Page) {
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
    if (pathname === `/api/v1/entries/${entryId}`) return route.fulfill({ json: detailFixture });
    if (pathname === '/api/v1/entries')
      return route.fulfill({ json: { items: [entryFixture], nextCursor: null } });
    return route.continue();
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
    await expect(activeLink.locator('span')).toHaveAttribute('aria-hidden', 'false');
    for (const { activeName: otherName } of destinations) {
      if (otherName === activeName) continue;
      const otherLink = nav.getByRole('link', { name: otherName, exact: true });
      await expect(otherLink).not.toHaveAttribute('aria-current', 'page');
      await expect(otherLink.locator('span')).toHaveAttribute('aria-hidden', 'true');
    }

    const widths = await links.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
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
        await expect(page.getByRole('heading', { name: '今日の記録' })).toBeVisible();
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
