# D1 REST API fixtures

Responses in the shapes documented by the Cloudflare API reference (see `docs/notes/d1-rest.md`). They are **not** recorded from a live account yet. Replace them with redacted recordings once the live checks in that note are done.

Each file is `{ "status": number, "headers"?: object, "body": object }`, replayed by the fetch stub in `test/remote/`.
