import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { UnknownIdentifierError } from "../drivers/introspect";
import { DbError } from "../drivers/types";
import { RowsQueryError } from "../sql/rows-query";
import type { AppContext } from "./context";
import type { ApiErrorBody } from "./errors";
import { candidateRoutes } from "./routes/candidates";
import { metaRoutes } from "./routes/meta";
import { queryRoutes } from "./routes/query";
import { tableRoutes } from "./routes/tables";
import { guard, securityHeaders } from "./security";
import { serveUi } from "./static";

/** The studio server. Uses no globals, so tests drive it with `app.request()`. */
export function createApp(ctx: AppContext) {
  const api = new Hono()
    .route("/", metaRoutes(ctx))
    .route("/", tableRoutes(ctx))
    .route("/", queryRoutes(ctx))
    .route("/", candidateRoutes(ctx));

  const app = new Hono();
  app.use(securityHeaders);
  app.use(guard({ token: ctx.token, getBind: () => ctx.bind }));
  const routes = app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: { message: "Not found" } } satisfies ApiErrorBody, 404));
  app.get("*", serveUi(ctx.uiDir));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof DbError) {
      const error: ApiErrorBody["error"] = { message: err.message };
      if (err.statementIndex !== undefined) error.statementIndex = err.statementIndex;
      return c.json({ error }, 400);
    }
    if (err instanceof RowsQueryError) return c.json({ error: { message: err.message } }, 400);
    if (err instanceof UnknownIdentifierError) {
      return c.json({ error: { message: err.message } }, err.kind === "table" ? 404 : 400);
    }
    (ctx.logError ?? console.error)(err);
    return c.json({ error: { message: "Internal server error" } }, 500);
  });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
