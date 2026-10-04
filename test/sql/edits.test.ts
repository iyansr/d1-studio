import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { type ColumnInfo, SchemaCache, type TableSchema } from '../../src/drivers/introspect';
import { LocalDriver } from '../../src/drivers/local';
import type { EditOp } from '../../src/shared/edits';
import { compileEdits, EditError, parseEditOps } from '../../src/sql/edits';

const col = (name: string, type = 'TEXT', pk = 0, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  cid: 0,
  name,
  type,
  notNull: false,
  defaultValue: null,
  pk,
  hidden: false,
  generated: null,
  ...extra,
});

const table = (overrides: Partial<TableSchema>): TableSchema => ({
  name: 'users',
  type: 'table',
  withoutRowid: false,
  strict: false,
  rowid: true,
  columns: [col('id', 'INTEGER', 1), col('name'), col('order'), col('we"ird')],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  sql: null,
  ...overrides,
});

const users = table({});
const memberships = table({
  name: 'memberships',
  withoutRowid: true,
  rowid: false,
  columns: [col('org', 'INTEGER', 2), col('user', 'INTEGER', 1), col('role')],
  primaryKey: ['user', 'org'],
});

const compile = (schema: TableSchema, ...ops: EditOp[]) =>
  compileEdits(schema, ops).map(({ sql, params }) => ({ sql, params }));

