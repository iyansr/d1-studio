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
  - that integers beyond 2^53 lose precision in remote mode, because the D1 API returns them as JSON numbers (03-T3)
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
- **Versioning (changesets, D14):** done. `@changesets/cli` + `@changesets/changelog-github` are dev deps; `.changeset/config.json` sets `access: "public"`, `baseBranch: "main"`, and `privatePackages: { version: false, tag: false }` so the private `ui` workspace is never versioned or tagged. Scripts:
  - `pnpm changeset`: add a changeset (any user-visible change ships with one; `feat` → minor, `fix` → patch).
  - `pnpm version-packages`: `changeset version && oxfmt`, bumps `package.json` and writes `CHANGELOG.md`.
  - `pnpm release`: `pnpm build && changeset publish`, publishes and creates the git tag (`@iyansr/d1-studio@x.y.z`, since the root is a workspace package).
  - `.changeset/v1-release.md` is a pending `major` changeset, so the first version run takes `0.0.0` to `1.0.0`.
- **Publish workflow:** `.github/workflows/release.yml`, triggered on push to `main`, with `concurrency` per ref:
  - `permissions: contents: write, pull-requests: write, id-token: write` (the last one for OIDC).
  - Steps: checkout, pnpm, `setup-node` (Node 24, `registry-url: https://registry.npmjs.org`), `pnpm install --frozen-lockfile`, `pnpm check`, then `changesets/action@v1` with `version: pnpm version-packages`, `publish: pnpm release`, `title`/`commit: "chore(release): version packages"`, `createGithubReleases: true`.
  - With pending changesets the action opens or updates a "Version Packages" PR; merging it publishes.
  - Publish uses npm trusted publishing (OIDC), no `NPM_TOKEN`: configure the trusted publisher on npmjs.com (repo + `release.yml`) before the first run, set `NPM_CONFIG_PROVENANCE=true`, and make sure the runner's npm is ≥ 11.5.1 (`npm i -g npm@latest` step if not). Verify that `changeset publish` under pnpm goes through an OIDC-capable client; if not, publish with `npm publish --provenance` for the first release.
  - The scoped package must exist before a trusted publisher can be attached on npmjs.com. If npm still requires that, do the first `1.0.0` publish manually with `pnpm release` and a granular token, then switch to OIDC.
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

- Push `main` with `.changeset/v1-release.md` pending (expand its body into the 1.0.0 release notes first). The workflow opens the "Version Packages" PR (`0.0.0` → `1.0.0`, `CHANGELOG.md` created).
- Review and merge the PR; the workflow publishes, tags `@iyansr/d1-studio@1.0.0` and creates the GitHub release from the changelog entry.
- Edit the GitHub release to add the GIF.
- Verify with `npx @iyansr/d1-studio@1.0.0 --version` on a clean machine or container.

## Status

- 2026-10-04: changesets set up (T2 versioning, D14). `release.yml` not written yet; T1, T3–T6 open.
