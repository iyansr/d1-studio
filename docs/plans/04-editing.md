# Plan 04 — Editing (M4)

**Goal.** The user can edit cells, add rows and delete rows in the grid. Changes are staged locally and applied as one transaction. Remote write mode shows the exact SQL before running it, and destructive SQL requires typing the database name. The server enforces this, not only the UI.

**PRD coverage:** UI-5, the editing half of UI-6, and "Edit flow in remote write mode".

**Before starting:** S1 (plan 03) must have established how a remote batch is atomic. If D1 REST can't guarantee atomicity, agree a fallback with the owner first. The options are per-statement apply with a report of what succeeded, or refusing multi-statement remote batches.

**Exit criteria**

- Edit, add and delete work end to end in local mode, and survive a reload.
- A batch that fails mid-way leaves the database unchanged. Tested locally, and live for remote.
- In remote write mode, a batch without the confirmation token gets 409. A batch with dangerous statements and the wrong database name gets 403.
- Read-only mode shows no editing controls, and the server rejects edits with 403 (03-T5).

---

## T1 — Edit op model (S)

These types live in `src/shared/edits.ts`:

```ts
type RowKey =
  | { kind: "rowid"; rowid: number | string }          // string when > 2^53
  | { kind: "pk"; values: Record<string, CellValue> };

type EditOp =
  | { op: "update"; key: RowKey; set: Record<string, CellValue> }
  | { op: "insert"; values: Record<string, CellValue> } // omitted cols → DEFAULT
  | { op: "delete"; key: RowKey };

type CellValue = null | number | string | { $int: string }; // blobs not editable in v1
```

## T2 — Edit compiler (M)

File: `src/sql/edits.ts`. The function is pure: `compileEdits(schema, ops) → Stmt[]`.

- Every column and the table are checked against `TableSchema`, then quoted with `quoteIdent`.
- An update compiles to `UPDATE "t" SET "a" = ?, "b" = ? WHERE rowid = ?`, or `WHERE "k1" = ? AND "k2" = ?` for a composite PK.
- An insert compiles to `INSERT INTO "t" ("a", "b") VALUES (?, ?)`, or `INSERT INTO "t" DEFAULT VALUES` when there are no values.
- A delete compiles to `DELETE FROM "t" WHERE …`.
- Refusals:
  - views
  - tables with `key.kind === "none"`
  - writes to generated columns
  - `$blob` values
- Order: deletes, then updates, then inserts. Deleting first avoids unique-key clashes when a user deletes a row and re-adds it.
- `{ $int }` values bind as `BigInt` locally and as a string remotely. Whether D1 coerces that string correctly is part of S1.

**Tests:**
- rowid, composite PK and WITHOUT ROWID tables
- a reserved-word column (`"order"`)
- a column name containing `"`
- setting NULL
- an unknown column rejected
- ordering

## T3 — Batch endpoint (M)

`POST /api/batch` with `{ table, ops, confirm? }` and an optional `?dryRun=1`.

- The server compiles the ops with T2 and classifies each statement (01-T6).
- **dryRun** returns `{ statements: [{ sql, params }], dangerous: boolean, requiresConfirm: "none" | "click" | "type-name" }`:
  - `"none"` in local mode
  - `"click"` in remote write mode
  - `"type-name"` in remote write mode when any statement is dangerous (D12)
- **Apply** recompiles, so it never trusts client-sent SQL, and enforces:
  - In remote write mode, `confirm` must be present. Otherwise the server responds 409 `confirmation_required` with the statements.
  - If any statement is dangerous, `confirm` must equal the database name. Otherwise it responds 403.
- Execution uses `driver.batch`. Locally, each UPDATE and DELETE must report `changes === 1`, checked inside the transaction. A mismatch rolls back and returns `409 { error: "conflict", statementIndex }`, because the row changed or disappeared since it was loaded.
  - Remote handling follows S1. If per-statement `changes` can't abort an atomic batch, report any `changes: 0` statements as warnings after apply.
- After apply, invalidate the `SchemaCache` for DDL, and the row caches.

## T4 — SQL editor writes (S)

The same guard applies to `/api/query` in remote write mode:

- When a statement is dangerous and no matching `confirm` is present, the server responds 409 with the statement list.
- The UI shows the T6 dialog and resends with `confirm`.
- Non-dangerous writes from the editor run without a dialog, because the user wrote the SQL.
- Local mode has no dialogs.

## T5 — Staging store (UI) (M)

`ui/src/edits/useStagedEdits.ts` keeps one store per table, keyed by the row key string (not the row index), so changes survive paging and sorting.

- State: `updates: Map<key, Record<col, value>>`, `inserts: Array<{ tempId, values }>` and `deletes: Set<key>`.
- The total `N` counts the changed cells, plus inserted and deleted rows. It feeds "Apply N changes".
- Actions: revert a cell, revert a row, discard all, and build the ops.
- Leaving a table with `N > 0` asks whether to discard or stay. A `beforeunload` guard applies while `N > 0`.

