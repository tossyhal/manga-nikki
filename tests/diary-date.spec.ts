import { expect, test, type Page } from '@playwright/test';
import { mockClientConfigFixture } from './fixtures/client-config';

async function prepareNewEntry(page: Page) {
  await page.clock.install({ time: new Date('2026-11-06T03:00:00.000Z') });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: mockClientConfigFixture }));
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
  await page.goto('/new');
}

test('カレンダーで日付を選ぶと入力へ反映して閉じる', async ({ page }) => {
  await prepareNewEntry(page);
  const trigger = page.getByRole('button', { name: '日付', exact: true });

  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '2026年11月' })).toBeVisible();
  await dialog.getByRole('button', { name: '2026年11月5日', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger.locator('time')).toHaveAttribute('datetime', '2026-11-05');
});

test('キーボード操作で開閉し、未来日を選べずEscape後にトリガーへ戻る', async ({ page }) => {
  await prepareNewEntry(page);
  const trigger = page.getByRole('button', { name: '日付', exact: true });

  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const today = dialog.getByRole('button', { name: '2026年11月6日', exact: true });
  const yesterday = dialog.getByRole('button', { name: '2026年11月5日', exact: true });
  await expect(today).toBeFocused();
  await expect(dialog.getByRole('button', { name: '2026年11月7日', exact: true })).toBeDisabled();

  await page.keyboard.press('ArrowLeft');
  await expect(yesterday).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Space');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
