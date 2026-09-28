import { Hono } from "hono";
import { countRows } from "../../drivers/introspect";
import type { AppContext } from "../context";
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
    });
}
