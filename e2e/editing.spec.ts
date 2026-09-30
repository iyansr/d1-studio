import type { Locator, Page } from "@playwright/test";
import { expect, footer, grid, open, test } from "./studio";

// Each spec gets its own throwaway project, so it may write.
test.use({ project: "editing", cliArgs: [] });

/** Column positions in an editable `users` grid: 0 is the checkbox column. */
const USERS = { id: 1, email: 2, name: 3, age: 4, score: 5, prefs: 6, bio: 7, active: 8 } as const;
const NOTES = { id: 1, title: 2, body: 3, pinned: 4 } as const;

const users = (page: Page) => grid(page, "users rows");
const cell = (g: Locator, row: number, col: number) => g.locator(`[data-cell="${row}:${col}"]`);
const staged = (page: Page) => page.getByRole("region", { name: "Staged changes" });
const rowCheckbox = (g: Locator, n: number) => g.getByRole("checkbox", { name: `Select row ${n}` });

/** Types into the in-cell editor of a cell and commits with Enter. */
async function editCell(
  page: Page,
  g: Locator,
  row: number,
  col: number,
  label: string,
  text: string,
) {
  await cell(g, row, col).dblclick();
  await page.getByRole("textbox", { name: `Edit ${label}` }).fill(text);
  await page.keyboard.press("Enter");
}

/** Runs SQL through the API as the page's session, to change data behind the UI's back. */
async function sql(page: Page, statement: string) {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(`${origin}/api/query`, {
    headers: { Origin: origin },
    data: { sql: statement },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { results: { rows: unknown[][] }[] };
}

test.describe("cells", () => {
  test("edits a cell, applies, and it survives a reload", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await expect(cell(g, 0, USERS.name)).toHaveText("User 1");

    await editCell(page, g, 0, USERS.name, "name", "Ada Lovelace");
    await expect(cell(g, 0, USERS.name)).toHaveText("Ada Lovelace");
    await expect(cell(g, 0, USERS.name)).toHaveAttribute("data-staged", "true");
    await expect(staged(page)).toContainText("1 change staged");

    await page.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByText("Applied 1 change: 1 row updated.")).toBeVisible();
    await expect(staged(page)).toHaveCount(0);
    await expect(cell(g, 0, USERS.name)).not.toHaveAttribute("data-staged", "true");

    await page.reload();
    await expect(cell(users(page), 0, USERS.name)).toHaveText("Ada Lovelace");
  });

  test("Enter, F2, typing and double-click start editing; Esc cancels, Tab commits and moves", async ({
    page,
  }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");

    // Typing a character replaces the text.
    await cell(g, 0, USERS.name).click();
    await page.keyboard.type("Z");
    const editor = page.getByRole("textbox", { name: "Edit name" });
    await expect(editor).toHaveValue("Z");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(cell(g, 0, USERS.name)).toHaveText("User 1");
    await expect(cell(g, 0, USERS.name)).toBeFocused();
    await expect(staged(page)).toHaveCount(0);

    // Enter and F2 open it with the text selected.
    await page.keyboard.press("Enter");
    await expect(editor).toHaveValue("User 1");
    await page.keyboard.press("Escape");
    await page.keyboard.press("F2");
    await expect(editor).toBeVisible();

    // Tab commits and moves to the next cell.
    await editor.fill("Tabbed");
    await page.keyboard.press("Tab");
    await expect(cell(g, 0, USERS.name)).toHaveText("Tabbed");
    await expect(cell(g, 0, USERS.age)).toBeFocused();

    // Setting a value back to what it was un-stages it.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await editor.fill("User 1");
    await page.keyboard.press("Enter");
    await expect(staged(page)).toHaveCount(0);
  });

  test("numbers: an invalid one blocks the commit, big integers stay exact, NULL can be set", async ({
    page,
  }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");

    await cell(g, 0, USERS.age).dblclick();
    const age = page.getByRole("spinbutton", { name: "Edit age" });
    await page.keyboard.type("1e");
    await page.keyboard.press("Enter");
    await expect(age).toHaveAttribute("aria-invalid", "true");
    await expect(age).toBeVisible();
    await expect(staged(page)).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("9007199254740993");
    await page.keyboard.press("Enter");
    await expect(cell(g, 0, USERS.age)).toHaveText("9007199254740993");

    // Set NULL from the button, and from the shortcut.
    await cell(g, 1, USERS.name).dblclick();
    await page.getByRole("button", { name: "Set NULL" }).click();
    await expect(cell(g, 1, USERS.name)).toHaveText("NULL");
    await cell(g, 2, USERS.name).dblclick();
    await page.keyboard.press("ControlOrMeta+Shift+N");
    await expect(cell(g, 2, USERS.name)).toHaveText("NULL");
    await expect(staged(page)).toContainText("3 changes staged");

    await page.getByRole("button", { name: "Apply 3 changes" }).click();
    await expect(page.getByText("Applied 3 changes: 3 rows updated.")).toBeVisible();
    const rows = (await sql(page, "SELECT age, name FROM users WHERE id <= 3 ORDER BY id"))
      .results[0]?.rows;
    expect(rows).toEqual([
      [{ $int: "9007199254740993" }, "User 1"],
      [22, null],
      [23, null],
    ]);
  });

  test("a BLOB and a generated-free view can't be edited", async ({ page }) => {
    await open(page, "?table=files");
    const files = grid(page, "files rows");
    await expect(cell(files, 0, 3)).toContainText("BLOB");
    await cell(files, 0, 3).dblclick();
    await expect(page.getByRole("textbox", { name: "Edit data" })).toHaveCount(0);
    await expect(staged(page)).toHaveCount(0);

    await open(page, "?table=user_emails");
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await expect(page.getByText("Views can't be edited.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add row" })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Select all rows" })).toHaveCount(0);
  });

  test("edits a row of a composite-key WITHOUT ROWID table", async ({ page }) => {
    await open(page, "?table=memberships");
    const g = grid(page, "memberships rows");
    await expect(footer(page)).toContainText("Rows 1–3 of 3");
    // select, org, usr, role
    await editCell(page, g, 1, 3, "role", "admin");
    await page.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByText("Applied 1 change: 1 row updated.")).toBeVisible();
    const rows = (await sql(page, "SELECT role FROM memberships ORDER BY usr, org")).results[0]
      ?.rows;
    // The grid is in key order (usr, org): the second row is usr 1, org 2.
    expect(rows).toEqual([["owner"], ["admin"], ["member"]]);
  });
});

