# Plan 02 — Read UI (M2)

**Goal.** A browsable studio over the plan-01 API: a sidebar, a paginated grid with sort and filter, a schema view, a SQL editor, and the local DB picker fallback. It works in both modes because it only talks to the server API.

**PRD coverage:** UI-1, 2, 3, 4, 6 (display half), 7, 8, 9 and 14, the grid performance metric, and the accessibility requirements.

**Exit criteria**

- The Playwright suite (T11) passes against the fixture project on all three OSes.
- A 500-row page of a 100k-row table renders in < 500 ms, measured from request start to first paint.
- The keyboard-only walkthrough (T10) passes, and axe finds no AA contrast violations in either theme.
- The UI bundle is ≤ 1.5 MB before gzip (raised from 1.2 MB once editing landed), which leaves room under the 3 MB package budget.

---

## T1 — UI scaffold (S)

- Create `ui/` as a private pnpm workspace package (D13) with `pnpm dlx shadcn@latest init --name ui --template vite --preset <preset>`. This generates Vite, React, TypeScript, Tailwind v4, `components.json`, the `@/` alias and `src/index.css` with the shadcn tokens.
  - Pick the preset at ui.shadcn.com; the default is `nova`. The base library defaults to Base UI. If you switch to Radix, component triggers use `asChild` instead of `render`, so decide once, before any components are added.
  - Icons come from the `iconLibrary` in `components.json` (lucide by default).
- Add the non-shadcn dependencies: TanStack Query, TanStack Table, TanStack Virtual, CodeMirror 6 and `hono/client`.
- Add the shadcn components up front, so every later task imports rather than builds them:

  ```bash
  pnpm dlx shadcn@latest add sidebar tabs badge button tooltip skeleton \
    table dropdown-menu context-menu popover select input input-group field \
    toggle-group switch checkbox sheet card alert empty scroll-area separator \
    dialog alert-dialog spinner sonner kbd resizable
  ```

  Read each added file after `add`, and exclude `ui/src/components/ui/` from Biome so regenerating components stays diff-free.
- The build outputs to `dist/ui/`, which the server serves (01-T8).
- Dev loop: `pnpm dev` runs the CLI with `--no-open` on `D1_STUDIO_DEV=1`, which adds `localhost:5173` to the allowed hosts and origins, and runs Vite with a `/api` proxy. The token handshake runs once through the proxy.
- API client: `hc<AppType>("/")` from `hono/client`, with typed queries per route.
- Theme (UI-14):
  - Use the shadcn semantic tokens (`bg-background`, `text-muted-foreground`, `border`, `destructive` and so on). No raw colours and no manual `dark:` overrides.
  - Dark mode is the shadcn `.dark` class, toggled by a small `ThemeProvider` that follows `prefers-color-scheme` and listens for changes. The PRD asks for the system setting only, so there's no toggle UI.
  - Add app tokens in `src/index.css` under `@theme inline`, with light and dark values: `--remote` (the remote accent) and `--staged`, `--inserted` and `--deleted` (used by plan 04).
  - A `data-mode="remote"` attribute on `<html>` points `--primary` and `--ring` at `--remote`, so every shadcn component picks up the accent without per-component overrides.
- Layout:
  - `SidebarProvider` with a shadcn `Sidebar` on the left and `SidebarInset` for the header and main area.
  - `Tabs` for **Data | Structure | SQL**.
  - `Toaster` from sonner, mounted once.
- URL state lives in search params (`?t=users&tab=data&p=0&size=50&sort=id:asc&f=…`), managed by a `useUrlState` hook with `history.replaceState`. Reload and back work, and links can be shared on the same machine.

## T2 — Header (UI-1) (S)

- Show the mode as a `Badge` (`local` / `remote`), the database name with the binding and a short ID in a `Tooltip`, and a **READ-ONLY** (`variant="secondary"`) or **WRITE** (`variant="default"`) `Badge`.
- In remote mode, `data-mode="remote"` (T1) makes the primary colour the remote accent. The header also gets an accent top border that uses the `--remote` token.
- Put a `SidebarTrigger` at the start of the header.
- Data comes from `/api/meta`. The `state: "needs-db"` state routes to the picker (T9).

## T3 — Sidebar (UI-2) (M)

Built from shadcn `Sidebar` parts, loaded from `/api/tables`.

- `SidebarGroup` sections for Tables and Views, each with a `SidebarGroupLabel`. Each entry is a `SidebarMenuItem` with a `SidebarMenuButton` (`isActive` for the open table).
- Row counts go in `SidebarMenuBadge`, locale-formatted. Show `SidebarMenuSkeleton` while counts are pending; plan 03 loads them lazily in remote.
- `SidebarInput` in `SidebarHeader` filters by case-insensitive substring. `/` focuses it, and a `Kbd` hint shows the shortcut.
- A `Switch` in `SidebarFooter` labelled "Show system tables" reveals `_cf_*`, `d1_*` and `sqlite_*`. It is off by default, and the choice is stored in localStorage.
- Keyboard: the menu buttons get roving tabindex. ↑ and ↓ move, Enter opens, and Home and End jump. `SidebarProvider`'s built-in Cmd/Ctrl+B toggles the sidebar.
- An empty filter result shows `Empty`.

