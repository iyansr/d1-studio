import { Hono } from "hono";
import { validator } from "hono/validator";
import { BatchError, ConflictError, type QueryResult } from "../../drivers/types";
import type { BatchResponse, BatchWarning, Confirm } from "../../shared/edits";
import { compileEdits, type EditStmt, parseEditOps } from "../../sql/edits";
import { decideWrite, writePreview } from "../confirm";
import type { AppContext, Session } from "../context";
import { apiError } from "../errors";
import { assertEditable } from "../read-only";
import { requireReady } from "./ready";

export function batchRoutes(ctx: AppContext) {
  return new Hono().post(
    "/batch",
    validator("json", (value) => {
      const body = value as { table?: unknown; ops?: unknown; confirm?: unknown };
      if (typeof body?.table !== "string") throw apiError(400, '"table" must be a string.');
      const { confirm } = body;
      if (
        confirm !== undefined &&
        confirm !== true &&
        (typeof confirm !== "string" || confirm === "")
      ) {
        throw apiError(400, '"confirm" must be true or the database name.');
      }
      return {
        table: body.table,
        ops: parseEditOps(body.ops),
        confirm: confirm as Confirm | undefined,
      };
    }),
    validator("query", (value) => ({ dryRun: value.dryRun === "1" ? ("1" as const) : undefined })),
    async (c) => {
      const session = requireReady(ctx);
      const { driver, schema, database } = session;
      const { table, ops, confirm } = c.req.valid("json");
      assertEditable(driver.readOnly, ops);

      // Always compiled here from the ops, never taken from the client (D6).
      const stmts = compileEdits(await schema.describe(table), ops);
      const source = { mode: driver.mode, source: "grid" } as const;
      const preview = writePreview(stmts, source);
      if (c.req.valid("query").dryRun) return c.json(preview);

      const decision = decideWrite({
        ...source,
        readOnly: driver.readOnly,
        dangerous: preview.dangerous,
        confirm,
        databaseName: database.name,
      });
      if (decision.action === "confirm") {
        throw apiError(409, "This change needs confirmation before it runs.", {
          code: "confirmation_required",
          preview,
        });
      }
      if (decision.action === "mismatch") {
        throw apiError(
          403,
          `Type the database name (${database.name}) exactly to run destructive statements.`,
          { code: "confirmation_mismatch", preview },
        );
      }

      const started = performance.now();
      let results: QueryResult[];
      try {
        results = await driver.batch(stmts);
      } catch (err) {
        throw batchFailure(err, stmts);
      }

      const body = summarise(stmts, results, Math.round(performance.now() - started));
      patchCounts(session, table, body.inserted - body.deleted);
      return c.json(body);
    },
  );
}

/** A failed statement becomes an error that names the op the user staged. */
function batchFailure(err: unknown, stmts: EditStmt[]): unknown {
  if (!(err instanceof BatchError)) return err;
  const opIndex = stmts[err.index]?.opIndex;
  if (err instanceof ConflictError) {
    return apiError(
      409,
      "A row was changed or deleted since it was loaded. Nothing was applied. Refresh the table and stage the change again.",
      { code: "conflict", statementIndex: err.index, opIndex },
    );
  }
  return apiError(400, err.message, { statementIndex: err.index, opIndex });
}

function summarise(stmts: EditStmt[], results: QueryResult[], elapsedMs: number): BatchResponse {
  const total = { insert: 0, update: 0, delete: 0 };
  const warnings: BatchWarning[] = [];
  stmts.forEach((stmt, i) => {
    const changes = results[i]?.changes ?? 0;
    total[stmt.op] += changes;
    // Local aborts the batch on a mismatch. D1 can't, so it is reported (S1).
    if (stmt.expectChanges !== undefined && changes !== stmt.expectChanges) {
      warnings.push({
        opIndex: stmt.opIndex,
        message: `${stmt.op === "update" ? "Update" : "Delete"} matched ${changes} rows, expected ${stmt.expectChanges}: the row was changed or deleted since it was loaded.`,
      });
    }
  });
  return {
    statements: stmts.length,
    inserted: total.insert,
    updated: total.update,
    deleted: total.delete,
    warnings,
    elapsedMs,
  };
}

/** The remote count cache is kept exact from the writes, without recounting (D9). */
function patchCounts(session: Extract<Session, { state: "ready" }>, table: string, delta: number) {
  const previous = session.counts;
  if (!previous || delta === 0) return;
  const patched = previous.then((cached) => {
    const count = cached.counts[table];
    return typeof count === "number"
      ? { ...cached, counts: { ...cached.counts, [table]: Math.max(0, count + delta) } }
      : cached;
  });
  session.counts = patched;
  patched.catch(() => {
    if (session.counts === patched) session.counts = undefined;
  });
}
