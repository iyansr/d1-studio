# Plan 06 — Alchemy projects (backlog)

**Status:** parked on 2026-09-28. Pick it up after v1.0, or earlier if users ask for it.

**Goal.** Running `d1-studio` inside an [Alchemy](https://alchemy.run) project finds the local D1 database with no flags, just as it does in a Wrangler project. Remote mode lists the database.

## Findings (checked on 2026-09-28 against edaan.dev, `alchemy@2.0.0-beta.79`)

1. **There is no Wrangler config.** D1 is declared in TypeScript: `Cloudflare.D1.Database('DB', { migrations })` in `alchemy.run.ts`. We can't parse that file, since it is Effect code.
2. **The state dir is different.** Local D1 files live in `<alchemy cwd>/.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject/<hex>.sqlite`, next to a `metadata.sqlite` that we skip. `<alchemy cwd>` is wherever `alchemy dev` runs; in a monorepo that is the infra package (`packages/infra`), not the repo root.
3. **The file name derivation is the same, with different inputs.** `@alchemy.run/cloudflare-runtime` calls `getByName(databaseId)` on a namespace with `uniqueKey = "cloudflare-runtime-D1DatabaseObject"` (see `src/core/bindings/d1/D1.ts` and `D1.worker.ts`). So the file is `localD1FileName(databaseId)`, using that key instead of `miniflare-D1DatabaseObject`.
4. **The ID lives in Alchemy's state, not on disk.** In local mode, `databaseId` is `dev:<uuid>` (`attr.databaseId` of the `Cloudflare.D1Database` resource). With remote state (`Cloudflare.state()` or an HTTP store), it isn't on disk at all. edaan.dev's `.alchemy/state/.../DB.json` was stale, and neither `dev:` ID found locally derived the real file name.
5. **What d1-studio does today:**
   - At the repo root and in `packages/infra`, it stops with "No wrangler.json … found".
   - In `apps/web`, it stops because `.wrangler/deploy/config.json` redirects to a `dist/server/wrangler.json` that hasn't been built. Wrangler stops here too.
   - With a positional path to the `.sqlite` file, it works. Tables, counts and schema all load, and so does read-only mode.
6. `__alchemy_migrations` is Alchemy's migrations table and should be hidden like `d1_migrations`.

**Workaround until this lands:**

```bash
d1-studio --local "$(ls packages/infra/.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject/*.sqlite | grep -v metadata)"
```

## Tasks

### T1 — Detect an Alchemy project (S)

- This runs only when no Wrangler config is found, so Wrangler keeps precedence.
- Walk up from cwd, stopping at the git root, looking for `alchemy.run.{ts,mts,js,mjs}` or a `.alchemy/local/d1/` dir.
- Then search down from the git root to depth 3 for the same, skipping `node_modules`, `.git` and `dist`. That covers `packages/infra`-style monorepos run from the root.
- With more than one Alchemy project, use the TTY picker, or fail with the list on a non-TTY, the same rule as multiple bindings.

### T2 — Locate the file (S)

- If Alchemy's state is local (`.alchemy/state/<stack>/<stage>/*.json`), read every `resourceType: "Cloudflare.D1Database"` entry. Take `logicalId` as the binding and `attr.databaseId` as the ID, and derive with the `cloudflare-runtime-D1DatabaseObject` key. `--db` matches `logicalId` or `attr.databaseName`. Treat the state format as internal: if parsing fails, fall through.
- Otherwise, list the candidates in `.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject/`. **One file opens directly.** Several go to the existing needs-db picker. None prints "Run `alchemy dev` first" and exits 1.
- `localD1FileName(id, key)` takes the key as a parameter. Test it with a fixture file created by the Alchemy runtime.

### T3 — Presentation (S)

- Add `__alchemy_migrations` to `isHiddenTable`.
- The banner shows `config    ./packages/infra/alchemy.run.ts (alchemy)`.

### T4 — Remote (after plan 03)

- There is no `database_id` in any config, so use plan 03's "no config" path: list the account's databases through the API and prompt. When local Alchemy state has a real (non-`dev:`) ID for the stage, it can preselect.

### Open questions

- **Stale deploy redirect.** Should we warn and keep searching when `.wrangler/deploy/config.json` points to a missing file (as in `apps/web`), instead of stopping? That would be a deliberate difference from Wrangler.
- **Concurrent writes.** Does writing during `alchemy dev` show the same `SQLITE_BUSY` behavior as S3? The runtime is workerd, so probably, but rerun the S3 harness to confirm.
- **Alchemy v1.** Does v1 (`alchemy@0.x`, Miniflare-based) keep a different layout? Check before claiming support.
- **Beta layout.** Alchemy v2 is in beta, so pin the layout facts to a version, and add a CI job that watches for changes, like the Wrangler derivation check.
