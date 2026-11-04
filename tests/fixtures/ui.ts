import { expect, type Page } from '@playwright/test';

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
