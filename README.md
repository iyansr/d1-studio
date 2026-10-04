<div align="center">

# d1-studio

A zero-config browser studio for Cloudflare D1, local or remote. One command, no ORM, no schema file.

[![npm version](https://img.shields.io/npm/v/@iyansr/d1-studio?logo=npm&color=cb3837)](https://www.npmjs.com/package/@iyansr/d1-studio)
[![npm downloads](https://img.shields.io/npm/dm/@iyansr/d1-studio?logo=npm)](https://www.npmjs.com/package/@iyansr/d1-studio)
[![CI](https://github.com/iyansr/d1-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/iyansr/d1-studio/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@iyansr/d1-studio?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![License: MIT](https://img.shields.io/github/license/iyansr/d1-studio)](LICENSE)

![d1-studio screenshot](https://raw.githubusercontent.com/iyansr/d1-studio/main/assets/banner.webp)

</div>

```bash
npx @iyansr/d1-studio
```

Run it inside any Wrangler project. d1-studio reads your existing `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` and your Wrangler login, starts a small server on `127.0.0.1`, and opens the studio in your browser.

## 📑 Table of contents

- [✨ Features](#-features)
- [📋 Requirements](#-requirements)
- [🚀 Quick start](#-quick-start)
  - [Local](#local)
  - [Remote](#remote)
- [⚙️ Options](#️-options)
- [🔍 How it finds your database](#-how-it-finds-your-database)
- [🔑 Remote authentication](#-remote-authentication)
  - [Creating a scoped API token](#creating-a-scoped-api-token)
  - [Large integers in remote mode](#large-integers-in-remote-mode)
- [🛡️ Safety](#️-safety)
- [🔒 Security](#-security)
- [🩺 Troubleshooting](#-troubleshooting)
- [🛠️ Development](#️-development)
- [📄 License](#-license)

## ✨ Features

- **Browse:** tables and views with row counts, a virtualized grid with paging, sorting and per-column filters, and a schema view (columns, indexes, foreign keys, `CREATE` statement).
- **Query:** a SQL editor with SQLite highlighting, table and column autocomplete, and `Ctrl/Cmd+Enter` to run. Engine errors are shown verbatim.
- **Edit:** change cells, add and delete rows. Changes are staged, previewed as the exact SQL, and applied in one batch.
- **Local and remote:** the same UI for the Miniflare SQLite file under `.wrangler/state` and for deployed D1 over the Cloudflare API.
- **Safe by default:** remote is read-only unless you pass `--write`, and the server enforces it, not just the UI.

## 📋 Requirements

- Node.js `>=22.16` (uses the built-in `node:sqlite`), or Bun.
- macOS, Linux or Windows.
- For remote mode: `wrangler login` in the project, or a Cloudflare API token.

Nothing else is installed: the package has no runtime dependencies.

## 🚀 Quick start

### Local

```bash
# Create the local database first if you haven't yet
npx wrangler d1 migrations apply <db-name> --local   # or just run `wrangler dev`

npx @iyansr/d1-studio
```

Local mode is the default, and edits are allowed. With several D1 bindings, d1-studio asks which one to open (or pass `--db <binding>`).

Outside a Wrangler project, open any SQLite file directly:

```bash
npx @iyansr/d1-studio ./data.sqlite
```

### Remote

```bash
npx @iyansr/d1-studio --remote                 # read-only
npx @iyansr/d1-studio --remote --db prod-db    # pick a database by binding or name
npx @iyansr/d1-studio --remote --write         # allow edits, asks you to type the database name first
```

With no Wrangler config (or no D1 bindings in it), `--remote` lists the account's databases and lets you pick one.

With Bun, use `bunx @iyansr/d1-studio`. To install it globally, run `npm i -g @iyansr/d1-studio` and then `d1-studio`.

## ⚙️ Options

```text
d1-studio [path] [options]
```

| Flag                     | Default                      | Description                                                        |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------ |
| `[path]`                 |                              | SQLite file to open in local mode. Skips config discovery.         |
| `--local`                | on                           | Open the local Miniflare SQLite file.                              |
| `--remote`               | off                          | Connect to deployed D1 through the Cloudflare REST API.            |
| `--db <name>`            | the only binding             | Binding or database name, when the config has several.             |
| `--config <path>`        | auto-detect                  | Path to `wrangler.json`, `wrangler.jsonc` or `wrangler.toml`.      |
| `--env <name>`           | none                         | Wrangler environment (`[env.staging]`) to read bindings from.      |
| `--persist-to <dir>`     | `.wrangler/state`            | Local state directory, the same as Wrangler's flag.                |
| `--write` / `--no-write` | on for local, off for remote | Allow edits, or open read-only.                                    |
| `-y`, `--yes`            | off                          | Skip the remote `--write` confirmation (for non-interactive runs). |
| `-p`, `--port <n>`       | `4101`                       | Port for the studio server.                                        |
| `--host <addr>`          | `127.0.0.1`                  | Bind address. See [Security](#-security).                          |
| `--no-open`              |                              | Don't open the browser.                                            |
| `-h`, `--help`           |                              | Show help.                                                         |
| `-v`, `--version`        |                              | Show the version.                                                  |

**Port.** `--port` beats the `D1_STUDIO_PORT` environment variable, which beats the default `4101`. If the port is busy, d1-studio tries the next ports and prints the one it used. An explicit `--port` that is busy is an error instead.

```bash
D1_STUDIO_PORT=8080 npx @iyansr/d1-studio --remote
```

## 🔍 How it finds your database

1. **Config.** From the current directory upwards: `wrangler.json`, then `wrangler.jsonc`, then `wrangler.toml` (Wrangler's own order). A `.wrangler/deploy/config.json` redirect, as written by the Cloudflare Vite plugin, is followed.
2. **Binding.** `d1_databases` from the config, or `env.<name>.d1_databases` with `--env`. One binding is used as is; with several, you pick one in the terminal or pass `--db`.
3. **Local file.** Miniflare names each database file after a hash of its ID. d1-studio reproduces that name from `preview_database_id`, then `database_id`, then the binding name, the same order Wrangler uses, and opens the file under `<persist-to>/v3/d1/miniflare-D1DatabaseObject/`.
4. **Remote database.** The binding's `database_id`, looked up through the D1 API.

## 🔑 Remote authentication

The API token is found in this order:

1. The `CLOUDFLARE_API_TOKEN` environment variable.
2. Your Wrangler login: d1-studio runs `wrangler auth token` using the project's own Wrangler (or the one on `PATH`). d1-studio never refreshes or stores the token itself.
3. If neither works, d1-studio exits with "Run `wrangler login` or set CLOUDFLARE_API_TOKEN."

The account comes from `CLOUDFLARE_ACCOUNT_ID`, then `account_id` in the Wrangler config, then the accounts API. If the token can see several accounts, you pick one in the terminal; in a non-interactive run, set `CLOUDFLARE_ACCOUNT_ID`.

`wrangler auth token` needs a recent Wrangler. If yours doesn't have it, upgrade with `npm i -D wrangler@latest` or use an API token. Logins made with `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` aren't supported.

### Creating a scoped API token

1. Open [Cloudflare dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) and choose **Create Token → Custom token**.
2. Add the permission **Account · D1 · Read**. For `--write`, use **Account · D1 · Edit** instead.
3. Under **Account Resources**, include only the account you need.
4. Export it:

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=…   # optional; skips the account lookup
npx @iyansr/d1-studio --remote
```

### Large integers in remote mode

The D1 API returns integers as JSON numbers, so values beyond ±2^53 (9,007,199,254,740,991) arrive already rounded. d1-studio can't recover them. Local mode reads them exactly.

## 🛡️ Safety

- **Read-only by default for remote.** Without `--write`, the server accepts only `SELECT`, `WITH … SELECT`, `VALUES`, `EXPLAIN` and read-only `PRAGMA`s, and rejects everything else with 403. The check runs on the server for every statement, whatever the UI sends. Local `--no-write` also opens the SQLite file read-only.
- **Remote `--write` asks first.** Before the server starts, the CLI shows the account and database and asks you to type the database name. In a non-interactive run it exits unless you also pass `--yes`.
- **Every remote write is previewed.** Grid changes open a dialog that lists the exact SQL to run. `DROP`, `ALTER … DROP`, and `UPDATE` or `DELETE` without `WHERE` need the database name typed, whether they come from the grid or the SQL editor.
- **Grid edits aren't raw SQL.** The browser sends structured changes (update, insert, delete with the row's key), and the server builds parameterized SQL from them with identifiers checked against the schema. If a row changed underneath you, the batch is rolled back and the studio tells you.
- **Auto-LIMIT for remote queries.** D1 bills per row read, so an unbounded `SELECT` typed into the SQL editor in remote mode gets `LIMIT 1000` added, and the result shows a notice when it was cut off. Add your own `LIMIT` to override it. Remote row counts in the sidebar also load lazily and are cached for the session.

## 🔒 Security

The studio exposes your database over HTTP, so it is locked to the person who started it:

- **Loopback only.** The server binds to `127.0.0.1` by default. Binding anywhere else with `--host` prints a warning, because anyone who can reach that address and has the link can use the studio.
- **Session token.** Each run creates a random token. The link printed in the terminal carries it once (`/?t=…`); after that it lives in an HttpOnly cookie named `d1s_<port>`. Requests without it get 401.
- **Host and Origin checks.** Requests with an unexpected `Host` header are refused, which blocks DNS rebinding, and non-GET requests must come from the studio's own origin.
- **Your Cloudflare token stays in the process.** It is held in memory, sent only to `api.cloudflare.com`, and never written to disk, logged, included in error messages or sent to the browser.
- **No telemetry.**

## 🩺 Troubleshooting

**Running alongside `wrangler dev`.** You can keep `wrangler dev` running. The studio and your Worker share the SQLite file safely and see each other's changes right away. While the studio is writing, a Worker write that happens at the same moment can fail with `SQLITE_BUSY`, because workerd doesn't wait for locks. Retry it, or use `--no-write` while testing. Browsing never causes this.

**"No local D1 database found".** Miniflare creates the file the first time the database is used. Run `wrangler dev` (and hit a route that queries D1) or `wrangler d1 migrations apply <db> --local`, then start d1-studio again. If your dev script passes `--persist-to` to Wrangler, pass the same `--persist-to` to d1-studio.

**The studio asks you to pick a database file.** d1-studio couldn't find the file it derived from your binding, usually because Wrangler changed its naming or the state directory differs. It lists every database file it found, with its tables, row counts and last-modified time, so you can tell them apart. Pick one and carry on. Please [open an issue](https://github.com/iyansr/d1-studio/issues) with your Wrangler version.

**"Multiple D1 databases … Pass --db".** The config has several bindings and the terminal isn't interactive. Pass `--db <binding>` or `--db <database_name>`.

**Several Cloudflare accounts.** Set `CLOUDFLARE_ACCOUNT_ID`, or add `account_id` to the Wrangler config, to skip the prompt.

**A 401 or "Couldn't list your Cloudflare accounts".** The token is missing a permission or has expired. Run `wrangler login` again, or check the token has D1 Read (and D1 Edit for `--write`).

**Wrong integers in remote mode.** See [Large integers in remote mode](#large-integers-in-remote-mode).

## 🛠️ Development

This is a pnpm workspace: the published CLI at the root and the private React UI in `ui/`.

```bash
pnpm install
pnpm dev [project-dir]   # CLI in watch mode + Vite; defaults to e2e/fixtures/project
pnpm check               # lint, format check, unit tests
pnpm build               # UI then CLI into dist/
pnpm test:e2e            # Playwright against dist/
pnpm demo                # re-record docs/demo.gif (needs a build and ffmpeg)
```

Design notes, plans and decisions are in [`docs/`](docs/). Releases use [changesets](https://github.com/changesets/changesets): add one with `pnpm changeset` for any user-visible change.

## 📄 License

[MIT](LICENSE)
