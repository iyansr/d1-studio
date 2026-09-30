# D1 REST API (spikes S1 and S5)

Status: **desk research, not yet checked live.** Everything below comes from the Cloudflare API reference and the D1 docs as of 2026-09-29. The fixtures in `test/fixtures/d1-api/` follow the documented shapes; they were not recorded from a real account. Each open item at the end needs a run against a disposable database before v1.0.

Sources:

- <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/>
- <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/>
- <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- <https://developers.cloudflare.com/d1/worker-api/d1-database/>

## S1: endpoints

Both endpoints live under `POST /accounts/{account_id}/d1/database/{database_id}/`.

| Endpoint | Rows as |
| --- | --- |
| `query` | objects keyed by column name |
| `raw` | `{ columns: string[], rows: unknown[][] }` |

We use `raw`: array rows keep duplicate column names (`SELECT a.id, b.id`) intact.

### Request body

Either form is accepted by both endpoints:

```json
{ "sql": "SELECT ?1", "params": ["1"] }
{ "batch": [{ "sql": "…", "params": [] }, { "sql": "…" }] }
```

`sql` may hold several statements joined by `;`. The docs say they are "executed as a batch", with one entry in `result` per statement.

### Response

```json
{
  "success": true,
  "errors": [],
  "messages": [],
  "result": [
    {
      "success": true,
      "meta": {
        "changed_db": false,
        "changes": 0,
        "duration": 0.21,
        "last_row_id": 0,
        "rows_read": 3,
        "rows_written": 0,
        "served_by_primary": true,
        "size_after": 16384,
        "timings": { "sql_duration_ms": 0.21 }
      },
      "results": { "columns": ["id", "name"], "rows": [[1, "Ada"]] }
    }
  ]
}
```

- `duration` and `timings.sql_duration_ms` exclude the network. The server reports its own round trip separately.
- `last_row_id` is only meaningful for rowid tables.
- Errors use the standard Cloudflare envelope: `success: false` and `errors: [{ code, message }]`. SQL errors are expected as HTTP 400 with code 7500 and SQLite's message plus a `: SQLITE_…` suffix, for example `no such table: nope: SQLITE_ERROR`.

### Atomicity

The Worker binding docs say: "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." The REST `batch` body is documented as the same operation.

**Decision:** `RemoteDriver.batch` sends one `{ batch: [...] }` request to `raw`, and plan 04 keeps its "one transaction" promise. The error does not say which entry failed, so remote batch errors carry no statement index.

### Parameters

The reference types `params` as `string[]`. We send numbers and `null` as JSON numbers and `null`, booleans as `1`/`0`, and `{ $int }` as its decimal string.

If the API binds numbers as text, comparisons against a column with INTEGER or REAL affinity still work, because SQLite applies the column's affinity to an unaffiliated operand. `LIMIT` and `OFFSET` never depend on this: they are inlined as validated integers (D10).

### Values

- Integers arrive as JSON numbers, so precision beyond 2^53 is lost by the API itself. It can't be fixed client-side (README).
- BLOBs arrive as arrays of byte values. `RemoteDriver` turns them into `{ $blob: length }`.

### Rate limits

A 429 is expected to carry `Retry-After` in seconds. The client retries read requests only, up to 3 times with jittered backoff, and waits at most 10 s for any single `Retry-After`.

## S5: PRAGMA support

The D1 SQL statements page lists these as supported: `table_list`, `table_info`, `table_xinfo`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`, `foreign_key_check` and `quick_check`. Reading `sqlite_master` (and so `sqlite_schema`) is supported.

`introspect.ts` needs no change for these. It already falls back when:

- `PRAGMA table_list` fails: it reads `sqlite_schema` instead;
- the `pragma_table_info()` table-valued function fails (the docs don't mention it): it runs one `PRAGMA table_info` per table.

`_cf_KV` is hidden (`isHiddenTable`) and never counted, so the studio never reads it on its own. A user query against it shows D1's error verbatim.

`describe` sends its four statements in one request and the `index_xinfo` statements in a second, so a table's schema costs two round trips.

## Still to check live

Run each of these against a disposable database and record the result here:

1. A `batch` whose 2nd statement fails: is the 1st rolled back?
2. `params: [1, null, true]`: accepted, and bound as what type (`SELECT typeof(?1)`)?
3. A BLOB column through `raw`: array of bytes, or something else?
4. The exact error envelope and HTTP status for a SQL error, a bad token (401/403) and a missing database.
5. `Retry-After` on a real 429.
6. `SELECT … FROM pragma_table_info('t')`, and the error returned for `SELECT * FROM _cf_KV`.
7. An empty result through `raw`: are `columns` still present?
8. Plan 04: does a `{ batch }` whose 3rd statement fails leave the database unchanged? (`pnpm test:live`, "grid edits".)
9. Plan 04: is `{ $int: "9007199254740993" }`, sent as a string, stored as an INTEGER key? (`pnpm test:live`.)
