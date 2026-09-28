import { Hono } from "hono";
import type { AppContext } from "../context";

export function metaRoutes(ctx: AppContext) {
  return new Hono().get("/meta", (c) => {
    const { session } = ctx;
    return c.json({
      version: ctx.version,
      mode: ctx.mode,
      database: session.state === "ready" ? session.database : null,
      readOnly: ctx.readOnly,
      state: session.state,
    });
  });
}
