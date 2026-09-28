import { Hono } from "hono";
import { validator } from "hono/validator";
import type { ParamValue } from "../../shared/values";
import { classify } from "../../sql/classify";
import { splitStatements } from "../../sql/split";
import type { AppContext } from "../context";
import { apiError } from "../errors";
import { requireReady } from "./ready";

const isParam = (v: unknown): v is ParamValue =>
  v === null ||
  ["number", "string", "boolean"].includes(typeof v) ||
  (typeof v === "object" && typeof (v as { $int?: unknown }).$int === "string");

export function queryRoutes(ctx: AppContext) {
  return new Hono().post(
    "/query",
    validator("json", (value) => {
      const body = value as { sql?: unknown; params?: unknown };
      if (typeof body?.sql !== "string") throw apiError(400, '"sql" must be a string.');
      if (
        body.params !== undefined &&
        !(Array.isArray(body.params) && body.params.every(isParam))
      ) {
        throw apiError(400, '"params" must be an array of null, number, string or boolean values.');
      }
      return { sql: body.sql, params: body.params as ParamValue[] | undefined };
    }),
    async (c) => {
      const { driver, schema } = requireReady(ctx);
      const { sql, params } = c.req.valid("json");
      try {
        return c.json({ results: await driver.query(sql, params) });
      } finally {
        // Even a failed multi-statement run may have changed the schema.
        const changes = splitStatements(sql).some((s) => {
          const { kind } = classify(s.tokens);
          return kind !== "read" && kind !== "pragma-read";
        });
        if (changes) schema.invalidate();
      }
    },
  );
}
