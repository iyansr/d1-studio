import { Hono } from 'hono';
import { validator } from 'hono/validator';

import type { QueryResult } from '../../drivers/types';
import type { Confirm } from '../../shared/edits';
import type { QueryNotice } from '../../shared/notices';
import type { ParamValue } from '../../shared/values';
import { classify, isReadKind } from '../../sql/classify';
import { AUTO_LIMIT, applyAutoLimit } from '../../sql/limit';
import { splitStatements } from '../../sql/split';
import { decideWrite, enforceWrite, parseConfirm, writePreview } from '../confirm';
import type { AppContext } from '../context';
import { apiError } from '../errors';
import { assertReadOnly } from '../read-only';
import { requireReady } from './ready';

export interface QueryResponse {
  results: QueryResult[];
  /** Server-measured time, including the network round trip in remote mode. */
  elapsedMs: number;
  notice?: QueryNotice;
}

const isParam = (v: unknown): v is ParamValue =>
  v === null ||
  ['number', 'string', 'boolean'].includes(typeof v) ||
  (typeof v === 'object' && typeof (v as { $int?: unknown }).$int === 'string');

export function queryRoutes(ctx: AppContext) {
  return new Hono().post(
    '/query',
    validator('json', (value) => {
      const body = value as { sql?: unknown; params?: unknown; confirm?: unknown };
      if (typeof body?.sql !== 'string') throw apiError(400, '"sql" must be a string.');
      if (
        body.params !== undefined &&
        !(Array.isArray(body.params) && body.params.every(isParam))
      ) {
        throw apiError(400, '"params" must be an array of null, number, string or boolean values.');
      }
      const confirm = parseConfirm(body.confirm);
      const parsed: { sql: string; params?: ParamValue[]; confirm?: Confirm } = { sql: body.sql };
      if (body.params !== undefined) parsed.params = body.params as ParamValue[];
      if (confirm !== undefined) parsed.confirm = confirm;
      return parsed;
    }),
    async (c) => {
      const { driver, schema, database } = requireReady(ctx);
      const { sql, params, confirm } = c.req.valid('json');
      const statements = splitStatements(sql);
      if (driver.readOnly) assertReadOnly(statements);

      // The user wrote this SQL, so only destructive statements are confirmed (T4).
      if (statements.some((s) => !isReadKind(classify(s.tokens).kind))) {
        const source = { mode: driver.mode, source: 'editor' } as const;
        const preview = writePreview(
          statements.map((s) => ({ sql: s.sql, params: statements.length === 1 ? params : [] })),
          source,
        );
        enforceWrite(
          decideWrite({
            ...source,
            readOnly: driver.readOnly,
            dangerous: preview.dangerous,
            confirm,
            databaseName: database.name,
          }),
          preview,
          database.name,
        );
      }

      // Remote editor queries only: grid pages are already bounded (T6).
      const limited = driver.mode === 'remote' ? applyAutoLimit(sql) : undefined;
      const started = performance.now();
      try {
        const results = await driver.query(limited?.sql ?? sql, params);
        const body: QueryResponse = {
          results,
          elapsedMs: Math.round(performance.now() - started),
        };
        const [first] = results;
        if (limited?.applied && first && first.rows.length > AUTO_LIMIT) {
          body.results = [{ ...first, rows: first.rows.slice(0, AUTO_LIMIT) }];
          body.notice = { kind: 'auto-limit', limit: AUTO_LIMIT };
        }
        return c.json(body);
      } finally {
        // Even a failed multi-statement run may have changed the schema.
        if (statements.some((s) => !isReadKind(classify(s.tokens).kind))) schema.invalidate();
      }
    },
  );
}
