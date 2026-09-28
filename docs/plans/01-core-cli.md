# Plan 01 — Core CLI and backend (M1)

**Goal.** Running `node dist/cli.js` inside a Wrangler project finds the local D1 file, opens it and starts a secured Hono server that exposes the read API, then opens the browser. The UI at this point is only a placeholder page. Plans 02 and 03 build on the `Driver` interface and server defined here.

**PRD coverage:** CLI interface (all flags, port resolution, startup output), zero-config discovery steps 1, 2 and 3a, the "No config" local path, the security section, and local mode in the safety section.

**Exit criteria**

- In `test/fixtures/project-two-dbs`, `node dist/cli.js --no-open` prints the banner. Opening the token URL sets the cookie, and `/api/tables` returns both tables.
- `/api/tables` without the cookie returns 401. A foreign `Host` gets 403, and a cross-origin POST gets 403.
- Server ready in < 1.5 s from process start, logged by the smoke test.
- CI is green on Ubuntu, macOS and Windows with Node 22 and 24, plus Bun.

---

## T1 — Scaffold (S)

- `package.json` has these fields: `"name": "@iyansr/d1-studio"`, `"type": "module"`, `"bin": { "d1-studio": "dist/cli.js" }`, `"files": ["dist"]`, `"engines": { "node": ">=22.16" }` (confirm the version in T5 / S4), `"publishConfig": { "access": "public" }`, and `"dependencies": {}` (see D7).
- `pnpm-workspace.yaml` lists the root package and `ui/`. `ui/` is a private workspace package (D13), scaffolded in 02-T1. All UI dependencies stay in `ui/package.json`, and root `dependencies` stays `{}`.
- Scripts: `dev`, `build` (`build:ui` = `pnpm --filter ui build`, then `build:cli`), `test`, `test:e2e`, `check`.
- `tsup.config.ts` settings:
  - entry `src/cli/index.ts`
  - ESM output with `target: node22`
  - `noExternal: [/.*/]`
  - `external: ["node:sqlite", "bun:sqlite"]`
  - a `#!/usr/bin/env node` banner
  - `define: { __VERSION__ }`
- `tsconfig.json` (strict, `moduleResolution: bundler`), `biome.json`, `vitest.config.ts`.
- `.github/workflows/ci.yml`: an OS × Node matrix plus a Bun job. Each job runs `pnpm check && pnpm build && node dist/cli.js --version`.

**Accept:** CI is green, and `node dist/cli.js --version` prints the version on all three OSes.

## T2 — Args and port resolution (S)

Files: `src/cli/args.ts`, `src/cli/port.ts`.