test.describe("rows", () => {
  test("adds a row with defaults", async ({ page }) => {
    await open(page, "?table=notes");
    const g = grid(page, "notes rows");
    await expect(footer(page)).toContainText("Rows 1–2 of 2");

    await page.getByRole("button", { name: "Add row" }).click();
    // Pinned at the top, every column showing DEFAULT, and focus is on it.
    await expect(g.locator('[data-row-state="inserted"]')).toHaveCount(1);
    await expect(cell(g, 0, NOTES.title)).toHaveText("DEFAULT");
    await expect(cell(g, 0, NOTES.body)).toHaveText("DEFAULT");
    await expect(staged(page)).toContainText("1 change staged");

    await page.getByRole("button", { name: "Show SQL" }).click();
    await expect(page.getByRole("dialog", { name: "SQL to run" })).toContainText(
      'INSERT INTO "notes" DEFAULT VALUES;',
    );
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByText("Applied 1 change: 1 row inserted.")).toBeVisible();
    await expect(footer(page)).toContainText("Rows 1–3 of 3");
    await expect(g.locator('[data-row-state="inserted"]')).toHaveCount(0);
    const rows = (await sql(page, "SELECT title, body, pinned FROM notes WHERE id = 3")).results[0]
      ?.rows;
    expect(rows).toEqual([["untitled", "todo", 0]]);
  });

  test("an added row takes typed values, and NOT NULL is reported without losing them", async ({
    page,
  }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await page.getByRole("button", { name: "Add row" }).click();
    // email is NOT NULL with no default: applying now fails.
    await editCell(page, g, 0, USERS.name, "name", "New Person");
    // Cells of an added row don't count: the row is the change.
    await page.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByText(/NOT NULL constraint failed: users\.email/)).toBeVisible();
    await expect(g.locator('[data-row-state="failed"]')).toHaveCount(1);
    await expect(staged(page)).toBeVisible();

    await editCell(page, g, 0, USERS.email, "email", "new@example.com");
    await page.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByText(/row inserted/)).toBeVisible();
    const rows = (await sql(page, "SELECT email, name, active FROM users WHERE id = 13")).results[0]
      ?.rows;
    expect(rows).toEqual([["new@example.com", "New Person", 1]]);
  });

  test("selects rows with a Shift range, and deletes them", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    const all = page.getByRole("checkbox", { name: "Select all rows" });

    await rowCheckbox(g, 2).click();
    await expect(all).toHaveAttribute("aria-checked", "mixed");
    await rowCheckbox(g, 5).click({ modifiers: ["Shift"] });
    for (const n of [2, 3, 4, 5]) await expect(rowCheckbox(g, n)).toBeChecked();
    await expect(rowCheckbox(g, 6)).not.toBeChecked();
    await page.getByRole("button", { name: "Delete 4 rows" }).click();

    await expect(g.locator('[data-row-state="deleted"]')).toHaveCount(4);
    await expect(staged(page)).toContainText("4 changes staged");
    // A deleted row can't be selected or edited.
    await expect(rowCheckbox(g, 3)).toBeDisabled();
    await cell(g, 2, USERS.name).dblclick();
    await expect(page.getByRole("textbox", { name: "Edit name" })).toHaveCount(0);

    await page.getByRole("button", { name: "Apply 4 changes" }).click();
    await expect(page.getByText("Applied 4 changes: 4 rows deleted.")).toBeVisible();
    await expect(footer(page)).toContainText("Rows 1–8 of 8");
  });

  test("the header checkbox selects every row", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await g.getByRole("checkbox", { name: "Select all rows" }).click();
    await expect(page.getByRole("button", { name: "Delete 12 rows" })).toBeVisible();
    await g.getByRole("checkbox", { name: "Select all rows" }).click();
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  });

  test("discard all puts everything back", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await editCell(page, g, 0, USERS.name, "name", "Changed");
    await page.getByRole("button", { name: "Add row" }).click();
    await rowCheckbox(g, 4).click();
    await page.getByRole("button", { name: "Delete 1 row" }).click();
    await expect(staged(page)).toContainText("3 changes staged");

    await page.getByRole("button", { name: "Discard" }).click();
    await expect(staged(page)).toHaveCount(0);
    await expect(g.locator("[data-row-state]")).toHaveCount(0);
    await expect(cell(g, 0, USERS.name)).toHaveText("User 1");
    expect((await sql(page, "SELECT count(*) FROM users")).results[0]?.rows).toEqual([[12]]);
  });

  test("the context menu edits, sets NULL, reverts and deletes", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await cell(g, 0, USERS.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set NULL" }).click();
    await expect(cell(g, 0, USERS.name)).toHaveText("NULL");
    await cell(g, 0, USERS.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Revert change" }).click();
    await expect(cell(g, 0, USERS.name)).toHaveText("User 1");
    await cell(g, 1, USERS.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit cell" }).click();
    await expect(page.getByRole("textbox", { name: "Edit name" })).toBeFocused();
    await page.keyboard.press("Escape");
    await cell(g, 1, USERS.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(g.locator('[data-row-state="deleted"]')).toHaveCount(1);
  });
});

test.describe("long text and JSON", () => {
  test("validates JSON, formats it, and stages the change", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");

    await cell(g, 0, USERS.prefs).dblclick();
    const sheet = page.getByRole("dialog", { name: "prefs" });
    const stage = sheet.getByRole("button", { name: "Stage change" });
    await expect(sheet).toContainText('"theme": "dark"');
    await expect(stage).toBeDisabled();

    // Break it: an alert appears and staging is blocked.
    const editor = sheet.getByRole("textbox", { name: "prefs value" });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("oops");
    await expect(sheet.getByRole("alert")).toContainText("Invalid JSON");
    await expect(stage).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Format" })).toBeDisabled();

    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type('{"theme":"light"}');
    await sheet.getByRole("button", { name: "Format" }).click();
    await expect(sheet).toContainText('"theme": "light"');
    await stage.click();

    await expect(sheet).toHaveCount(0);
    await expect(cell(g, 0, USERS.prefs)).toHaveAttribute("data-staged", "true");
    await page.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByText("Applied 1 change: 1 row updated.")).toBeVisible();
    const rows = (await sql(page, "SELECT prefs FROM users WHERE id = 1")).results[0]?.rows;
    expect(JSON.parse(String(rows?.[0]?.[0]))).toEqual({ theme: "light" });
  });

  test("Cancel leaves the cell alone, and multi-line text opens the sheet", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    // bio of row 2 has two lines: Enter opens the sheet, not the in-cell editor.
    await cell(g, 1, USERS.bio).click();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "bio" });
    await expect(sheet).toContainText("first line");
    await sheet.getByRole("textbox", { name: "bio value" }).click();
    await page.keyboard.type("changed ");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(staged(page)).toHaveCount(0);
  });
});

