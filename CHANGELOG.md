# @iyansr/d1-studio

## 1.0.1

### Patch Changes

- [`1734347`](https://github.com/iyansr/d1-studio/commit/1734347941a969c43ab69617b8a19cdf8fdda4dd) Thanks [@iyansr](https://github.com/iyansr)! - Minify the CLI bundle (`dist/cli.js` drops from 392 KB to 190 KB), and refresh the README with badges, a screenshot and a table of contents.

## 1.0.0

### Major Changes

- [`5023529`](https://github.com/iyansr/d1-studio/commit/5023529ef447e919eb06684908c1f04cf307003a) Thanks [@iyansr](https://github.com/iyansr)! - First stable release: a zero-config browser studio for Cloudflare D1, local or remote. Run `npx @iyansr/d1-studio` inside any Wrangler project.

  - **Zero config.** Reads your existing `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` (including `--env` and the Vite plugin's `.wrangler/deploy/config.json` redirect) and your Wrangler login. With several D1 bindings it asks which one to open, or takes `--db`.
  - **Local mode.** Opens the Miniflare SQLite file under `.wrangler/state` by deriving its filename the way Wrangler does, with a picker as a fallback. A positional path opens any `.sqlite` file outside a project.
  - **Remote mode.** `--remote` connects to deployed D1 over the Cloudflare API, authenticating with `CLOUDFLARE_API_TOKEN` or `wrangler auth token`. Without a config, it lists the account's databases.
  - **Browse.** Tables and views with row counts, a virtualized grid with paging, sorting and per-column filters, and a schema view (columns, indexes, foreign keys, `CREATE` statement).
  - **Query.** A SQL editor with SQLite highlighting, table and column autocomplete, and `Ctrl/Cmd+Enter` to run.
  - **Edit.** Change cells, add and delete rows. Changes are staged, previewed as the exact SQL and applied in one batch. Conflicting rows roll the batch back.
  - **Safe by default.** Remote is read-only unless you pass `--write`, and the server enforces it. Remote `--write` asks you to type the database name, as do `DROP`, `ALTER … DROP`, and `UPDATE`/`DELETE` without `WHERE`. Unbounded remote `SELECT`s get `LIMIT 1000` to keep D1 row-read costs down.
  - **Secure.** Binds to `127.0.0.1`, uses a per-run session token and cookie, checks `Host` and `Origin`, and never logs your Cloudflare token or sends it to the browser. No telemetry.
  - **Runs on** Node.js `>=22.16` or Bun, on macOS, Linux and Windows, with no runtime dependencies.
