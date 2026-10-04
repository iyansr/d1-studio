# d1-studio implementation plans

Source spec: [`docs/PRD.md`](../PRD.md). One plan per PRD milestone.

| # | Plan | PRD milestone | Est. | Depends on |
| --- | --- | --- | --- | --- |
| 01 | [Core CLI and backend](01-core-cli.md) | M1 | 1.5 wk | — |
| 02 | [Read UI](02-read-ui.md) | M2 | 2 wk | 01 |
| 03 | [Remote mode](03-remote.md) | M3 | 1 wk | 01 |
| 04 | [Editing](04-editing.md) | M4 | 1 wk | 02, 03 |
| 05 | [v1.0 release](05-release.md) | Release | 0.5 wk | all |
| 06 | [Alchemy projects](06-alchemy.md) (backlog) | — | ~0.5 wk | 01, 03 (T4) |
| 07 | [Read Wrangler flags from the dev script](07-dev-script-flags.md) (backlog) | — | ~0.5 wk | 01 |

02 and 03 share nothing but the `Driver` interface and server from 01, so they can run in parallel. 04 needs the grid from 02 and the remote confirmation plumbing from 03.

## Verified facts (spike, 2026-09-28, Wrangler 4.142.0)

These were checked against a real Wrangler install. Some correct the PRD.

1. **Local file name derivation works.** The HMAC scheme in the PRD produces the exact file names Miniflare wrote. Use these as test fixtures:

   | `database_id` | File |
   | --- | --- |
   | `3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90` | `b42e24f17a18ea78782455811d8b104d1e7619471c8f59f3caf22389b6ce70f3.sqlite` |
   | `b81c0d44-2e6f-4a19-8d3b-0c5e7a9f1d22` | `3e305aef760bad9b39bcf49d44331af5df47ee3654b1a3aa8af292b897809d07.sqlite` |

2. **The derivation input is not always `database_id`.** Wrangler's dev path builds the Miniflare ID as `preview_database_id ?? database_id`, falling back to the binding name when neither is set. The CLI must try `preview_database_id`, then `database_id`, then `binding`, and open the first file that exists.
3. **The D1 state dir holds a non-database file.** `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` also contains `metadata.sqlite`. The picker must skip it, along with `-wal` and `-shm` files.
4. **`-wal`/`-shm` files stay after Wrangler exits.** Database files are in WAL mode, and the sidecar files remain on disk after the process ends. Their presence does not mean `wrangler dev` is running.
5. **The PRD's config precedence is wrong.** Wrangler searches `wrangler.json`, then `wrangler.jsonc`, then `wrangler.toml`. It also follows a redirect file at `.wrangler/deploy/config.json`, which frameworks like the Cloudflare Vite plugin use.
6. **Wrangler ships `wrangler auth token`.** Wrangler 4.142 has an official `wrangler auth token` command, and also `wrangler auth keyring`. Tokens may therefore no longer live only in a TOML file. The command's output format hasn't been verified yet (see spike S2).

## Architecture

```text
package.json              @iyansr/d1-studio, bin d1-studio -> dist/cli.js, zero runtime deps (all bundled)
tsup.config.ts            CLI + server bundle -> dist/cli.js
pnpm-workspace.yaml       root package (published) + ui/ (private)
ui/                       private workspace pkg: Vite + React + shadcn/ui (Tailwind v4) -> dist/ui/
  components.json         shadcn config (preset, base library, icon library, @/ aliases)
  src/components/ui/      shadcn components (generated source, CLI-managed)
  src/grid/               DataGrid: TanStack Table + Virtual rendered with shadcn Table parts
  src/index.css           shadcn tokens + app tokens (--remote, --staged, --inserted, --deleted)
src/
  cli/                    args, port resolution, prompts, banner, browser open, main()
  config/                 find (walk up), parse (json/jsonc/toml), select (env, binding)
  local/                  filename derivation, candidate scan, sqlite adapter (node:sqlite | bun:sqlite)
  remote/                 credentials chain, D1 REST client
  drivers/                Driver types, LocalDriver, RemoteDriver, shared introspection
  sql/                    PURE: tokenizer, splitter, classifier, auto-limit, ident quoting,
                          rows-query builder, edit-op compiler
  server/                 createApp(ctx) Hono factory, security middleware, routes, static
  shared/                 API + value types imported by both server and UI
test/                     vitest unit/integration, fixtures/
e2e/                      Playwright against a fixture project
```

