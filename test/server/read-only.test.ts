import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import { assertReadOnly } from '../../src/server/read-only';
import { splitStatements } from '../../src/sql/split';

const check = (sql: string) => () => assertReadOnly(splitStatements(sql));

async function refusal(sql: string): Promise<{ status: number; message: string }> {
  try {
    check(sql)();
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    const body = (await err.getResponse().json()) as { error: { message: string } };
    return { status: err.status, message: body.error.message };
  }
  throw new Error(`expected ${JSON.stringify(sql)} to be refused`);
}

describe('assertReadOnly', () => {
  test.each([
    'SELECT * FROM t',
    'select 1; values (2); explain delete from t',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'PRAGMA table_info(t)',
    'PRAGMA foreign_keys',
    '-- DELETE FROM t\nSELECT 1',
    '',
  ])('allows %j', (sql) => {
    expect(check(sql)).not.toThrow();
  });

  // T5: bypass attempts.
  test.each([
    ['DELETE FROM t', 'DELETE'],
    ['/**/DELETE FROM t', 'DELETE'],
    ['delete from t where id = 1', 'DELETE'],
    ['WITH x AS (SELECT 1) DELETE FROM t', 'DELETE'],
    ['WITH x AS (SELECT 1) UPDATE t SET a = 1', 'UPDATE'],
    ['SELECT 1; DELETE FROM t', 'DELETE'],
    ['SELECT 1;\n--x\n  insert into t values (1)', 'INSERT'],
    ['REPLACE INTO t VALUES (1)', 'REPLACE'],
    ['CREATE TEMP TABLE x (a)', 'CREATE'],
    ['DROP TABLE t', 'DROP'],
    ['ALTER TABLE t RENAME TO u', 'ALTER'],
    ['pragma writable_schema=1', 'PRAGMA'],
    ['PRAGMA foreign_keys(0)', 'PRAGMA'],
    ['PRAGMA optimize', 'PRAGMA'],
    ["ATTACH 'x.db' AS x", 'ATTACH'],
    ['VACUUM', 'VACUUM'],
    ['REINDEX', 'REINDEX'],
    ['ANALYZE', 'ANALYZE'],
    ['BEGIN', 'BEGIN'],
    ['ＤＥＬＥＴＥ FROM t', 'ＤＥＬＥＴＥ'],
    ['(DELETE FROM t)', '('],
  ])('refuses %j', async (sql, keyword) => {
    expect(await refusal(sql)).toEqual({
      status: 403,
      message: `Read-only mode: ${keyword} is not allowed. Restart with --write to enable edits.`,
    });
  });
});