## T4 — Rows endpoint (server) (M)

Adds `GET /api/tables/:name/rows` and `src/sql/rows-query.ts`, which is pure.

- Query params:
  - `limit` must be one of 50, 100 or 500.
  - `offset` is an integer ≥ 0.
  - `sort` is `col:asc|desc` and may repeat.
  - `f` is a JSON array of `{ col, op, value? }`, where `op` is one of `eq ne lt gt le ge like nlike null nnull`.
  - `count=1` requests a total.
- The builder validates the table and every column against the `SchemaCache` (01-T7). Values are bound as `?`. `LIMIT` and `OFFSET` are inlined as validated integers (D10).
- The select depends on the row key:
  - A rowid table selects `rowid AS "__d1s_rowid", *`.
  - A WITHOUT ROWID table selects `*`, and its PK columns are the key.
  - A view selects `*` with no key.
- It fetches `limit + 1` rows to compute `hasMore`, so no count is needed for the pager.
- With `count=1`, it also runs `SELECT COUNT(*) FROM … WHERE …` in the same `batch`.
- The response is `{ columns: [{ name, type, pk, fk?: { table, column } }], rows, hasMore, total?, key: { kind: "rowid" | "pk" | "none", columns } }`.

**Tests:** snapshot tests of the generated SQL and params, and a column name like `x" OR 1=1 --` rejected as unknown. An unknown op returns 400. A 100k-row fixture page at offset 0 and at offset 90 000 is timed. If the deep offset exceeds budget locally, add keyset pagination for the default rowid/PK sort as a follow-up task; don't block on it.

## T5 — Grid (UI-3, UI-6 display) (L)

Component: `ui/src/grid/DataGrid.tsx`. It is reused by the SQL results (T8) and editing (plan 04).

This follows the shadcn "Data Table" pattern: TanStack Table rendered with the shadcn `Table` parts (`Table`, `TableHeader`, `TableRow`, `TableHead`, `TableBody`, `TableCell`). Virtualisation is our addition.

- TanStack Table runs in `manualPagination`, `manualSorting` and `manualFiltering` mode.
- TanStack Virtual virtualises rows, and columns once the table has more than 30. Virtual rows render inside `TableBody` with top and bottom spacer rows, so the markup stays a real `<table>`.
- The scroll container is `ScrollArea`, with a sticky `TableHeader`.
- Header cell: the column name, the type in `text-muted-foreground`, a key icon for PK and a link icon for FK (a `Tooltip` shows `→ table.column`), and the sort indicator.
  - Clicking cycles through asc, desc and none, and Shift-click adds a secondary sort.
  - A `DropdownMenu` on the header offers Sort asc, Sort desc, Filter… and Hide column.
- Footer: a `ToggleGroup` for page size (50 / 100 / 500; a 3-option set uses ToggleGroup, not Select), prev and next `Button`s (`variant="outline"`, `size="icon"`), and "Rows 51–100", plus "of 12,345" once the total is known. A "count" `Button` (`variant="link"`) fetches the total on demand.
- Cell renderers:
  - `null` shows as `NULL` in `text-muted-foreground` italics.
  - Numbers are right-aligned with `tabular-nums`.
  - Text is `truncate`d, with a `Tooltip` up to 500 chars.
  - Text that parses as a JSON object or array gets a `Badge variant="outline"` reading `{}`.
  - `{ $blob }` shows as `Badge variant="secondary"` reading `BLOB · 2.4 KB`.
  - `{ $int }` shows as the string.
- Loading uses `Skeleton` rows. An empty table or filter shows `Empty`.
- An expand panel (UI-6) opens on Enter or double-click on long text or JSON. It is a `Sheet` (`side="right"`, with a `SheetTitle` naming the column) containing read-only CodeMirror, pretty-printed JSON and a copy `Button`. Plan 04 makes it editable.
- Columns can be resized by dragging, and the widths are stored per table in localStorage.
- Keyboard (`role="grid"`): arrows move the focused cell. Home and End go to the row edges, Ctrl+Home and Ctrl+End to the grid corners, and PageUp and PageDown move by one viewport. Ctrl/Cmd+C copies the cell value.

## T6 — Filter builder (UI-4) (M)

- The toolbar **Filter** `Button` opens a `Popover`. Each filter row is a `Field` with `[column Select] [op Select] [value Input]` and a remove `Button` (`variant="ghost"`, `size="icon"`); an "Add filter" `Button` appends a row. The rows sit in a `FieldGroup` and combine with AND.
- The value `Input` adapts to the column type: `type="number"` for INTEGER and REAL affinity. It hides for `IS NULL` and `IS NOT NULL`. The `LIKE` op shows a `FieldDescription` hint about `%`.
- A bad value (for example text in a numeric column) sets `data-invalid` on the `Field` and `aria-invalid` on the control.
- Active filters show as `Badge`s under the toolbar, each with a remove button. Applying filters writes the `f` URL param and resets the page to 0.
- A `ContextMenu` on cells offers "Filter by this value", "Is NULL" and "Copy value".