**Module boundaries**

- **Driver.** This keeps the PRD's interface. Each concrete driver implements only `query` and `batch`. `listTables` and `describe` live in one shared `introspect` module built on PRAGMAs, which D1 also supports, so both modes get one implementation and one test suite.
- **`sql/`.** This holds the security-critical logic: read-only enforcement, identifier validation and destructive-statement detection. All of it is pure functions with no IO and table-driven tests.
- **`server/`.** `createApp({ driver, token, allowedHosts, meta })` uses no globals. It is fully testable through Hono's `app.request()`.
- **UI ↔ server.** The UI calls the server through Hono's RPC client (`hc<AppType>`), so request and response types come from the server routes, with no duplicated DTOs.

**Value encoding over JSON** (both modes):

| SQLite value | JSON |
| --- | --- |
| NULL | `null` |
| INTEGER within ±2^53 | number |
| INTEGER outside ±2^53 | `{ "$int": "9007199254740993" }` |
| REAL | number |
| TEXT | string |
| BLOB | `{ "$blob": <byteLength> }` (UI-6: size only) |

Rows travel as arrays, not objects, with a separate `columns` array. This keeps duplicate column names such as `SELECT a.id, b.id` intact.

## Decisions

Rows marked **Δ** deviate from the PRD. Rows marked **(sign-off)** need owner approval before their milestone starts.

| ID | Decision | Why |
| --- | --- | --- |
| D1 Δ (sign-off) | Require Node `>=22.16` and drop Node 20 and `better-sqlite3`. Use `node:sqlite` on Node and `bun:sqlite` on Bun. | Node 20 reached end of life on 2026-04-30. Dropping it removes the native build, keeps the package well under 3 MB and makes npx faster. 22.16 adds `StatementSync#columns()` and `setReturnArrays()`, which we need for array rows (verify in S4). |
| D2 Δ (sign-off) | Remote credential step 2 asks Wrangler for the token by running `wrangler auth token` from the project's own Wrangler, instead of parsing Wrangler's token file. We never refresh tokens ourselves. | The file format is internal and now competes with keyring storage (fact 6). Refreshing ourselves may rotate the refresh token and sign the user out of Wrangler. Final shape depends on S2. |
| D3 Δ | Config precedence is `wrangler.json` → `wrangler.jsonc` → `wrangler.toml`, and we honor `.wrangler/deploy/config.json` redirects. | This matches Wrangler (fact 5). |
| D4 Δ | The local ID candidates are `preview_database_id`, then `database_id`, then `binding`. | This matches Wrangler (fact 2). |
| D5 | Introspection is written once over `Driver.query`. | One implementation covers both modes. |
| D6 | Grid edits go to the server as structured ops (`update` / `insert` / `delete` + row key). The server compiles them to SQL, and `?dryRun=1` returns the exact SQL for the confirmation dialog. | Identifiers are validated server-side, the browser never sends raw DML for grid edits, and the preview shows exactly what will run. |
| D7 | All runtime deps are bundled into `dist/`, so `dependencies` is `{}`. | npx installs one tarball with no dependency tree. That is faster cold start and nothing to audit transitively. |
| D8 | The session cookie is named `d1s_<port>`. | Browsers don't scope cookies by port, so two studios on different ports would otherwise overwrite each other's cookie. |
| D9 (sign-off) | Remote row counts load lazily after the sidebar renders, are cached per session and have a refresh button. | `COUNT(*)` reads every row and D1 bills per row read. Loading counts lazily also protects the < 5 s remote metric. |
| D10 | Remote `LIMIT`/`OFFSET` values are inlined as validated integers, not bound. | Pending S1: the D1 REST API may bind all params as text. |
| D11 | Only an explicit `--port` fails when the port is busy. `D1_STUDIO_PORT` falls back to the next ports like the default does. | This is the literal PRD reading. Flip it if the owner prefers (sign-off). |
| D12 | In remote write mode, `DROP`, `ALTER … DROP`, and `UPDATE`/`DELETE` without `WHERE` need the database name typed. Grid row deletes (which always have `WHERE`) get the normal SQL-preview confirmation. | This is how we read PRD §Edit flow. |
| D13 | The UI uses **shadcn/ui** (Tailwind v4, initialised with the Vite template, Base UI by default) for all chrome: sidebar, tabs, dialogs, forms, badges, toasts and alerts. Only the data grid (TanStack Table + Virtual rendered with shadcn `Table` parts) and the SQL editor (CodeMirror themed from shadcn tokens) are custom. `ui/` is a private workspace package, so `shadcn init` and `shadcn add` work there unmodified. | The owner asked for it. Components are owned source, so there's no runtime UI library to version. Semantic tokens give dark mode and the remote accent for free. The CSP needs `style-src 'unsafe-inline'` because CodeMirror and sonner inject styles (01-T8). |
| D14 | Releases use **changesets**: each user-visible change adds a `.changeset/*.md`; `changesets/action` on `main` keeps a "Version Packages" PR open and publishes with provenance when it is merged. Tags are `@iyansr/d1-studio@x.y.z`. Replaces the `v*`-tag trigger in 05-T2. | The owner asked for it. Changelog and version bump come from the changesets, not hand edits, and publishing is a reviewed PR merge. |

