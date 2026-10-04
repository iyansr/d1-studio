import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, footer, open, test } from './studio';

async function expectNoViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = violations.map((v) => ({
    id: v.id,
    help: v.help,
    nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} :: ${n.failureSummary ?? ''}`),
  }));
  expect(summary).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`axe (${colorScheme})`, () => {
    test.use({ colorScheme });

    test('data tab, with a filter', async ({ page }) => {
      await open(
        page,
        `?table=users&f=${encodeURIComponent('[{"col":"score","op":"gt","value":10}]')}`,
      );
      await expect(footer(page)).toContainText('Rows 1–50');
      await expectNoViolations(page);
    });

    test('structure tab', async ({ page }) => {
      await open(page, '?table=sessions&tab=structure');
      await expect(page.getByText('sessions_live')).toBeVisible();
      await expectNoViolations(page);
    });

    test('SQL tab, with results and with an error', async ({ page }) => {
      await open(page, '?tab=sql');
      await page.getByRole('textbox', { name: 'SQL editor' }).click();
      await page.keyboard.type('SELECT * FROM users LIMIT 5; SELECT 1 AS one');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByRole('grid', { name: 'Result 2' })).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('SELECT * FROM nope');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByText('no such table: nope')).toBeVisible();
      await expectNoViolations(page);
    });

    test.describe('write mode', () => {
      test.use({ cliArgs: [] });
      test('data tab with the wrangler dev notice', async ({ page }) => {
        await open(page, '?table=files');
        await expect(page.getByText('SQLITE_BUSY')).toBeVisible();
        await expectNoViolations(page);
      });
    });

    test.describe('editing', () => {
      test.use({ project: 'editing', cliArgs: [] });

      test('grid with every staged state, and the in-cell editor', async ({ page }) => {
        await open(page, '?table=users');
        const users = page.getByRole('grid', { name: 'users rows' });
        await expect(users.locator('[data-cell="0:3"]')).toHaveText('User 1');
        await users.locator('[data-cell="0:3"]').dblclick();
        await page.getByRole('textbox', { name: 'Edit name' }).fill('Changed');
        await page.keyboard.press('Enter');
        await users.getByRole('checkbox', { name: 'Select row 3' }).click();
        await page.getByRole('button', { name: 'Delete 1 row' }).click();
        await page.getByRole('button', { name: 'Add row' }).click();
        await expect(users.locator('[data-row-state]')).toHaveCount(2);
        await expectNoViolations(page);

        // Row 2 (after the pinned new row): the age column has a number editor.
        await users.locator('[data-cell="2:4"]').dblclick();
        await expect(page.getByRole('spinbutton', { name: 'Edit age' })).toBeVisible();
        await expectNoViolations(page);
      });

      test('expand editor with invalid JSON', async ({ page }) => {
        await open(page, '?table=users');
        const users = page.getByRole('grid', { name: 'users rows' });
        await users.locator('[data-cell="0:6"]').dblclick();
        const sheet = page.getByRole('dialog', { name: 'prefs' });
        await sheet.getByRole('textbox', { name: 'prefs value' }).click();
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.type('oops');
        await expect(sheet.getByRole('alert')).toBeVisible();
        await expectNoViolations(page);
      });

      test('leave guard', async ({ page }) => {
        await open(page, '?table=users');
        const users = page.getByRole('grid', { name: 'users rows' });
        await users.locator('[data-cell="0:3"]').dblclick();
        await page.getByRole('textbox', { name: 'Edit name' }).fill('Changed');
        await page.keyboard.press('Enter');
        await page.locator('[data-table-item]', { hasText: 'notes' }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await expectNoViolations(page);
      });
    });

    test.describe('needs-db', () => {
      test.use({ project: 'unmatched' });
      test('picker', async ({ page }) => {
        await expect(page.getByRole('list', { name: 'Local database files' })).toBeVisible();
        await expectNoViolations(page);
      });
    });
  });
}

/** Presses Tab (or Shift+Tab) until `matches` holds for the focused element. */
async function tabTo(page: Page, matches: (el: Element) => boolean, shift = false) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    if (await page.evaluate(`(${matches.toString()})(document.activeElement)`)) return;
  }
  throw new Error('Focus never reached the target');
}

test('keyboard only: open, sort, filter, page, Structure, run a query, read the error', async ({
  page,
}) => {
  // Open a table from the sidebar.
  await page.locator('body').press('/');
  await page.keyboard.type('users');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/table=users/);

  // Sort: into the grid, up to the header row, across to email.
  await tabTo(page, (el) => el.closest('[role=grid]') !== null);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sort=email%3Aasc/);

  // Add a filter: score > 100.
  await tabTo(page, (el) => el.textContent?.startsWith('Filter') === true, true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Column' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Column' })).toHaveText('score');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Operator' })).toHaveText('>');
  await page.keyboard.press('Tab');
  await page.keyboard.type('100');
  await page.keyboard.press('Enter');
  await expect(footer(page)).toContainText('of 174');

  // Page.
  await tabTo(page, (el) => el.getAttribute('aria-label') === 'Next page');
  await page.keyboard.press('Enter');
  await expect(footer(page)).toContainText('Rows 51–100 of 174');

  // Structure.
  await tabTo(page, (el) => el.getAttribute('role') === 'tab', true);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByText('CREATE statement')).toBeVisible();

  // Run a query and read the error.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await tabTo(page, (el) => el.getAttribute('aria-label') === 'SQL editor');
  await page.keyboard.type('SELECT * FROM nope');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'failed' })).toContainText(
    'no such table: nope',
  );
});
