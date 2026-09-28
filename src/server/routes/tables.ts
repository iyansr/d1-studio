import { Hono } from "hono";
import { validator } from "hono/validator";
import { countRows } from "../../drivers/introspect";
import type { RowsPage } from "../../shared/rows";
import { buildRowsQuery, parseRowsParams, RowsQueryError, rowsColumns } from "../../sql/rows-query";
import type { AppContext } from "../context";
import { apiError } from "../errors";
import { requireReady } from "./ready";

export function tableRoutes(ctx: AppContext) {
  return new Hono()
    .get("/tables", async (c) => {
      const { driver, schema } = requireReady(ctx);
      const tables = await schema.tables();
      const visible = tables.filter((t) => !t.hidden).map((t) => t.name);
      const counts = await countRows(driver.query.bind(driver), visible);
      return c.json({ tables: tables.map((t) => ({ ...t, rows: counts[t.name] ?? null })) });
    })
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