## Spikes (do first in the listed milestone)

| ID | Question | Milestone | Blocks |
| --- | --- | --- | --- |
| S1 | D1 REST: `{sql, params}` vs `{batch: [...]}` bodies, whether multi-statement batches are atomic, param types (number, null, blob), `/raw` shape, error and 429 format | 03 day 1 | RemoteDriver, remote `batch` |
| S2 | `wrangler auth token`: output format and flags, exit code when logged out, whether it refreshes expired tokens, the minimum Wrangler version that has it | 03 day 1 | Credential step 2 |
| S3 | Concurrent writes with `wrangler dev` running: corruption risk, whether workerd sees our writes, how to detect a running dev server | 01 | "wrangler dev holds the file" warning |
| S4 | The Node version that first has each `node:sqlite` API we use (`columns()`, `setReturnArrays`, `readBigInts`) | 01 day 1 | `engines` field |
| S5 | D1 support for `PRAGMA table_list`, `table_xinfo`, `index_xinfo`, `foreign_key_list`, the `pragma_table_info()` table-valued function, reading `sqlite_schema`, and what happens on `_cf_KV` access | 03 day 1 | Shared introspection in remote |

## Conventions

- pnpm, strict TypeScript, ESM only, Vitest, Biome for lint and format, Playwright for e2e.
- UI rules (shadcn):
  - Reach for an existing shadcn component before writing custom markup: `Alert` for callouts, `Empty` for empty states, `Skeleton` for loading, sonner for toasts, `Badge` for status.
  - Use semantic tokens only, never raw colours or manual `dark:` overrides.
  - Use `gap-*` instead of `space-*`, and `size-*` instead of equal `w-*`/`h-*`.
  - Icons in buttons use `data-icon` with no sizing classes, and are imported from the `iconLibrary` set in `components.json`.
  - Add or update components only through `pnpm dlx shadcn@latest add` (use `--diff` before updating).
  - Biome ignores `ui/src/components/ui/`.
- `pnpm check` (typecheck + lint + unit tests) must pass before each task's commit, with one commit per task.
- CI runs on Ubuntu, macOS and Windows with Node 22 and 24, plus a Bun job, starting in 01-T1.
- The Cloudflare token and the session token must never reach logs, errors or the browser. A test enforces this in 03.

## Out of scope here

v1.1 items (UI-10 through UI-13 and switching modes in the UI) and v2 (local vs remote diff, Durable Objects SQLite) are left out. Each gets its own plan after v1.0 ships.
