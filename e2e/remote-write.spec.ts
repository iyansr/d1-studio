import { expect, REMOTE_DATABASE, test } from "./remote";
import { open } from "./studio";

async function runInEditor(page: import("@playwright/test").Page, sql: string) {
  await open(page, "?tab=sql");
  await page.getByRole("textbox", { name: "SQL editor" }).click();
  await page.keyboard.type(sql);
  await page.getByRole("button", { name: /^Run/ }).click();
}

test.describe("SQL editor, remote write mode", () => {
  test("DROP asks for the database name, then runs", async ({ page, remote }) => {
    await runInEditor(page, "DROP TABLE notes");

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`Run 1 statement on ${REMOTE_DATABASE}?`);
    await expect(dialog).toContainText("Acme Inc");
    await expect(dialog.getByText("destructive", { exact: true })).toBeVisible();
    await expect(dialog).toContainText("DROP TABLE notes;");
    // Nothing has reached D1 yet.
    expect(remote.sent().some((sql) => sql.startsWith("DROP"))).toBe(false);

    const name = dialog.getByLabel(`Type ${REMOTE_DATABASE} to confirm`);
    const run = dialog.getByRole("button", { name: "Run 1 statement" });
    await expect(name).toBeFocused();
    await expect(run).toBeDisabled();

    await name.fill("prod");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(run).toBeDisabled();

    // An outside click doesn't dismiss it.
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();

    await name.fill(REMOTE_DATABASE);
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
    await run.click();
    await expect(dialog).toBeHidden();
    expect(await remote.sql("SELECT name FROM sqlite_schema WHERE name = 'notes'")).toEqual([]);
  });

  test("Cancel runs nothing, and Esc closes the dialog", async ({ page, remote }) => {
    await runInEditor(page, "DELETE FROM notes");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await remote.sql("SELECT count(*) FROM notes")).toEqual([[2]]);
  });

  test("a write that isn't destructive runs without a dialog", async ({ page, remote }) => {
    await runInEditor(page, "UPDATE notes SET pinned = 1 WHERE id = 1");
    await expect(page.getByRole("status").filter({ hasText: "changed" })).toContainText(
      "1 changed",
    );
    expect(await remote.sql("SELECT pinned FROM notes WHERE id = 1")).toEqual([[1]]);
  });
});
