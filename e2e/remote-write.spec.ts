import AxeBuilder from '@axe-core/playwright';

import { expect, REMOTE_DATABASE, test } from './remote';
import { open } from './studio';

async function runInEditor(page: import('@playwright/test').Page, sql: string) {
  await open(page, '?tab=sql');
  await page.getByRole('textbox', { name: 'SQL editor' }).click();
  await page.keyboard.type(sql);
  await page.getByRole('button', { name: /^Run/ }).click();
}

test.describe('SQL editor, remote write mode', () => {
  test('DROP asks for the database name, then runs', async ({ page, remote }) => {
    await runInEditor(page, 'DROP TABLE notes');

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Run 1 statement on ${REMOTE_DATABASE}?`);
    await expect(dialog).toContainText('Acme Inc');
    await expect(dialog.getByText('destructive', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('DROP TABLE notes;');
    // Nothing has reached D1 yet.
    expect(remote.sent().some((sql) => sql.startsWith('DROP'))).toBe(false);

    const name = dialog.getByLabel(`Type ${REMOTE_DATABASE} to confirm`);
    const run = dialog.getByRole('button', { name: 'Run 1 statement' });
    await expect(name).toBeFocused();
    await expect(run).toBeDisabled();

    await name.fill('prod');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(run).toBeDisabled();

    // An outside click doesn't dismiss it.
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();

    await name.fill(REMOTE_DATABASE);
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await run.click();
    await expect(dialog).toBeHidden();
    expect(await remote.sql("SELECT name FROM sqlite_schema WHERE name = 'notes'")).toEqual([]);
  });

  test('Cancel runs nothing, and Esc closes the dialog', async ({ page, remote }) => {
    await runInEditor(page, 'DELETE FROM notes');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await remote.sql('SELECT count(*) FROM notes')).toEqual([[2]]);
  });

  test("a write that isn't destructive runs without a dialog", async ({ page, remote }) => {
    await runInEditor(page, 'UPDATE notes SET pinned = 1 WHERE id = 1');
    await expect(page.getByRole('status').filter({ hasText: 'changed' })).toContainText(
      '1 changed',
    );
    expect(await remote.sql('SELECT pinned FROM notes WHERE id = 1')).toEqual([[1]]);
  });
});

const USERS = { id: 1, email: 2, name: 3, age: 4 } as const;

async function stageName(page: import('@playwright/test').Page, row: number, text: string) {
  const cell = page
    .getByRole('grid', { name: 'users rows' })
    .locator(`[data-cell="${row}:${USERS.name}"]`);
  await cell.dblclick();
  await page.getByRole('textbox', { name: 'Edit name' }).fill(text);
  await page.keyboard.press('Enter');
}

test.describe('grid edits, remote write mode', () => {
  test('Apply lists the SQL first; Cancel runs nothing; Run applies it', async ({
    page,
    remote,
  }) => {
    await open(page, '?table=users');
    await expect(
      page.getByRole('grid', { name: 'users rows' }).locator('[data-cell="0:3"]'),
    ).toHaveText('User 1');
    await stageName(page, 0, "Ada O'Neil");
    const sentBefore = remote.sent().length;

    await page.getByRole('button', { name: 'Apply 1 change' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Run 1 statement on ${REMOTE_DATABASE}?`);
    await expect(dialog).toContainText('Acme Inc');
    // Params inlined for reading (quotes escaped), with the note that they are bound.
    await expect(dialog).toContainText(
      `UPDATE "users" SET "name" = 'Ada O''Neil' WHERE rowid = 1;`,
    );
    await expect(dialog).toContainText('run as bound parameters');
    await expect(dialog.getByText('destructive', { exact: true })).toHaveCount(0);
    // No name to type for a plain edit, and focus starts on Cancel, so Enter can't run it.
    await expect(dialog.getByLabel(/^Type .* to confirm$/)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    expect(
      remote
        .sent()
        .slice(sentBefore)
        .some((sql) => sql.startsWith('UPDATE')),
    ).toBe(false);
    expect(await remote.sql('SELECT name FROM users WHERE id = 1')).toEqual([['User 1']]);
    // Cancelling keeps the staged change.
    await expect(page.getByRole('region', { name: 'Staged changes' })).toContainText(
      '1 change staged',
    );

    await page.getByRole('button', { name: 'Apply 1 change' }).click();
    await dialog.getByRole('button', { name: 'Run 1 statement' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Applied 1 change: 1 row updated.')).toBeVisible();
    expect(await remote.sql('SELECT name FROM users WHERE id = 1')).toEqual([["Ada O'Neil"]]);
    // Sent as one batch, params bound.
    const sent = remote
      .sent()
      .slice(sentBefore)
      .filter((sql) => sql.startsWith('UPDATE'));
    expect(sent).toEqual(['UPDATE "users" SET "name" = ? WHERE rowid = ?']);
  });

  test('several changes are one dialog with a count, and Show SQL previews them', async ({
    page,
    remote,
  }) => {
    await open(page, '?table=users');
    const grid = page.getByRole('grid', { name: 'users rows' });
    await expect(grid.locator('[data-cell="0:3"]')).toHaveText('User 1');
    await stageName(page, 0, 'One');
    await stageName(page, 1, 'Two');
    await grid.getByRole('checkbox', { name: 'Select row 3' }).click();
    await page.getByRole('button', { name: 'Delete 1 row' }).click();

    await page.getByRole('button', { name: 'Show SQL' }).click();
    const sheet = page.getByRole('dialog', { name: 'SQL to run' });
    await expect(sheet).toContainText('DELETE FROM "users" WHERE rowid = 3;');
    await page.keyboard.press('Escape');
    // Show SQL runs nothing.
    expect(remote.sent().some((sql) => sql.startsWith('DELETE'))).toBe(false);

    await page.getByRole('button', { name: 'Apply 3 changes' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Run 3 statements on ${REMOTE_DATABASE}?`);
    await expect(dialog).toContainText('All statements run in one transaction.');
    await dialog.getByRole('button', { name: 'Run 3 statements' }).click();
    await expect(page.getByText('Applied 3 changes: 2 rows updated, 1 row deleted.')).toBeVisible();
    expect(await remote.sql('SELECT count(*) FROM users')).toEqual([[11]]);
  });

  test('a 429 keeps the dialog open and Retry works after the countdown', async ({
    page,
    remote,
  }) => {
    await open(page, '?table=users');
    await expect(
      page.getByRole('grid', { name: 'users rows' }).locator('[data-cell="0:3"]'),
    ).toHaveText('User 1');
    await stageName(page, 0, 'Retried');
    await page.getByRole('button', { name: 'Apply 1 change' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    remote.rateLimit(1, 2);
    await dialog.getByRole('button', { name: 'Run 1 statement' }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('Too many requests');
    const retry = alert.getByRole('button', { name: /^Retry/ });
    await expect(retry).toBeDisabled();
    await expect(retry).toContainText('Retry in');
    // Refused before it ran: nothing changed.
    expect(await remote.sql('SELECT name FROM users WHERE id = 1')).toEqual([['User 1']]);

    await expect(retry).toBeEnabled({ timeout: 6000 });
    await retry.click();
    await expect(dialog).toBeHidden();
    expect(await remote.sql('SELECT name FROM users WHERE id = 1')).toEqual([['Retried']]);
  });

  test('another failure shows in the dialog without a Retry, and nothing changed', async ({
    page,
    remote,
  }) => {
    await open(page, '?table=users');
    const grid = page.getByRole('grid', { name: 'users rows' });
    await expect(grid.locator('[data-cell="0:3"]')).toHaveText('User 1');
    await stageName(page, 0, 'Fine');
    const email = grid.locator(`[data-cell="1:${USERS.email}"]`);
    await email.dblclick();
    await page.getByRole('textbox', { name: 'Edit email' }).fill('user3@example.com');
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Apply 2 changes' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Run 2 statements' }).click();
    await expect(dialog.getByRole('alert')).toContainText('UNIQUE constraint failed: users.email');
    await expect(dialog.getByRole('button', { name: /^Retry/ })).toHaveCount(0);
    expect(await remote.sql('SELECT name FROM users WHERE id = 1')).toEqual([['User 1']]);
    // Still staged after closing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('region', { name: 'Staged changes' })).toContainText(
      '2 changes staged',
    );
  });
});

test.describe('accessibility', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme, () => {
      test.use({ colorScheme });

      test('the confirmation dialog, plain and with the name to type', async ({ page }) => {
        const check = async () => {
          // Contrast is measured on what is painted: let the dialog finish fading in.
          await page.evaluate(() =>
            Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
          );
          const { violations } = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          expect(
            violations.flatMap((v) =>
              v.nodes.map((n) => `${v.id}: ${n.target.join(' ')} :: ${n.failureSummary}`),
            ),
          ).toEqual([]);
        };
        await open(page, '?table=users');
        await expect(
          page.getByRole('grid', { name: 'users rows' }).locator('[data-cell="0:3"]'),
        ).toHaveText('User 1');
        await stageName(page, 0, 'Changed');
        await page.getByRole('button', { name: 'Apply 1 change' }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await check();
        await page.keyboard.press('Escape');

        await runInEditor(page, 'DROP TABLE notes');
        const dialog = page.getByRole('alertdialog');
        await dialog.getByLabel(`Type ${REMOTE_DATABASE} to confirm`).fill('nope');
        await check();
      });
    });
  }
});
