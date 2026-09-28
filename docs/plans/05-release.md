# Plan 05 — v1.0 release

**Goal.** Publish `@iyansr/d1-studio@1.0.0` to npm with docs, verified on three OSes, with the PRD metrics measured and the Wrangler canary running.

**Exit criteria:** every box in T3 is checked, T5 metrics meet their targets, and `npx @iyansr/d1-studio@1.0.0` works from a clean machine.

---

## T1 — README (S)

- A one-line pitch, a GIF, and `npx @iyansr/d1-studio`.
- Quick start for local and remote, plus the full flags table (from the PRD) and `D1_STUDIO_PORT`.
- **Remote auth:**
  - the resolution order
  - the API token permissions needed (D1 Read, and D1 Edit for `--write`)
  - how to create a scoped token
- **Safety model:**
  - read-only by default
  - what `--write` asks for
  - the auto-LIMIT and why it exists
  - the typed confirmation for destructive SQL
- **Security model:**
  - loopback bind
  - the session token and cookie
  - the Host and Origin checks
  - that the token never leaves the process
  - the `--host` warning
- **Troubleshooting:**
  - running alongside `wrangler dev` (from S3)
  - the local picker fallback and why it appears
  - "no local DB found"
  - multiple accounts
  - integer precision on remote
- Record the GIF with `vhs` from a checked-in `.tape` file so it can be re-recorded.

## T2 — Packaging (S)

- `files: ["dist"]`, the `bin`, `engines`, `publishConfig.access: "public"` (required for a scoped public package), an MIT `LICENSE`, `repository`, `keywords` and `homepage`.
- **Size budget:** a CI step runs `npm pack --dry-run --json` and fails if `unpackedSize` is 3 MB or more.
- **Publish workflow:** `.github/workflows/release.yml`, triggered on a `v*` tag. It runs `pnpm check && pnpm build`, then `npm publish --provenance` using npm trusted publishing (OIDC).
- **Tarball smoke:** `npm pack`, then `npx ./iyansr-d1-studio-*.tgz --version`, then a local-mode start against the fixture.

## T3 — Cross-OS verification (M)

Run from the packed tarball on macOS, Linux and Windows, under Node 22, Node 24 and Bun (`bunx`):

- [ ] Local: zero flags in a single-DB project, `--db` with multiple DBs, the TTY picker, and the non-TTY error.
- [ ] Local: the fallback picker when the derived file is missing.
- [ ] Local: a positional `.sqlite` path outside a project.
- [ ] Remote read-only through the Wrangler session and through env vars. A write attempt gets 403.
- [ ] Remote `--write`: typed confirmation, `--yes` in non-TTY, and the destructive-SQL dialog.
- [ ] Port busy: fallback with the default port, and a hard failure with `--port`.
- [ ] Browser opens, and `--no-open` skips it.
- [ ] Ctrl-C shuts down cleanly with no orphan process and the DB closed.
- [ ] Windows: a project path with spaces, CRLF config files, and `start` URL quoting with `&` in the query.
- [ ] Running alongside `wrangler dev` behaves as documented.

## T4 — Wrangler canary (S)

This is the PRD decision. `.github/workflows/wrangler-canary.yml` runs on a weekly cron and on manual dispatch:

1. Install `wrangler@latest` into a fixture project with bindings that use `database_id` only, `preview_database_id` and no ID.
2. Run `wrangler d1 execute <binding> --local --command "create table t(x)"` for each.
3. Start `wrangler dev`, hit a Worker route that queries every binding, then stop it.
4. Assert that `locateLocalDb` (built from `dist/`) finds each file by derivation, not through the picker.
5. On failure, open a GitHub issue with the Wrangler version, using `gh issue create`.

## T5 — Metrics (S)

Each metric is scripted with Playwright and logged in CI:

| Metric | Target | Measure |
| --- | --- | --- |
| Process start → server ready | < 1.5 s | The ready timestamp from `DEBUG` output |
| Command → first table rendered (local) | < 3 s | From spawn until the first grid row is visible |
| Command → first table rendered (remote) | < 5 s | The same, in the live suite |
| 100k-row table, one page | < 500 ms | From 02-T11 |

The npx install time is out of scope for these numbers; D7 keeps it small.

## T6 — Release (S)

- Set the version to `1.0.0`, write a `CHANGELOG.md` entry, tag `v1.0.0`, push, and let the workflow publish.
- Create a GitHub release with notes and the GIF.
- Verify with `npx @iyansr/d1-studio@1.0.0 --version` on a clean machine or container.
