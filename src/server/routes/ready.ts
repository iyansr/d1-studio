import type { AppContext, Session } from "../context";
import { apiError } from "../errors";

export function requireReady(ctx: AppContext): Extract<Session, { state: "ready" }> {
  if (ctx.session.state !== "ready") {
    throw apiError(409, "No database is open yet. Pick one first.");
  }
  return ctx.session;
}
