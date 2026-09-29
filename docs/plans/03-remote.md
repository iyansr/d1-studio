# Plan 03 — Remote mode (M3)

**Goal.** `d1-studio --remote` opens the deployed D1 database in the same UI, using credentials resolved automatically. Remote is read-only unless `--write` is passed, and read-only is enforced by the server. Row reads are guarded.

**PRD coverage:** zero-config discovery step 3b and the "No config" remote path, the remote-mode safety section, token handling in the security section, and the reliability NFR.

**Prerequisite:** a disposable D1 database on a test account for the spikes and the optional live suite. Never use a production DB.

**Exit criteria**

- In a project that has run `wrangler login`, `--remote` needs no flags and renders the first table in < 5 s.
- With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set and no Wrangler session, it also works.
- In read-only mode, `POST /api/query` with any write or DDL returns 403. This is covered by tests, not only the UI.
- A test proves that the token never appears in stdout, stderr, any HTTP response or any error.
- `--write` refuses to start without the typed database name on a TTY, or without `--yes` in a non-TTY run.

---

## T0 — Spikes S1, S2, S5 (day 1) (M)

Record the findings in `docs/notes/d1-rest.md` and `docs/notes/wrangler-auth.md`. Save redacted response fixtures to `test/fixtures/d1-api/` for the mocks.

- **S1, D1 REST**
  - Check `POST …/query` and `…/raw` with `{ sql, params }`, with multi-statement `sql`, and with a `{ batch: [{ sql, params }] }` body, if supported.
  - **Atomicity:** run a batch whose 2nd statement fails and check whether the 1st was rolled back.
  - **Param types:** number, null, boolean and blob; check whether numbers bind as text.
  - `/raw` output shape per statement, `meta` fields (`rows_read`, `rows_written`, `duration`, `changes`, `last_row_id`), the error envelope and codes, and 429 behaviour (`Retry-After`).
  - **Outcome:** how `RemoteDriver.batch` achieves "one transaction". If no atomic API exists, raise it with the owner before plan 04, because it changes the edit-flow promise.
- **S2, Wrangler auth**
  - Output of `wrangler auth token`, including machine-readable flags and whether a trailing newline or banner appears.
  - Exit code and stderr when logged out, whether it refreshes an expired OAuth token itself, and the first Wrangler version that includes it.
  - Test with project-local Wrangler resolution (`<configDir>/node_modules/.bin/wrangler`, walking up to the git root) and with global `wrangler` on `PATH`.
- **S5, D1 PRAGMA support**
  - `table_list`, `table_xinfo`, `index_list`, `index_xinfo` and `foreign_key_list`.
  - The `pragma_table_info()` table-valued function, `SELECT … FROM sqlite_schema`, and the error returned for `_cf_KV`.
  - Adapt `introspect.ts` to whatever fails.

## T1 — Credential resolution (M)

File: `src/remote/credentials.ts`. It returns `{ token: Secret, accountId, source }`.

1. **Env.** `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID` if it is set.
2. **Wrangler session (D2).** Run the project's Wrangler as `auth token` with `execFile`: no shell, `stdio: ["ignore", "pipe", "pipe"]` and a 10 s timeout. Parse stdout per S2. A non-zero exit or unrecognised output moves on to step 4.
   - Never refresh or write tokens ourselves, and never run `npx wrangler`, which risks a network install and version drift.
   - For Wrangler versions older than the command, decide after S2 whether to show an upgrade hint or read the legacy token file read-only, using an unexpired token only.
3. **Account.** Use `CLOUDFLARE_ACCOUNT_ID`, then `account_id` from the config, then `GET /accounts`. With one account, use it. With several on a TTY, show a clack select. With several and no TTY, fail with the list and `Set CLOUDFLARE_ACCOUNT_ID`.
4. **Nothing works.** Print ``Run `wrangler login` or set CLOUDFLARE_API_TOKEN`` and exit 1.

- `Secret` is a class whose `toString`, `toJSON` and `[util.inspect.custom]` all return `"[redacted]"`. Only the D1 client calls `secret.reveal()`.
- Map a 403 on the first D1 call to: `Token lacks D1 access (needs "D1 Read"; "D1 Edit" for --write).`

**Tests:** the precedence chain with a stubbed `execFile` and a stubbed fetch. Multiple accounts on a TTY and without one. A redaction test that logs the credentials object and serialises every error path, asserting the token string never appears.

## T2 — D1 REST client (M)

File: `src/remote/client.ts`.

- The base URL is the constant `https://api.cloudflare.com/client/v4`. No other host is ever contacted with the token.
- Requests use `fetch` with `Authorization: Bearer`, a JSON body and `AbortSignal.timeout(30_000)`.
- On 429 and 5xx, retry up to 3 times with jittered backoff, honouring `Retry-After`. Retries apply to **read-classified** requests only; writes are never retried automatically.
- Errors become `D1ApiError { status, code, message }`, with the D1 message verbatim (UI-8). A 429 is surfaced as `rateLimited: true, retryAfter`.
- Methods:
  - `raw(sql, params)`
  - `batch(stmts)`, shaped by S1
  - `listAccounts()`
  - `listDatabases(accountId)`, paginated
  - `getDatabase(accountId, id)`

## T3 — RemoteDriver (M)

File: `src/drivers/remote.ts`.

- `query` uses `/raw` so rows arrive as arrays. Normalise values: blob arrays become `{ $blob }`, and integers arrive as JSON numbers.
  - Precision beyond 2^53 is lost by the API itself. Note this in the README; it can't be fixed client-side.