test.describe("guards", () => {
  test("reloading or closing with staged changes asks first", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");

    // Nothing staged: no prompt.
    const clean = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(clean).toBe(false);

    await editCell(page, g, 0, USERS.name, "name", "Unsaved");
    const staged = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(staged).toBe(true);

    // And the browser really asks.
    const dialogs: string[] = [];
    page.once("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.accept();
    });
    await page.reload();
    expect(dialogs).toEqual(["beforeunload"]);
  });

  test("leaving the table asks: Stay keeps the changes, Discard drops them", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await editCell(page, g, 0, USERS.name, "name", "Unsaved");

    await page.locator("[data-table-item]", { hasText: "notes" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("1 staged change");
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/table=users/);
    await expect(cell(g, 0, USERS.name)).toHaveText("Unsaved");

    await page.locator("[data-table-item]", { hasText: "notes" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/table=notes/);
    await expect(footer(page)).toContainText("Rows 1–2 of 2");
    // The old table's changes are gone.
    await page.locator("[data-table-item]", { hasText: "users" }).click();
    await expect(cell(users(page), 0, USERS.name)).toHaveText("User 1");
    await expect(staged(page)).toHaveCount(0);
  });

  test("staged changes survive paging, sorting and a tab switch", async ({ page }) => {
    await open(page, "?table=users&size=50");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await editCell(page, g, 0, USERS.name, "name", "Kept");

    // Sort the other way: the row moves, its change stays on it.
    await g
      .getByRole("columnheader", { name: /Primary key id/ })
      .getByRole("button")
      .first()
      .click();
    await g
      .getByRole("columnheader", { name: /Primary key id/ })
      .getByRole("button")
      .first()
      .click();
    await expect(page).toHaveURL(/sort=id%3Adesc/);
    await expect(cell(g, 11, USERS.name)).toHaveText("Kept");
    await expect(staged(page)).toContainText("1 change staged");

    await page.getByRole("tab", { name: "Structure" }).click();
    await page.getByRole("tab", { name: "Data" }).click();
    await expect(staged(page)).toContainText("1 change staged");
    await expect(cell(users(page), 11, USERS.name)).toHaveText("Kept");
  });
});