## T7 — Schema view (UI-9) (S)

The **Structure** tab, driven by `/api/tables/:name/schema`. Each section is a `Card` (`CardHeader` with `CardTitle` and a `CardDescription` giving the count, then `CardContent`) with a shadcn `Table` inside:

- **Columns:** name, declared type, NOT NULL, default, PK ordinal, and generated or hidden flags. Flags are `Badge`s (`PK`, `NOT NULL`, `GENERATED`).
- **Indexes:** name, a `UNIQUE` badge, columns (with DESC markers), and the partial `WHERE`.
- **Foreign keys:** `from → table(to)`, ON UPDATE and ON DELETE. The referenced table is a `Button variant="link"` that opens it.
- **CREATE statement:** read-only CodeMirror with SQL highlighting and a copy `Button` in `CardHeader` that confirms with a sonner `toast`.
- Sections with nothing to show (no indexes, no FKs) use `Empty`.

## T8 — SQL editor (UI-7, UI-8) (L)

- CodeMirror 6 with `@codemirror/lang-sql` in `SQLite` dialect and a search panel. shadcn has no code editor, so this is the one custom surface. Its theme is built from the shadcn CSS variables (`var(--background)`, `var(--foreground)`, `var(--muted)`, `var(--ring)` and so on), so it follows light and dark mode and the remote accent automatically.
- Autocomplete: add `GET /api/schema/all`, which returns every table with its column names and types in one query:
  `SELECT m.name, p.name, p.type FROM sqlite_schema m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table','view')`.
  In remote, S5 confirms whether D1 allows this. If not, fall back to the per-table `describe` in a single batch. The result feeds the `schema` option of `sql()`.
- Ctrl/Cmd+Enter runs the selection if there is one, otherwise the whole document. The Run `Button` does the same: it shows a `Kbd` hint, and while running it shows `Spinner` with `data-icon="inline-start"` and is `disabled`.
- Results:
  - One tab per statement result, with the last one selected, using `Tabs` with `TabsTrigger`s inside `TabsList`.
  - Each result uses `DataGrid` in static mode: no server pagination and virtualised.
  - The status bar shows the row count, server-measured duration and `changes`, plus rows read and written when the driver reports them (remote).
  - Notices such as auto-LIMIT (plan 03) show as an `Alert` above the results.
- Errors: `Alert variant="destructive"` shows the D1 or SQLite message verbatim in `AlertDescription` (monospace), with the index of the failing statement in `AlertTitle`.
- Editor and results sit in a vertical `ResizablePanelGroup`, with a `ResizableHandle` between them.
- The editor text is saved per database ID in localStorage as a convenience. Query history is P1 and out of scope here.

## T9 — Local DB picker (S)

When `/api/meta` reports `state: "needs-db"`:

- The picker lists each candidate as a `Card`:
  - `CardTitle` shows a short file ID.
  - `CardDescription` shows the last modified time (relative) and the size.
  - `CardContent` lists table names as `Badge`s, with row counts.
  - This is the PRD's "tell DB from ANALYTICS at a glance".
- Selecting a card (the whole card is a button, keyboard-focusable) sends `POST /api/open { candidateId }`, invalidates all queries and loads the studio.
- An `Alert` heads the page: "Couldn't match binding `DB` to a local file. Pick the database:".

## T10 — Accessibility and theme pass (S)

- Run the axe-core Playwright check on each screen in both themes, with zero AA violations.
- Check the chosen preset's `--muted-foreground`, and our `--remote`, `--staged`, `--inserted` and `--deleted` tokens, for AA contrast against `--background` in both themes. The custom tokens are ours to get right.
- Focus rings must be visible on all interactive elements. shadcn provides them through `--ring`; our custom grid cells and CodeMirror must match.
- Every `Sheet` and `Dialog` must have a title. Use `className="sr-only"` if it's visually hidden.
- Walk through with the keyboard only: open a table from the sidebar, sort, add a filter, page, switch to Structure, run a query and read the error.

## T11 — E2E and perf (M)

- The fixture project `e2e/fixtures/project` has:
  - `users` with an INTEGER PK and JSON `prefs`
  - `sessions`, with an FK to `users`
  - `files`, with a BLOB
  - `big`, with 100k rows, generated at test setup
  - a view
  - `_cf_KV`
- Playwright starts `node dist/cli.js --no-open --port 0`, reads the token URL from stdout and runs:
  - sidebar filtering, and the system-table toggle
  - opening a table, sorting, page size 500, and the IS NULL filter
  - the FK icon and its tooltip
  - the schema tab's DDL
  - running a query with Cmd/Ctrl+Enter, checking the count and duration
  - a bad query, checking the verbatim error
  - the needs-db picker, in a fixture with an unmatched ID
- Every test fails on any browser console error. This catches CSP violations from injected styles (D13).
- The perf test covers `big` at page size 500, using `performance.mark` around fetch and render. It asserts < 500 ms, with a CI retry allowance.