describe('compileEdits', () => {
  test('updates a rowid table by rowid', () => {
    expect(
      compile(users, {
        op: 'update',
        key: { kind: 'rowid', rowid: 7 },
        set: { name: 'Ada', order: null },
      }),
    ).toEqual([
      {
        sql: 'UPDATE "users" SET "name" = ?, "order" = ? WHERE rowid = ?',
        params: ['Ada', null, 7],
      },
    ]);
  });

  test('updates and deletes a composite key in schema order, not the order sent', () => {
    const key = { kind: 'pk', values: { org: 3, user: 9 } } as const;
    expect(
      compile(memberships, { op: 'update', key, set: { role: 'admin' } }, { op: 'delete', key }),
    ).toEqual([
      { sql: 'DELETE FROM "memberships" WHERE "user" = ? AND "org" = ?', params: [9, 3] },
      {
        sql: 'UPDATE "memberships" SET "role" = ? WHERE "user" = ? AND "org" = ?',
        params: ['admin', 9, 3],
      },
    ]);
  });

  test('inserts, with DEFAULT VALUES when there is nothing to set', () => {
    expect(
      compile(
        users,
        { op: 'insert', values: { name: 'x', order: 2 } },
        { op: 'insert', values: {} },
      ),
    ).toEqual([
      { sql: 'INSERT INTO "users" ("name", "order") VALUES (?, ?)', params: ['x', 2] },
      { sql: 'INSERT INTO "users" DEFAULT VALUES', params: [] },
    ]);
  });

  test('quotes reserved words and identifiers containing a quote', () => {
    const [stmt] = compile(users, { op: 'insert', values: { order: 'a', 'we"ird': 'b' } });
    expect(stmt?.sql).toBe('INSERT INTO "users" ("order", "we""ird") VALUES (?, ?)');
    const [quoted] = compile(table({ name: 'my "tbl"' }), {
      op: 'delete',
      key: { kind: 'rowid', rowid: 1 },
    });
    expect(quoted?.sql).toBe('DELETE FROM "my ""tbl""" WHERE rowid = ?');
  });

  test('values are only ever bound', () => {
    const [stmt] = compile(users, {
      op: 'update',
      key: { kind: 'rowid', rowid: 1 },
      set: { name: "'; DROP TABLE users; --" },
    });
    expect(stmt?.sql).not.toContain('DROP');
    expect(stmt?.params[0]).toBe("'; DROP TABLE users; --");
  });

  test('uses the first rowid alias no column shadows', () => {
    const shadowed = table({ columns: [col('rowid', 'TEXT'), col('name')], primaryKey: [] });
    const [stmt] = compile(shadowed, { op: 'delete', key: { kind: 'rowid', rowid: 1 } });
    expect(stmt?.sql).toBe('DELETE FROM "users" WHERE _rowid_ = ?');
  });

  test('carries big integers as $int, for values and rowids', () => {
    expect(
      compile(users, {
        op: 'update',
        key: { kind: 'rowid', rowid: '9007199254740993' },
        set: { name: { $int: '9223372036854775807' } },
      }),
    ).toEqual([
      {
        sql: 'UPDATE "users" SET "name" = ? WHERE rowid = ?',
        params: [{ $int: '9223372036854775807' }, { $int: '9007199254740993' }],
      },
    ]);
  });

  test("orders deletes, then updates, then inserts, keeping each group's order", () => {
    const key = (n: number) => ({ kind: 'rowid', rowid: n }) as const;
    const stmts = compileEdits(users, [
      { op: 'insert', values: { name: 'i0' } },
      { op: 'update', key: key(1), set: { name: 'u1' } },
      { op: 'delete', key: key(2) },
      { op: 'insert', values: { name: 'i3' } },
      { op: 'delete', key: key(4) },
      { op: 'update', key: key(5), set: { name: 'u5' } },
    ]);
    expect(stmts.map((s) => [s.op, s.opIndex])).toEqual([
      ['delete', 2],
      ['delete', 4],
      ['update', 1],
      ['update', 5],
      ['insert', 0],
      ['insert', 3],
    ]);
  });

  test("updates and deletes expect exactly one row; inserts don't", () => {
    const stmts = compileEdits(users, [
      { op: 'insert', values: {} },
      { op: 'update', key: { kind: 'rowid', rowid: 1 }, set: { name: 'x' } },
      { op: 'delete', key: { kind: 'rowid', rowid: 1 } },
    ]);
    expect(stmts.map((s) => s.expectChanges)).toEqual([1, 1, undefined]);
  });

  describe('refuses', () => {
    const refusal = (schema: TableSchema, op: EditOp) => {
      try {
        compileEdits(schema, [op]);
      } catch (err) {
        if (err instanceof EditError) return err.message;
        throw err;
      }
      throw new Error('expected a refusal');
    };
    const row = { kind: 'rowid', rowid: 1 } as const;

    test.each(['view', 'virtual', 'shadow'] as const)('a %s', (type) => {
      expect(refusal(table({ type, rowid: false }), { op: 'delete', key: row })).toMatch(
        /can't be edited/,
      );
    });

    test('a table with no key', () => {
      const keyless = table({ rowid: false, primaryKey: [], withoutRowid: false });
      expect(refusal(keyless, { op: 'insert', values: {} })).toMatch(/no rowid or primary key/);
    });

    test('an unknown column, in set, values and key', () => {
      expect(refusal(users, { op: 'update', key: row, set: { nope: 1 } })).toBe(
        'No such column: users.nope',
      );
      expect(refusal(users, { op: 'insert', values: { nope: 1 } })).toBe(
        'No such column: users.nope',
      );
      expect(
        refusal(memberships, { op: 'delete', key: { kind: 'pk', values: { nope: 1 } } }),
      ).toMatch(/exactly the primary key/);
    });

    test('writes to generated columns', () => {
      const schema = table({
        columns: [
          col('id', 'INTEGER', 1),
          col('full', 'TEXT', 0, { generated: 'stored', hidden: false }),
        ],
      });
      expect(refusal(schema, { op: 'insert', values: { full: 'x' } })).toMatch(/generated/);
      expect(refusal(schema, { op: 'update', key: row, set: { full: 'x' } })).toMatch(/generated/);
    });

    test('$blob values', () => {
      expect(refusal(users, { op: 'insert', values: { name: { $blob: 3 } as never } })).toMatch(
        /BLOBs can't be edited/,
      );
    });

    test("other values that aren't cells", () => {
      for (const bad of [
        true,
        [1],
        { x: 1 },
        Number.NaN,
        { $int: '1.5' },
        { $int: '9223372036854775808' },
      ]) {
        expect(() =>
          compileEdits(users, [{ op: 'insert', values: { name: bad as never } }]),
        ).toThrow(EditError);
      }
    });

    test("keys that don't fit the table", () => {
      expect(refusal(memberships, { op: 'delete', key: row })).toMatch(/no rowid/);
      expect(refusal(users, { op: 'delete', key: { kind: 'pk', values: {} } })).toMatch(
        /exactly the primary key/,
      );
      expect(
        refusal(memberships, { op: 'delete', key: { kind: 'pk', values: { user: 1 } } }),
      ).toMatch(/exactly the primary key/);
      expect(
        refusal(memberships, { op: 'delete', key: { kind: 'pk', values: { user: 1, org: null } } }),
      ).toMatch(/can't be NULL/);
      expect(refusal(users, { op: 'delete', key: { kind: 'rowid', rowid: 1.5 } })).toMatch(
        /Bad rowid/,
      );
      expect(refusal(users, { op: 'delete', key: { kind: 'rowid', rowid: 'abc' } })).toMatch(
        /Bad rowid/,
      );
    });

    test('an update with nothing to set', () => {
      expect(refusal(users, { op: 'update', key: row, set: {} })).toMatch(/at least one column/);
    });

    test('names the op at fault', () => {
      try {
        compileEdits(users, [
          { op: 'insert', values: {} },
          { op: 'insert', values: { nope: 1 } },
        ]);
        expect.unreachable();
      } catch (err) {
        expect((err as EditError).opIndex).toBe(1);
      }
    });
  });
});

describe('parseEditOps', () => {
  test('accepts well-formed ops', () => {
    const ops: EditOp[] = [
      { op: 'insert', values: { a: 1 } },
      { op: 'update', key: { kind: 'rowid', rowid: '9007199254740993' }, set: { a: null } },
      { op: 'delete', key: { kind: 'pk', values: { id: 1 } } },
    ];
    expect(parseEditOps(JSON.parse(JSON.stringify(ops)))).toEqual(ops);
  });

  test.each([
    ['not an array', {}],
    ['empty', []],
    ['a non-object op', [1]],
    ['an unknown op', [{ op: 'drop' }]],
    ['an insert without values', [{ op: 'insert' }]],
    ['an update without set', [{ op: 'update', key: { kind: 'rowid', rowid: 1 } }]],
    ['a delete without a key', [{ op: 'delete' }]],
    ['a bad key kind', [{ op: 'delete', key: { kind: 'oid', rowid: 1 } }]],
    [
      "a rowid that isn't a number or string",
      [{ op: 'delete', key: { kind: 'rowid', rowid: true } }],
    ],
    ['too many ops', Array.from({ length: 1001 }, () => ({ op: 'insert', values: {} }))],
  ])('rejects %s', (_, value) => {
    expect(() => parseEditOps(value)).toThrow(EditError);
  });
});

describe('against SQLite', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'd1s-edits-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('compiled statements run, including awkward names and WITHOUT ROWID', async () => {
    const driver = await LocalDriver.open(path.join(dir, 'a.sqlite'), { readOnly: false });
    await driver.query(`
      CREATE TABLE "order" ("group" TEXT, "we""ird" INTEGER, "select" TEXT DEFAULT 'dflt');
      CREATE TABLE m (org INTEGER, usr INTEGER, role TEXT, PRIMARY KEY (usr, org)) WITHOUT ROWID;
      CREATE TABLE g (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL);
    `);
    const schema = new SchemaCache(driver.query.bind(driver));

    const orders = await schema.describe('order');
    await driver.batch(
      compileEdits(orders, [
        { op: 'insert', values: { group: 'g1', 'we"ird': 1 } },
        { op: 'insert', values: {} },
      ]),
    );
    await driver.batch(
      compileEdits(orders, [
        { op: 'update', key: { kind: 'rowid', rowid: 1 }, set: { select: null, group: 'g2' } },
        { op: 'delete', key: { kind: 'rowid', rowid: 2 } },
      ]),
    );
    const [rows] = await driver.query('SELECT rowid, "group", "we""ird", "select" FROM "order"');
    expect(rows?.rows).toEqual([[1, 'g2', 1, null]]);

    const m = await schema.describe('m');
    await driver.batch(compileEdits(m, [{ op: 'insert', values: { org: 1, usr: 2, role: 'a' } }]));
    await driver.batch(
      compileEdits(m, [
        { op: 'update', key: { kind: 'pk', values: { org: 1, usr: 2 } }, set: { role: 'b' } },
      ]),
    );
    expect((await driver.query('SELECT role FROM m'))[0]?.rows).toEqual([['b']]);

    await driver.close();
  });
});