test.describe("failures", () => {
  test("a row deleted behind our back is a conflict: nothing applies, the row is marked", async ({
    page,
  }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await editCell(page, g, 0, USERS.name, "name", "First");
    await editCell(page, g, 4, USERS.name, "name", "Fifth");
    await sql(page, "DELETE FROM users WHERE id = 5");

    await page.getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(page.getByText(/changed or deleted since it was loaded/)).toBeVisible();
    await expect(g.locator('[data-row-state="failed"]')).toHaveCount(1);
    await expect(cell(g, 4, USERS.name)).toHaveText("Fifth");
    // Still staged, and the first update was rolled back.
    await expect(staged(page)).toContainText("2 changes staged");
    expect((await sql(page, "SELECT name FROM users WHERE id = 1")).results[0]?.rows).toEqual([
      ["User 1"],
    ]);
  });

  test("a constraint failure names the row and keeps the batch", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await editCell(page, g, 0, USERS.name, "name", "Fine");
    await editCell(page, g, 1, USERS.email, "email", "user3@example.com");
    await page.getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(page.getByText(/UNIQUE constraint failed: users\.email/)).toBeVisible();
    await expect(g.locator('[data-row-state="failed"]')).toHaveCount(1);
    await expect(cell(g, 1, USERS.email)).toHaveText("user3@example.com");
    expect((await sql(page, "SELECT name FROM users WHERE id = 1")).results[0]?.rows).toEqual([
      ["User 1"],
    ]);
  });
});

test.describe("read-only", () => {
  test.use({ cliArgs: ["--no-write"] });

  test("shows no editing controls, and the server refuses edits", async ({ page }) => {
    await open(page, "?table=users");
    const g = users(page);
    await expect(footer(page)).toContainText("Rows 1–12 of 12");
    await expect(page.getByRole("button", { name: "Add row" })).toHaveCount(0);
    await expect(g.getByRole("checkbox")).toHaveCount(0);
    await cell(g, 0, 2).dblclick();
    await expect(page.getByRole("textbox", { name: /^Edit/ })).toHaveCount(0);
    await cell(g, 0, 1).click();
    await page.keyboard.type("x");
    await expect(page.getByRole("textbox", { name: /^Edit/ })).toHaveCount(0);

    const origin = new URL(page.url()).origin;
    const res = await page.request.post(`${origin}/api/batch`, {
      headers: { Origin: origin },
      data: { table: "users", ops: [{ op: "delete", key: { kind: "rowid", rowid: 1 } }] },
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "Read-only mode: DELETE is not allowed. Restart with --write to enable edits.",
      },
    });
  });
});
