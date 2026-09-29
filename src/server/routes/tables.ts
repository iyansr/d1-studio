import { Hono } from "hono";
import { validator } from "hono/validator";
import { countRows, type QueryFn } from "../../drivers/introspect";
import type { RowsPage } from "../../shared/rows";
import { buildRowsQuery, parseRowsParams, RowsQueryError, rowsColumns } from "../../sql/rows-query";
import type { AppContext, Session, TableCounts } from "../context";
import { apiError } from "../errors";
import { requireReady } from "./ready";

export function tableRoutes(ctx: AppContext) {
  return new Hono()
    .get("/tables", async (c) => {
      const session = requireReady(ctx);
      const tables = await session.schema.tables();
      // Remote: COUNT(*) reads every row, so counts come from /tables/counts (D9).
      const counts: TableCounts["counts"] =
        session.driver.mode === "remote" ? {} : (await countTables(session)).counts;
      return c.json({ tables: tables.map((t) => ({ ...t, rows: counts[t.name] ?? null })) });
    })
    .get(
      "/tables/counts",
      validator("query", (value) => ({ refresh: value.refresh === "1" ? "1" : undefined })),
      async (c) => {
        const session = requireReady(ctx);
        // Local counts are cheap and change under a running Worker: never cached.
        if (c.req.valid("query").refresh || session.driver.mode === "local") {
          session.counts = undefined;
        }
        session.counts ??= countTables(session).catch((err: unknown) => {
          session.counts = undefined;
          throw err;
        });
        return c.json(await session.counts);
      },
    )
    .get("/tables/:name/schema", async (c) => {
      const { schema } = requireReady(ctx);
      return c.json(await schema.describe(c.req.param("name")));
    })
    .get(
      "/tables/:name/rows",
      validator("query", (value) => {
        const one = (key: string) => {
          const v = value[key];
          return Array.isArray(v) ? v[0] : v;
        };
        const sort = value.sort;
        try {
          const params = parseRowsParams({
            limit: one("limit"),
            offset: one("offset"),
            sort: sort === undefined ? [] : Array.isArray(sort) ? sort : [sort],
            f: one("f"),
            count: one("count"),
          });
          // Keys mirror the query string, so the typed client sends the same names.
          return {
            limit: params.limit,
            offset: params.offset,
            sort: params.sort,
            f: params.filters,
            count: params.count,
          };
        } catch (err) {
          if (err instanceof RowsQueryError) throw apiError(400, err.message);
          throw err;
        }
      }),
      async (c) => {
        const { driver, schema } = requireReady(ctx);
        const table = await schema.describe(c.req.param("name"));
        const { limit, offset, sort, f, count } = c.req.valid("query");
        const q = buildRowsQuery(table, { limit, offset, sort, filters: f, count });

        // Two plain reads, not `batch`: a batch takes the write lock (01-T10).
        const [[page], counted] = await Promise.all([
          driver.query(q.select.sql, q.select.params),
          q.count ? driver.query(q.count.sql, q.count.params) : undefined,
        ]);

        // An FK that names no parent column points at the parent's primary key.
        const parentKeys = new Map<string, string[]>();
        for (const fk of table.foreignKeys) {
          if (fk.to.every((col) => col !== null) || parentKeys.has(fk.table)) continue;
          const parent = await schema.describe(fk.table).catch(() => undefined);
          parentKeys.set(fk.table, parent?.primaryKey ?? []);
        }

        const rows = page?.rows ?? [];
        const body: RowsPage = {
          columns: rowsColumns(table, page?.columns ?? [], (t) => parentKeys.get(t)),
          rows: rows.slice(0, limit),
          hasMore: rows.length > limit,
          key: q.key,
        };
        const total = counted?.[0]?.rows[0]?.[0];
        if (typeof total === "number") body.total = total;
        return c.json(body);
      },
    )
    .get("/schema/all", async (c) => {
      const { schema } = requireReady(ctx);
      return c.json({ tables: await schema.all() });
    });
}

/** Row counts of the visible tables (hidden ones are never counted), with their cost. */
async function countTables(session: Extract<Session, { state: "ready" }>): Promise<TableCounts> {
  const tables = await session.schema.tables();
  let rowsRead = 0;
  const query: QueryFn = async (sql, params) => {
    const results = await session.driver.query(sql, params);
    for (const r of results) rowsRead += r.rowsRead ?? 0;
    return results;
  };
  const visible = tables.filter((t) => !t.hidden).map((t) => t.name);
  return { counts: await countRows(query, visible), rowsRead };
}
