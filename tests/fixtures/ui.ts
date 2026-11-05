import { expect, type Page } from '@playwright/test';
import { jstToday } from '../../src/shared/schemas';

export async function expectDefaultLibraryLocation(page: Page) {
  const today = jstToday();
  const expected = `/library?view=calendar&month=${today.slice(0, 7)}&day=${today}&listPage=1&dayPage=1`;
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(expected);
}

export async function openEntryMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'その他の操作' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

export async function clickEntryMenuItem(page: Page, name: string) {
  const menu = await openEntryMenu(page);
  await menu.getByRole('menuitem', { name, exact: true }).click();
}

export async function clickAppDialogButton(page: Page, title: string, buttonName: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: buttonName, exact: true }).click();
  await expect(dialog).toBeHidden();
}
