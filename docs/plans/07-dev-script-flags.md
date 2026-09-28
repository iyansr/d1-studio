# Plan 07 — Read Wrangler flags from the dev script (backlog)

**Status:** parked on 2026-09-28. Pick it up after v1.0.

**Goal.** Plain `d1-studio` works in a project whose `dev` script runs Wrangler with `--env` and `--persist-to`. We reuse the flags from the `wrangler dev` command the project already runs, so the user doesn't have to repeat them.

## Motivating case (checked on 2026-09-28)

This is `ax-engineer/core/apps/runtimes/webapp-api`:

- `wrangler.jsonc` has no top-level `d1_databases`. The D1 bindings (`DB`, `OUTBOX_DB`, `IMPRESSION_DB`) exist only under `env.local`, `env.dev`, `env.staging` and `env.prod`.
- `package.json` has `"dev": "wrangler dev --local --env local --persist-to=../../../.wrangler-state"`.
- Today this needs `d1-studio --env local --persist-to ../../../.wrangler-state --db DB`. With those flags, all three databases derive and open correctly; `database_id: "local-db-id"` style IDs work too.
- Commit `abaadba` already made the failure clear: the error names the environments that have D1 and suggests `--persist-to`.

## Tasks

### T1 — Find the dev command (S)

- Read `package.json` in the config's directory, which is the directory the script runs from.
- Prefer the `dev` script, then any other script that contains `wrangler dev`.
- Also check the Nx `project.json` targets next to it. webapp-api runs its migrations through `nx run …:d1-migrate:local`. Other monorepo tools can come later.
- Only handle a direct `wrangler dev …` call. Wrappers are allowed before it (`pnpm exec`, `npx`, `bunx`, `dotenv --`), and it may be one part of a `&&` chain. Anything more dynamic (shell variables, `$(…)`) is ignored.

### T2 — Parse the flags (S)

- Handle `--env x`, `--env=x`, `-e x`, `--persist-to x` and `--persist-to=x`, with single or double quotes.
- Resolve `--persist-to` against the `package.json` directory, because npm scripts run there. That is not necessarily the cwd d1-studio was started from.
- Precedence: explicit CLI flags, then `CLOUDFLARE_ENV` if Wrangler honors it for `--env` (check in the Wrangler source first), then dev-script flags, then the defaults.

### T3 — Show where the flags came from (S)

- The banner gets an extra line, for example `env       local (from package.json "dev")`, so the user can see why a database was chosen.
- The config-selection errors (T3 in plan 01) say which env was used and where it came from.

### Tests

- Fixture projects for each flag form: `--env x`, `--env=x`, `-e`, quoted `--persist-to`, `&&` chains, a wrapper command, no dev script, a dev script without Wrangler, and CLI flags overriding the script.
- A smoke test on a copy of the webapp-api layout (env-only bindings plus `--persist-to` outside the package) that starts with no flags.

## Open questions

- If several scripts run `wrangler dev` with different envs (`dev`, `dev:staging`), prefer `dev` or prompt?
- Should a `.env` or `.dev.vars` that sets `CLOUDFLARE_ENV` count? Only if Wrangler reads it the same way.
