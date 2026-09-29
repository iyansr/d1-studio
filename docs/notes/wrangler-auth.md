# `wrangler auth token` (spike S2)

Status: **read from Wrangler 4.129.0's bundled source, not yet run live.** The README's fact 6 found the command in 4.142.

## What the command does

`wrangler auth token [--json]`:

- With `CLOUDFLARE_API_TOKEN` set, it returns that token (`type: "api_token"`).
- With `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL` set, it returns the global key (`type: "api_key"`). Without `--json` this case is an error.
- Otherwise it returns the OAuth token from `wrangler login` (`type: "oauth"`). It follows the active auth profile (`wrangler auth activate`).
- Logged out, it fails with `Not logged in. Please run \`wrangler login\` to authenticate.` and a non-zero exit.

With `--json`, Wrangler prints no banner, no active-profile line and no skills hint. Stdout is only the JSON document:

```json
{
  "type": "oauth",
  "token": "…"
}
```

Without `--json`, the banner is printed before the token, so the plain form is not machine-readable.

## Decisions

- We run `<wrangler> auth token --json` with `execFile`: no shell, `stdio: ["ignore", "pipe", "pipe"]` and a 10 s timeout.
- We take the text between the first `{` and the last `}` of stdout, parse it, and accept `type` `oauth` or `api_token` with a non-empty string `token`. Anything else counts as unrecognised.
- `api_key` is not supported: the studio authenticates with `Authorization: Bearer`. The error tells the user to set `CLOUDFLARE_API_TOKEN`.
- Wrangler is resolved as its package, not its `.bin` shim: walk up from the config directory (then the working directory) to the git root looking for `node_modules/wrangler/package.json`, and run its `bin` script with Node. This avoids `.cmd` shims, which `execFile` can't run on Windows without a shell. A global `wrangler` on `PATH` is the fallback.
- We never run `npx wrangler`, never refresh a token and never read Wrangler's token files.
- **Older Wrangler (no `auth token`):** we show an upgrade hint, not a legacy-file read. Output mentioning an unknown argument or command is taken as this case.
- Stdout and stderr are never echoed, since stdout may hold the token.

## Still to check live

1. Whether the command refreshes an expired OAuth token itself. If it doesn't, the first API call returns 401 and the studio says to run `wrangler login` again.
2. The first Wrangler version that ships `auth token` (at most 4.129).
3. The exact output of an older Wrangler for `auth token`, to confirm the upgrade-hint detection.