- `batch` works as S1 decides.
- Each result carries `rowsRead`, `rowsWritten` and `durationMs`, which is D1's SQL time. The server adds the round-trip time separately.
- Introspection reuses `introspect.ts`. `describe` sends all its PRAGMAs in one `batch` call, so one round trip.
- Hidden tables are never counted.

## T4 — Lazy row counts, remote only (S) (D9)

- `GET /api/tables` returns tables without counts in remote. A new `GET /api/tables/counts` runs the counts in one batch and caches them per session.
- The sidebar requests counts after first render, and has a ↻ button to refresh them.
- A tooltip shows the rows-read cost of the last count.

## T5 — Read-only enforcement (S)

- In `/api/query` and `/api/batch`, when `driver.readOnly`, every statement from `splitStatements` must classify as `read` or `pragma-read` (01-T6). Otherwise the server responds `403 { error: { message: "Read-only mode: DELETE is not allowed. Restart with --write to enable edits." } }`.
- This applies to local `--no-write` too.
- Read-only local mode also opens the file read-only (defence in depth). Remote has no such second layer, so the classifier tests are the guard. Extend the 01-T6 table with bypass attempts: `/**/DELETE`, `WITH … DELETE`, `pragma writable_schema=1`, `ATTACH`, `VACUUM`, `REINDEX`, and a lower-case or unicode-escaped keyword.

## T6 — Row-read guard (S)

File: `src/sql/limit.ts`.

- `applyAutoLimit(sql)` applies only when the query is a single statement of kind `read`, the top-level keyword is `SELECT`, `WITH…SELECT` or `VALUES`, and there is no top-level `LIMIT` at paren depth 0.
  - It appends `LIMIT 1001` after stripping any trailing `;` and comments.
  - Compound `UNION` queries get the limit on the whole compound, which is correct SQLite semantics.
- It is used for **remote editor queries** only. Grid pages are already bounded.
- If 1001 rows come back, return 1000 with `notice: { kind: "auto-limit", limit: 1000 }`.
- The UI banner says: "Showing the first 1,000 rows. LIMIT added automatically because D1 bills per row read. Add your own LIMIT to change this."
- The status bar shows `rows read` per query, and the header tooltip shows the session total.

**Tests:**
- An existing `LIMIT` is left alone.
- A `LIMIT` inside a subquery still gets a top-level limit appended.
- A trailing comment is handled.
- `EXPLAIN` and `PRAGMA` are untouched.

## T7 — `--write` startup confirmation (S)

- After credentials and the DB resolve, and before `listen`, print:

  ```text
  ⚠ Write access to REMOTE database
    account   Acme Inc (a1b2…)
    database  prod-db (3f2a…)
  Type the database name to continue:
  ```

- A TTY uses a clack `text` prompt; a mismatch or cancel exits 1.
- A non-TTY run without `--yes` exits 1 with `--write on a remote database needs --yes in non-interactive runs`.

**Tests:** inject a prompt function with the match, mismatch and non-TTY cases.

## T8 — Remote without config (S)

- `--remote` with no Wrangler config lists the account's databases with `listDatabases`, then offers a clack select that shows the name, a short ID and the created date.
- `--db <name>` matches by name.
- A non-TTY run without `--db` fails with the list.
- `--db` given with a config but not found in it: look it up by name through the API before failing.

## T9 — UI deltas (S)

- Rows read appear in the SQL status bar, and the session total appears in the header `Tooltip`.
- API errors show an `Alert variant="destructive"` with the verbatim message and a **Retry** `Button`. On 429 the button is `disabled` and counts down `Retry-After`.
- Sidebar counts load lazily (T4), with `SidebarMenuSkeleton` while pending. A ↻ `Button` (`variant="ghost"`, `size="icon"`) in `SidebarGroupAction` refreshes them.
- The auto-limit notice (T6) is an `Alert`, with an info icon passed through the `iconLibrary`.

## T10 — Tests (M)

- **Mocked:** a fetch stub replays the S1 fixtures. RemoteDriver passes the same introspection suite as LocalDriver, as one parametrised test file.
- **Server:** a read-only 403 for every write kind, and `--write` without `--yes` in non-TTY exits 1.
- **Live, optional:** `pnpm test:live` runs only when `D1S_LIVE_TOKEN` and `D1S_LIVE_ACCOUNT` are set. It creates a throwaway D1 DB, seeds it, runs the read, read-only, auto-limit and batch suites, then deletes the DB.

---

## Status (2026-09-29)

T0–T10 are implemented and covered by mocked tests. RemoteDriver runs the shared introspection suite through a SQLite-backed fake of the D1 API (`test/remote/fake-d1.ts`).

**Still open**

- The spikes were desk research: the API reference and Wrangler 4.129's source. The live checks are listed in `docs/notes/d1-rest.md` and `docs/notes/wrangler-auth.md`. `pnpm test:live` with a throwaway account answers the two that matter for plan 04: batch atomicity and parameter types.
- The "< 5 s to first table" exit criterion needs a live measurement.

**Deviations**

- **T3:** `describe` takes two round trips, because `index_xinfo` needs the index names from the first.
- **T3:** remote batch errors carry no statement index, because D1 doesn't say which entry failed.
- **T4:** the remote count cache is not dropped after a write; ↻ recounts. Local counts are never cached.
- **T5:** `/api/batch` arrives with plan 04. It should call `assertReadOnly` (`src/server/read-only.ts`), which `/api/query` already uses.
- **T9:** pending counts use a `Skeleton` inside the badge, not `SidebarMenuSkeleton`, which draws a whole row. The ↻ button is `SidebarGroupAction` itself, which is already a ghost icon button, with a `Tooltip`.
- **T9:** Retry appears only for errors a retry can fix: offline, 429 and 5xx. SQL errors don't get it.