## T6 — Grid editing UI (L)

This extends `DataGrid` from plan 02 and is disabled when `readOnly` is set or the table has no key.

- **Cell editing.** Enter, F2, double-click or typing a character starts editing. Esc cancels, while Enter and Tab commit to staging.
  - The in-cell editor is an `InputGroup` with an `InputGroupInput`: `type="number"` for INTEGER and REAL affinity, text otherwise.
  - An `InputGroupAddon` holds a "Set NULL" `Button` (`size="icon-xs"`, `variant="ghost"`, with a `Tooltip` showing Ctrl/Cmd+Shift+N).
  - An invalid number sets `aria-invalid` on the input and blocks the commit.
- **Expand editor (UI-6).** The plan-02 `Sheet` becomes editable. It holds CodeMirror, with JSON mode when the value parses.
  - Invalid JSON shows an `Alert variant="destructive"` inside the sheet and blocks staging.
  - `SheetFooter` has "Format", "Cancel" and "Stage change" `Button`s.
- **Visual states.** These use our semantic tokens from 02-T1 (`--staged`, `--inserted`, `--deleted`) through `cn()`, never raw Tailwind colours:
  - Edited cells get a `bg-staged` background and a dot.
  - Inserted rows are pinned at the top with an `border-inserted` edge.
  - Deleted rows get `line-through`, are dimmed and have an `border-deleted` edge.
- **Rows.**
  - A `Checkbox` column selects rows, with Shift-click for ranges. The header checkbox is indeterminate when some rows are selected.
  - "Delete N rows" (`variant="destructive"`) stages the deletes.
  - "Add row" inserts a blank staged row with `DEFAULT` placeholders.
- **Toolbar.** It appears only when `N > 0`.
  - "Apply N changes" is the default `Button`, with `Spinner` and `disabled` while pending.
  - "Discard" is `variant="outline"`.
  - "Show SQL" is `variant="link"`. It calls dryRun and shows the statements in a `Sheet` with read-only CodeMirror.
- **After apply.** Refetch the page, clear staging and call `toast.success()` with the rows affected.
- **Errors.** A conflict (409) or D1 error keeps the staged changes, highlights the failing op's row, and calls `toast.error()` with the verbatim message.
- **Leave guard.** Leaving a table with staged changes (T5) uses an `AlertDialog` with "Stay" and "Discard changes" (`variant="destructive"`).

## T7 — Confirmation dialog (M)

The flow depends on the mode:

- **Local:** apply directly. No dialog, keeping the loop fast while seeding.
- **Remote write:** Apply triggers a dryRun, then opens an `AlertDialog`. It is a confirmation of an irreversible action, so it must not close on an outside click.
  - `AlertDialogHeader` holds the `AlertDialogTitle` ("Run 4 statements on prod-db?") and an `AlertDialogDescription` naming the account and database. The accent comes from `data-mode="remote"`.
  - The body lists every statement in a `ScrollArea` with read-only, highlighted CodeMirror. Params are shown inlined for readability, with a note that they run as bound parameters.
  - Dangerous statements get a `Badge variant="destructive"` reading "destructive".
  - If `requiresConfirm === "type-name"`, a `Field` appears with a `FieldLabel` reading "Type prod-db to confirm" and an `Input`. It sets `data-invalid` and `aria-invalid` on mismatch. The `AlertDialogAction` stays `disabled` until the name matches.
  - `AlertDialogFooter` has `AlertDialogCancel` and `AlertDialogAction`. The action button reads "Run 4 statements", uses `variant="destructive"` when any statement is dangerous, and shows `Spinner` while running.
  - Run sends the ops with `confirm`.
- The editor path (T4) reuses the same component, fed from the 409 statement list.
- The dialog must be fully keyboard-operable. `AlertDialog` provides the focus trap and Esc. Initial focus goes to Cancel, or to the name input when typing is required, so Enter never runs statements by default.

## T8 — Tests (M)

- **Unit:** the compiler (T2), and a table of confirmation rules covering mode × readOnly × dangerous.
- **Integration (local):**
  - A batch whose 3rd op fails leaves no changes.
  - Deleting a row between staging and apply gives a 409 conflict and rolls back.
  - A read-only server rejects `/api/batch` with 403.
- **Server (remote, mocked driver):**
  - No confirm gives 409.
  - A dangerous statement with the wrong name gives 403.
  - The right name runs the batch.
  - dryRun output matches the statements executed.
- **Playwright (local fixture):**
  - edit a cell, apply, reload and check it persisted
  - add a row with defaults
  - multi-select and delete
  - discard all
  - JSON editor validation
  - the beforeunload guard
- **Playwright (remote write UI)** against a server started with a fake RemoteDriver through a test-only factory hook. It covers the dialog lists the SQL, typing the name for DROP from the editor, and Retry after a mocked 429.
