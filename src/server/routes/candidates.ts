import { Hono } from "hono";
import { validator } from "hono/validator";
import { type AppContext, readySession } from "../context";
import { apiError } from "../errors";

export function candidateRoutes(ctx: AppContext) {
  return new Hono()
    .get("/candidates", (c) => {
      const { session } = ctx;
      if (session.state !== "needs-db") throw apiError(409, "A database is already open.");
      // Never send server paths to the browser.
      const candidates = session.candidates.map(({ path: _path, ...rest }) => rest);
      return c.json({ candidates });
    })
    .post(
      "/open",
      validator("json", (value) => {
        const id = (value as { candidateId?: unknown })?.candidateId;
        if (typeof id !== "number" || !Number.isInteger(id)) {
          throw apiError(400, '"candidateId" must be an integer.');
        }
        return { candidateId: id };
      }),
      async (c) => {
        const { session } = ctx;
        if (session.state !== "needs-db" || !ctx.openCandidate) {
          throw apiError(409, "A database is already open.");
        }
        const { candidateId } = c.req.valid("json");
        const candidate = session.candidates.find((x) => x.id === candidateId);
        if (!candidate) throw apiError(404, `No candidate ${candidateId}.`);
        const { driver, database } = await ctx.openCandidate(candidate);
        ctx.session = readySession(driver, database);
        return c.json({ state: "ready" as const, database });
      },
    );
}