- Define the command in `citty` with the flags from the PRD table plus `--yes`. Add an optional positional `[path]` for `d1-studio --local ./data.sqlite`. (citty booleans don't take values, so the path arrives as a positional.)
- Validation:
  - `--local` and `--remote` are mutually exclusive.
  - `--port` must be an integer from 1 to 65535.
  - A positional path conflicts with `--remote`.
  - `--write` defaults to `true` for local and `false` for remote. `--no-write` makes local read-only.
- `resolvePort({ flag, env: process.env.D1_STUDIO_PORT, fallback: 4101 })` returns `{ port, strict }`, where `strict` is true only when it came from `--port` (D11).
- `listen(app, host, port, strict)` works as follows. On `EADDRINUSE`, if the port isn't strict, it tries `port+1 … port+10` and returns the port it bound. If the port is strict, it throws ``Port 5555 is in use. Choose another with `--port`.``

**Tests:** the precedence order. Busy-port fallback, by occupying the port with a dummy `net.Server`. Strict-mode failure. Invalid values.

## T3 — Config discovery (M)

Files: `src/config/find.ts`, `src/config/parse.ts`, `src/config/select.ts`.

- `findConfig(cwd, explicit?)`
  - With `--config`, use that path and fail if it doesn't exist.
  - Otherwise walk up from `cwd`. In each directory, check `wrangler.json`, then `wrangler.jsonc`, then `wrangler.toml` (D3).
  - Stop at the first directory that contains `.git`, which may be a file (worktrees) or a directory, or at the filesystem root.
  - Redirects: if `.wrangler/deploy/config.json` is found on the way up, read its `configPath` relative to that file and use the target. Print `config  ./dist/wrangler.json (redirected)`.
- `parseConfig(path)`
  - Parse JSON and JSONC with `jsonc-parser` (`allowTrailingComma: true`, comments allowed), and TOML with `smol-toml`.
  - Parse errors include the file, line and column.
  - Normalize to `{ path, dir, accountId?, d1: D1Binding[], envs: Record<string, { d1: D1Binding[] }> }`, where `D1Binding = { binding, databaseName?, databaseId?, previewDatabaseId? }`.
- `selectBindings(cfg, env?)`
  - With `--env`, return only `env.<name>.d1_databases`. Bindings don't inherit in Wrangler, so we don't fall back to the top level.
  - An unknown env is an error that lists the available envs.
- `pickBinding(bindings, db?, { tty })`
  - `--db` matches `binding` or `database_name`.
  - With one binding, use it.
  - With several on a TTY, show a `@clack/prompts` select.
  - With several and no TTY, fail with `Multiple D1 databases: DB, ANALYTICS. Pass --db <name>.`

**Fixtures** in `test/fixtures/configs/`:
- `jsonc-comments-trailing`
- `toml`
- `json-and-toml`, which checks precedence
- `with-envs`
- `multi-db`
- `nested/sub/dir`, which checks the walk-up
- `redirected`
- `no-config`

## T4 — Local DB location (M)

Files: `src/local/filename.ts`, `src/local/locate.ts`.

- `localD1FileName(id)` implements the PRD algorithm. Test it against the two verified fixtures in the plans README.
- `persistDir` is `--persist-to`, resolved relative to the config file's directory (Wrangler semantics). It defaults to `.wrangler/state`. The D1 dir is `<persistDir>/v3/d1/miniflare-D1DatabaseObject/`.
- `locateLocalDb(binding, dir)`: the candidate IDs are `[previewDatabaseId, databaseId, binding]` (D4). Return the first `localD1FileName(id)` that exists.
- `listCandidates(dir)` covers every `*.sqlite` file except `metadata.sqlite`. For each file it returns:
  - an opaque `id` (an index, never a path from the browser)
  - `mtime` and size
  - the user tables, via a short read-only open
  - row counts, capped at 5 tables per file
- Outcomes:
  - A derived match opens directly.
  - No match but candidates exist starts the server in **needs-db** state. The UI picker is built in plan 02.
  - No candidates and no match prints ``Run `wrangler dev` or `wrangler d1 migrations apply --local` first`` and exits 1.
- A positional path skips discovery. The file must exist and start with the SQLite header; otherwise the CLI errors.

**Tests:** derivation fixtures, preference for `preview_database_id`, skipping `metadata.sqlite`, empty dir, needs-db state.

## T5 — SQLite adapter and LocalDriver (M)

Files: `src/local/sqlite.ts`, `src/drivers/types.ts`, `src/drivers/local.ts`.

- **S4 first.** Confirm the minimum Node version for `DatabaseSync` unflagged, `StatementSync#columns()`, `setReturnArrays()` and `readBigInts`, then set `engines`.
- `openSqlite(path, { readOnly })` returns a `SqliteConn { all(sql, params), run(sql, params), close() }`. Rows are arrays.
  - Node: `new DatabaseSync(path, { readOnly })` with `readBigInts: true`.
  - Bun: `new Database(path, { readonly, safeIntegers: true })` with `.values()`, loaded by dynamic `import("bun:sqlite")` only when `process.versions.bun` is set.
  - Run `PRAGMA busy_timeout = 5000`. Don't touch `journal_mode`; the file is already WAL and belongs to workerd.
  - Filter out only the `node:sqlite` `ExperimentalWarning`.
- `encodeValue` implements the README table. A `bigint` within the safe range becomes a number, and outside it becomes `{ $int }`. A `Uint8Array` becomes `{ $blob: byteLength }`.
- `LocalDriver`
  - `query(sql, params)` splits `sql` into statements with the T6 splitter and runs them in order. A statement with result columns uses `all`; otherwise it uses `run`. The result is one `QueryResult` per statement: `{ columns, rows, changes?, lastRowId?, durationMs }`.
  - `batch(stmts)` runs `BEGIN IMMEDIATE`, then each statement, then `COMMIT`. On error it runs `ROLLBACK` and throws `BatchError { index, message }`.
  - `readOnly` mirrors `--write`. When read-only, the file is also opened read-only (defense in depth).

**Tests:** round-trip of every value type. Big integers. Duplicate column names. A batch that fails at statement 2 commits nothing. Read-only open rejects writes.

## T6 — SQL core, pure (M)

Files: `src/sql/tokenize.ts`, `split.ts`, `classify.ts`, `ident.ts`.

- `tokenize(sql)` produces words, `'…'` strings (with `''` escapes), identifiers quoted as `"…"`, `` `…` `` or `[…]`, numbers, `?`/`?NNN`/`:name`/`@name`/`$name` params, `--` and `/* */` comments, punctuation, and parenthesis depth.
- `splitStatements(sql)` splits on top-level `;`. It handles `CREATE TRIGGER … BEGIN … END;` bodies, which contain `;`.
- `quoteIdent(name)` returns `"` + `name.replaceAll('"', '""')` + `"`. It is only ever called with names that were checked against the schema.
- `classify(stmt)` returns `{ kind: "read" | "write" | "ddl" | "tx" | "pragma-read" | "pragma-write" | "other", keyword, dangerous, hasWhere }`.
  - `WITH` resolves to the first top-level keyword after the CTE list, so `WITH x AS (…) DELETE …` is a write.
  - `EXPLAIN …` is a read.
  - `PRAGMA` is a read only for an allowlist of names and never with `=`.
  - `dangerous` is true for `DROP`, `ALTER … DROP`, and top-level `UPDATE`/`DELETE` without `WHERE` (D12).
- 03 uses this for read-only enforcement and 04 for confirmations. It lands now because LocalDriver needs the splitter.

**Tests:** at least 40 table-driven cases, including:
- keywords hidden in comments and strings
- `;` inside strings
- nested CTEs
- `REPLACE INTO`, `INSERT … SELECT`, `UPSERT`
- `pragma table_info(x)` vs `pragma foreign_keys = on`
- a trigger body
- unicode identifiers
- empty input

## T7 — Shared introspection (M)

File: `src/drivers/introspect.ts`. It works over a `query` function, so it serves both drivers.

- `listTables()` uses `PRAGMA table_list` for the name, type, `wr` (WITHOUT ROWID) and `strict`. It falls back to `sqlite_schema` if that fails. It sets `hidden` for names matching `_cf_%`, `sqlite_%` or `d1_%`.
- `countRows(names)` runs `SELECT COUNT(*)` per non-hidden table in one `batch`. In 03 the remote path makes this lazy (D9).
- `describe(table)` returns `TableSchema`:
  - `columns` come from `table_xinfo`, including generated and hidden columns.
  - `primaryKey` comes from the column `pk` ordinals.
  - `rowid` is `!withoutRowid && type === "table"`.
  - `indexes` come from `index_list` plus `index_xinfo`, with `unique`, `origin` and `partial`.
  - `foreignKeys` come from `foreign_key_list`, grouped by `id`.
  - `sql` is the DDL from `sqlite_schema`.
- `SchemaCache`: the server keeps a per-session cache, invalidated after any write or DDL. `assertTable` and `assertColumns` validate identifiers against it.

**Tests:** a fixture DB with a composite PK, a WITHOUT ROWID table, a view, FKs with actions, a partial index, a generated column and a `_cf_KV` table.

## T8 — Server and security (M)

Files: `src/server/app.ts`, `security.ts`, `routes/*.ts`, `static.ts`.

- `createApp(ctx)`. Middleware runs in this order:
  1. **Host check.** Allow `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` and the `--host` value. Anything else gets 403. This blocks DNS rebinding.
  2. **Origin check.** For non-GET requests, `Origin` must be present and allowed. For GET requests, an `Origin` header, if present, must be allowed.
  3. **Auth.** A `?t=` query param that matches the token (`crypto.timingSafeEqual`) sets `d1s_<port>=<token>; HttpOnly; SameSite=Strict; Path=/` and redirects 302 to the same URL without `t`. Otherwise the cookie must match. The API responds 401 JSON; HTML routes serve a small page that says "Open the link printed in your terminal".
  4. **Headers.** `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'`. CodeMirror and sonner inject `<style>` elements at runtime, so `style-src` needs `'unsafe-inline'`; scripts stay `'self'` only. Also `Referrer-Policy: no-referrer` (the token is in the first URL), `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` on `/api/*`.
- Routes in this plan:
  - `GET /api/meta` returns `{ version, mode, database: { name, binding, id }, readOnly, state: "ready" | "needs-db" }`.
  - `GET /api/tables` and `GET /api/tables/:name/schema`.
  - `POST /api/query` with `{ sql, params? }`.
  - In needs-db state: `GET /api/candidates` and `POST /api/open { candidateId }`.
- Errors: `app.onError` maps SQLite and D1 errors to `400 { error: { message, statementIndex? } }` with the engine message verbatim (UI-8). Anything else becomes 500 with a generic message, logged locally. A bad query must never crash the process.
- Static: serve `dist/ui` with SPA fallback. Hashed assets get `immutable` caching.
- Token: `crypto.randomBytes(32).toString("base64url")`, kept in memory only.

**Tests** (`app.request`):
- No cookie gives 401, and a bad `t` gives 401.
- A good `t` gives a 302 with `Set-Cookie`, and the `Location` has no token.
- `Host: evil.test` gives 403, and a POST with `Origin: http://evil.test` gives 403.
- A thrown driver error becomes a 400 with the verbatim message, and the server keeps serving.

## T9 — Startup orchestration (S)

File: `src/cli/index.ts`.

- `main()` runs these steps:
  1. Parse args.
  2. Discover the config.
  3. Select the binding.
  4. Locate the DB.
  5. Open the driver.
  6. `createApp`.
  7. `listen`.
  8. Print the banner.
  9. Open the browser.
- The banner follows the PRD format. The `studio` line shows the full URL with `?t=`, since that line is the user's only way in.
- A non-loopback `--host` prints a boxed yellow warning that anyone who can reach the address and has the link can read and write the database.
- The browser opener shells out to `open` on macOS, `cmd /c start "" <url>` on Windows (quote-safe) and `xdg-open` elsewhere. Failures are swallowed with a hint. `--no-open` skips it.
- On SIGINT or SIGTERM, close the server, then the DB, then exit 0.
- Measure the time to ready with `performance.now()` and print it under `DEBUG=d1-studio`.

## T10 — S3: concurrency with `wrangler dev` (S, spike + decision)

- Set up a fixture Worker that writes a row every 100 ms under `wrangler dev`, while d1-studio updates rows in a loop for 60 s.
- Check `PRAGMA integrity_check`, whether the Worker sees studio writes on its next read, and whether either side gets `SQLITE_BUSY` beyond the timeout.
- Pick a detection approach and record it in this file:
  - (a) Probe with `BEGIN IMMEDIATE` using a 0 ms timeout, then roll back. This only detects an active writer.
  - (b) Look up the workerd process by cwd. This is per-OS.
  - (c) Show a static notice in local mode.
- **Accept:** no corruption under concurrent writes, the behavior is documented for the README, and the warning is implemented with the chosen approach.

### S3 results (2026-09-28, Wrangler 4.142.0, macOS arm64, Node 24.18)

Setup: a Worker under `wrangler dev` inserting a row every 100 ms, while the built `dist/cli.js` ran `UPDATE` + `INSERT` through `POST /api/query` every ~10 ms (~68 writes/s). Visibility was checked every 250 ms in both directions.

| Run | Studio | Worker writes failed | Studio errors | Stale reads (either side) | `integrity_check` |
| --- | --- | --- | --- | --- | --- |
| 60 s, plus a `BEGIN IMMEDIATE` probe every 50 ms | writes | 11 / 595 | 0 / 4057 | 0 / 440 | ok |
| 30 s | writes | 12 / 297 | 0 / 2012 | 0 / 212 | ok |
| 30 s | `--no-write`, reads only | 0 / 298 | 0 / 2036 | 0 / 228 | ok |

- **No corruption.** `integrity_check` was ok live, at rest after workerd exited, and counters matched on both sides and when read back through `wrangler d1 execute --local`.
- **Both sides see each other's writes on the next read.** workerd keeps the `.sqlite` and `-wal` open and maps `-shm`, so it uses normal shared-memory WAL locking.
- **workerd doesn't wait on locks.** A Worker write that overlaps a studio write fails with `D1_ERROR: database is locked: SQLITE_BUSY` (or `SQLITE_BUSY_SNAPSHOT`). The studio never failed because it runs with `busy_timeout = 5000`. Studio reads never made the Worker fail.
- After a clean `wrangler dev` exit, the D1 file's `-wal`/`-shm` were removed. Plans README fact 4 doesn't always hold.

**Decision: (c), a static notice, shown only in local write mode.** The banner prints a `note` line, and `/api/meta` returns `notices: [{ id: "wrangler-dev-writes", message }]` for the UI to show as an `Alert` (plan 02).
- (a) is rejected. The probe takes the write lock itself, so it can cause the very `SQLITE_BUSY` it warns about. It also only catches a write in flight (24 of 1177 probes).
- (b) is deferred. It needs `lsof` on macOS, a `/proc/*/fd` scan on Linux, and there's nothing built in on Windows. It can be added later on top of (c).

**README text:** "You can keep `wrangler dev` running. The studio and your Worker share the SQLite file safely and see each other's changes right away. While the studio is writing, a Worker write that happens at the same moment can fail with `SQLITE_BUSY`, because workerd doesn't wait for locks. Retry it, or use `--no-write` while testing. Browsing never causes this."

## Implementation notes (deviations found while building)

- **S4 (T5):** Node 22.16.0 is the first release with `node:sqlite` unflagged plus `StatementSync#columns()`, `setReturnArrays()` and `setReadBigInts()`. Node 22.11 has no `node:sqlite`. On 22.16 the `DatabaseSync` `readBigInts`/`returnArrays` constructor options are silently ignored, so the adapter uses the per-statement setters. `engines` stays `>=22.16`.
- **T4, `--persist-to`:** Wrangler 4.142's `getLocalPersistencePath` resolves `--persist-to` against **cwd**, and resolves the default `.wrangler/state` against the **user** config's directory (before any redirect), falling back to cwd. That is what's implemented, not "relative to the config file's directory".
- **T3, walk-up:** Wrangler's own `findUp` searches each file name through every parent separately, so a `wrangler.json` two levels up beats a `wrangler.jsonc` in cwd. We keep the plan's per-directory order, where the nearest directory wins. A deploy redirect wins over a user config in the same directory.
- **T5, Bun:** `bun:sqlite` can't open a WAL file read-only while its `-wal`/`-shm` are missing (`SQLITE_CANTOPEN`, even for `SELECT`). The adapter opens a short-lived read-write handle to create them, opens and probes the read-only handle, then closes the read-write one.
- **T5, `SqliteConn`:** the shape is `prepare(sql) → { columns, all, run }` plus `exec` and `close`. LocalDriver needs a statement's result columns before it can choose between `all` and `run`.
- **T7, `countRows`:** this is one compound `SELECT (SELECT count(*) FROM …), …` per 100 tables through `query`, not a `batch`. `batch` takes `BEGIN IMMEDIATE`, which would block Worker writes (see S3). If the compound query fails, it falls back to one count per table and gives `null` for failures. FTS shadow tables are hidden too.
- **T8:** a wildcard `--host` (`0.0.0.0`, `::`) also allows each local interface address in `Host`. The URL printed for a wildcard bind uses `127.0.0.1`.
- **T9:** the smoke test (`pnpm test:smoke`, `test/smoke/`) runs the built CLI on Node or Bun (`D1_STUDIO_SMOKE_RUNTIME=bun`) and runs in CI after `pnpm build`. The fixture state under `test/fixtures/project-two-dbs/.wrangler/state` is generated by `test/fixtures/make.ts`, run from vitest's globalSetup or `pnpm fixtures`, and is gitignored. With two bindings and no TTY, the CLI needs `--db DB` there.
- `--remote` exits with "Remote mode isn't available in this build yet." until plan 03.
