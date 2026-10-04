import { expect, footer, grid, open, test } from './studio';

test.describe('sidebar', () => {
  test('filters by name and toggles system tables', async ({ page }) => {
    const sidebar = page.locator('[data-sidebar=sidebar]');
    const items = sidebar.locator('[data-table-item]');
    await expect(items).toHaveText(['big', 'files', 'sessions', 'users', 'active_sessions']);

    await page.locator('body').press('/');
    const filter = page.getByRole('textbox', { name: 'Filter tables' });
    await expect(filter).toBeFocused();
    await filter.fill('SES');
    await expect(items).toHaveText(['sessions', 'active_sessions']);
    await filter.fill('zzz');
    await expect(sidebar.getByText('No matches')).toBeVisible();
    await filter.fill('');

    await expect(sidebar.getByText('_cf_KV')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show system tables' }).click();
    await expect(sidebar.getByText('_cf_KV')).toBeVisible();
    await expect(sidebar.getByText('d1_migrations')).toBeVisible();
  });
});

test.describe('data', () => {
  test('opens a table, sorts, pages at 500 and filters IS NULL', async ({ page }) => {
    await page.locator('[data-table-item]', { hasText: 'users' }).click();
    const users = grid(page, 'users rows');
    await expect(footer(page)).toContainText('Rows 1–50 of 240');

    await users
      .getByRole('columnheader', { name: /^email/ })
      .getByRole('button')
      .first()
      .click();
    await expect(page).toHaveURL(/sort=email%3Aasc/);
    await expect(users.locator('[data-cell="0:1"]')).toHaveText('user100@example.com');

    await page.getByRole('button', { name: '500 rows per page' }).click();
    await expect(footer(page)).toContainText('Rows 1–240 of 240');

    await page.getByRole('button', { name: /^Filter/ }).click();
    await page.getByRole('combobox', { name: 'Column' }).click();
    await page.getByRole('option', { name: 'name', exact: true }).click();
    await page.getByRole('combobox', { name: 'Operator' }).click();
    await page.getByRole('option', { name: 'IS NULL', exact: true }).click();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(footer(page)).toContainText('Rows 1–34 of 34');
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('name IS NULL');
    await expect(users.locator('[data-cell="0:2"]')).toHaveText('NULL');
  });

  test('shows the FK icon with its target in a tooltip', async ({ page }) => {
    await open(page, '?table=sessions');
    const header = grid(page, 'sessions rows').getByRole('columnheader', { name: /user_id/ });
    await header.getByLabel('Foreign key to users.id').hover();
    await expect(page.getByText('→ users.id')).toBeVisible();
  });

  test('renders NULL, BLOB sizes, big integers and JSON', async ({ page }) => {
    await open(page, '?table=files');
    const files = grid(page, 'files rows');
    await expect(files.locator('[data-cell="0:2"]')).toHaveText('BLOB · 2.4 KB');
    await expect(files.locator('[data-cell="2:2"]')).toHaveText('NULL');
    await expect(files.locator('[data-cell="0:3"]')).toHaveText('9007199254740993');
    await open(page, '?table=users');
    const prefs = grid(page, 'users rows').locator('[data-cell="0:3"]');
    await expect(prefs).toContainText('{}');
    await prefs.dblclick();
    const sheet = page.getByRole('dialog', { name: 'prefs' });
    await expect(sheet).toContainText('"theme": "dark"');
  });
});

test('the Structure tab shows the DDL', async ({ page }) => {
  await open(page, '?table=sessions&tab=structure');
  await expect(page.getByText('sessions_live')).toBeVisible();
  await expect(page.getByText('expires_at IS NOT NULL')).toBeVisible();
  await expect(page.getByLabel('CREATE statement for sessions')).toContainText(
    'CREATE TABLE sessions',
  );
});

test.describe('SQL', () => {
  test('runs with Mod+Enter and shows the count and duration', async ({ page }) => {
    await open(page, '?tab=sql');
    const editor = page.getByRole('textbox', { name: 'SQL editor' });
    await editor.click();
    await page.keyboard.type('SELECT id, email FROM users WHERE id <= 3 ORDER BY id');
    await page.keyboard.press('ControlOrMeta+Enter');
    const result = grid(page, 'Result 1');
    await expect(result.locator('[data-cell="2:1"]')).toHaveText('user3@example.com');
    const status = page.getByRole('status').filter({ hasText: 'rows' });
    await expect(status).toContainText('3 rows');
    await expect(status).toContainText(/\d ms/);
  });

  test('Tab accepts an open completion, and still moves focus when none is open', async ({
    page,
  }) => {
    await open(page, '?tab=sql');
    const editor = page.getByRole('textbox', { name: 'SQL editor' });
    await editor.click();
    await page.keyboard.type('SELECT * FROM ses');
    await expect(page.getByRole('option', { name: /sessions/ }).first()).toBeVisible();
    // CodeMirror ignores accepts for 75 ms after the popup opens (interactionDelay).
    await page.waitForTimeout(100);
    await page.keyboard.press('Tab');
    await expect(editor).toContainText('SELECT * FROM sessions');
    await expect(editor).toBeFocused();
    await expect(page.getByRole('option')).toHaveCount(0);

    // Nothing to accept now: Tab leaves the editor, as before.
    await page.keyboard.press('Tab');
    await expect(editor).not.toBeFocused();
  });

  test("shows a bad query's error verbatim", async ({ page }) => {
    await open(page, '?tab=sql');
    await page.getByRole('textbox', { name: 'SQL editor' }).click();
    await page.keyboard.type('SELECT 1; SELECT * FROM nope');
    await page.getByRole('button', { name: /^Run/ }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'failed' });
    await expect(alert).toContainText('Statement 2 failed');
    await expect(alert).toContainText('no such table: nope');
  });
});

test.describe('needs-db', () => {
  test.use({ project: 'unmatched' });

  test('picks a local file when none matches the binding', async ({ page }) => {
    await expect(page.getByRole('alert').first()).toContainText(
      "Couldn't match binding DB to a local file.",
    );
    const cards = page.getByRole('list', { name: 'Local database files' }).locator(':scope > li');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: /sessions, users/ }).click();
    await page.locator('[data-table-item]', { hasText: 'users' }).click();
    await expect(footer(page)).toContainText('Rows 1–2 of 2');
  });
});

test('perf: a 500-row page of a 100k-row table paints in < 500 ms', async ({ page }) => {
  await open(page, '?table=big');
  await expect(footer(page)).toContainText('of 100,000');
  await page.evaluate(() => performance.clearMarks());
  await page.getByRole('button', { name: '500 rows per page' }).click();
  await expect(footer(page)).toContainText('Rows 1–500 of 100,000');
  const ms = await page.evaluate(async () => {
    // The paint mark lands on the next animation frame.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.measure('rows', 'd1s:rows-request', 'd1s:grid-painted').duration;
  });
  console.log(`big: 500-row page painted ${ms.toFixed(1)} ms after the request started`);
  expect(ms).toBeLessThan(500);
});
