import { Hono } from "hono";
import type { AppContext } from "../context";

export function metaRoutes(ctx: AppContext) {
  return (
    new Hono()
      .get("/meta", (c) => {
        const { session } = ctx;
        return c.json({
          version: ctx.version,
          mode: ctx.mode,
          database: session.state === "ready" ? session.database : null,
          readOnly: ctx.readOnly,
          state: session.state,
          /** needs-db: the binding no file matched. */
          unmatched: session.state === "needs-db" ? (session.unmatched ?? null) : null,
          notices: ctx.notices,
        });
      })
      /** Remote: rows read and written this session (header tooltip, T9). */
      .get("/usage", (c) => {
        const { session } = ctx;
        const usage = session.state === "ready" ? session.driver.usage : undefined;
        return c.json({ usage: usage ? { ...usage } : null });
      })
  );
}
