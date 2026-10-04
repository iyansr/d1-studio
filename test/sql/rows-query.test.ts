import { describe, expect, test } from 'vitest';

import type { ColumnInfo, TableSchema } from '../../src/drivers/introspect';
import {
  buildRowsQuery,
  parseRowsParams,
  type RowsParams,
  RowsQueryError,
  rowsColumns,
} from '../../src/sql/rows-query';

const col = (name: string, type = 'TEXT', pk = 0): ColumnInfo => ({
  cid: 0,
  name,
  type,
  notNull: false,
  defaultValue: null,
  pk,
  hidden: false,
  generated: null,
});

const users: TableSchema = {
  name: 'users',
  type: 'table',
  withoutRowid: false,
  strict: false,
  rowid: true,
  columns: [
    col('id', 'INTEGER', 1),
    col('email'),
    col('age', 'INTEGER'),
    col('team_id', 'INTEGER'),
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [
    {
      id: 0,
      table: 'teams',
      from: ['team_id'],
      to: [null],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
      match: 'NONE',
    },
  ],
  sql: null,
};

const tags: TableSchema = {
  ...users,
  name: 'tags',
  withoutRowid: true,
  rowid: false,
  columns: [col('owner', 'INTEGER', 2), col('tag', 'TEXT', 1), col('n', 'INTEGER')],
  primaryKey: ['tag', 'owner'],
  foreignKeys: [],
};

const view: TableSchema = {
  ...users,
  name: 'active users',
  type: 'view',
  rowid: false,
  primaryKey: [],
  foreignKeys: [],
};

const params = (p: Partial<RowsParams> = {}): RowsParams => ({
  limit: 50,
  offset: 0,
  sort: [],
  filters: [],
  count: false,
  ...p,
});

describe('parseRowsParams', () => {
  test('defaults', () => {
    expect(parseRowsParams({})).toEqual(params());
  });

  test('every param', () => {
    expect(
      parseRowsParams({
        limit: '500',
        offset: '90000',
        sort: ['email:desc', 'a:b:asc'],
        f: JSON.stringify([
          { col: 'age', op: 'ge', value: 18 },
          { col: 'email', op: 'null' },
        ]),
        count: '1',
      }),
    ).toEqual({
      limit: 500,
      offset: 90000,
      sort: [
        { col: 'email', dir: 'desc' },
        { col: 'a:b', dir: 'asc' },
      ],
      filters: [
        { col: 'age', op: 'ge', value: 18 },
        { col: 'email', op: 'null' },
      ],
      count: true,
    });
  });

  test.each<[string, Parameters<typeof parseRowsParams>[0], string]>([
    ['limit not in the set', { limit: '20' }, '"limit" must be one of 50, 100, 500.'],
    ['negative offset', { offset: '-1' }, '"offset" must be a whole number, 0 or more.'],
    ['fractional offset', { offset: '1.5' }, '"offset" must be a whole number, 0 or more.'],
    ['bad sort', { sort: ['email'] }, 'Bad sort "email". Use column:asc or column:desc.'],
    ['bad sort dir', { sort: ['email:up'] }, 'Bad sort "email:up". Use column:asc or column:desc.'],
    ['f not JSON', { f: '{' }, '"f" must be a JSON array of filters.'],
    ['f not an array', { f: '{}' }, '"f" must be a JSON array of filters.'],
    ['unknown op', { f: '[{"col":"a","op":"regexp","value":"x"}]' }, 'Unknown filter op "regexp".'],
    ['missing value', { f: '[{"col":"a","op":"eq"}]' }, 'The "eq" filter on a needs a value.'],
    [
      'null value',
      { f: '[{"col":"a","op":"lt","value":null}]' },
      'The "lt" filter on a needs a value.',
    ],
    [
      'object value',
      { f: '[{"col":"a","op":"eq","value":{}}]' },
      'The "eq" filter on a needs a value.',
    ],
    ['missing col', { f: '[{"op":"null"}]' }, 'Each filter needs a "col" string.'],
  ])('rejects %s', (_, raw, message) => {
    expect(() => parseRowsParams(raw)).toThrow(new RowsQueryError(message));
  });
});

describe('buildRowsQuery', () => {
  test('rowid table, first page', () => {
    expect(buildRowsQuery(users, params())).toMatchInlineSnapshot(`
      {
        "count": undefined,
        "key": {
          "columns": [
            "__d1s_rowid",
          ],
          "kind": "rowid",
        },
        "select": {
          "params": [],
          "sql": "SELECT rowid AS "__d1s_rowid", * FROM "users" ORDER BY rowid LIMIT 51 OFFSET 0",
        },
      }
    `);
  });

  test('sort, filters and count', () => {
    const q = buildRowsQuery(
      users,
      params({
        limit: 100,
        offset: 200,
        sort: [
          { col: 'age', dir: 'desc' },
          { col: 'email', dir: 'asc' },
          { col: 'age', dir: 'asc' },
        ],
        filters: [
          { col: 'age', op: 'ge', value: 18 },
          { col: 'email', op: 'like', value: '%@example.com' },
          { col: 'team_id', op: 'nnull' },
          { col: 'email', op: 'ne', value: { $int: '9007199254740993' } },
        ],
        count: true,
      }),
    );
    expect(q.select).toMatchInlineSnapshot(`
      {
        "params": [
          18,
          "%@example.com",
          {
            "$int": "9007199254740993",
          },
        ],
        "sql": "SELECT rowid AS "__d1s_rowid", * FROM "users" WHERE "age" >= ? AND "email" LIKE ? AND "team_id" IS NOT NULL AND "email" != ? ORDER BY "age" DESC, "email" ASC, rowid LIMIT 101 OFFSET 200",
      }
    `);
    expect(q.count).toMatchInlineSnapshot(`
      {
        "params": [
          18,
          "%@example.com",
          {
            "$int": "9007199254740993",
          },
        ],
        "sql": "SELECT count(*) FROM "users" WHERE "age" >= ? AND "email" LIKE ? AND "team_id" IS NOT NULL AND "email" != ?",
      }
    `);
  });

  test.each<[string, string]>([
    ['eq', '"n" = ?'],
    ['ne', '"n" != ?'],
    ['lt', '"n" < ?'],
    ['gt', '"n" > ?'],
    ['le', '"n" <= ?'],
    ['ge', '"n" >= ?'],
    ['like', '"n" LIKE ?'],
    ['nlike', '"n" NOT LIKE ?'],
    ['null', '"n" IS NULL'],
    ['nnull', '"n" IS NOT NULL'],
  ])('op %s', (op, where) => {
    const q = buildRowsQuery(
      tags,
      params({
        filters: [{ col: 'n', op: op as 'eq', value: op.endsWith('null') ? undefined : 1 }],
      }),
    );
    expect(q.select.sql).toContain(` WHERE ${where} ORDER BY`);
    expect(q.select.params).toEqual(op.endsWith('null') ? [] : [1]);
  });

  test('WITHOUT ROWID: PK key and PK tiebreaker', () => {
    const q = buildRowsQuery(tags, params({ sort: [{ col: 'owner', dir: 'desc' }] }));
    expect(q.key).toEqual({ kind: 'pk', columns: ['tag', 'owner'] });
    expect(q.select.sql).toBe(
      'SELECT * FROM "tags" ORDER BY "owner" DESC, "tag" LIMIT 51 OFFSET 0',
    );
  });

  test('view: no key, no tiebreaker', () => {
    const q = buildRowsQuery(view, params());
    expect(q.key).toEqual({ kind: 'none', columns: [] });
    expect(q.select.sql).toBe('SELECT * FROM "active users" LIMIT 51 OFFSET 0');
  });

  test('a column named rowid shadows it', () => {
    const shadowed = { ...users, columns: [...users.columns, col('RowId')] };
    expect(buildRowsQuery(shadowed, params()).select.sql).toBe(
      'SELECT _rowid_ AS "__d1s_rowid", * FROM "users" ORDER BY _rowid_ LIMIT 51 OFFSET 0',
    );
  });

  test('identifiers are quoted', () => {
    const odd = { ...users, name: 'we"ird', columns: [col('a"b')] };
    const q = buildRowsQuery(odd, params({ sort: [{ col: 'a"b', dir: 'asc' }] }));
    expect(q.select.sql).toBe(
      'SELECT rowid AS "__d1s_rowid", * FROM "we""ird" ORDER BY "a""b" ASC, rowid LIMIT 51 OFFSET 0',
    );
  });

  test.each([
    ['filter', params({ filters: [{ col: 'x" OR 1=1 --', op: 'null' }] })],
    ['sort', params({ sort: [{ col: 'x" OR 1=1 --', dir: 'asc' }] })],
  ])('an injected column name in a %s is rejected as unknown', (_, p) => {
    expect(() => buildRowsQuery(users, p)).toThrow(
      new RowsQueryError('No such column: users.x" OR 1=1 --'),
    );
  });
});

describe('rowsColumns', () => {
  test('types, PK ordinals, FKs and the rowid column', () => {
    expect(
      rowsColumns(users, ['__d1s_rowid', 'id', 'email', 'team_id', 'expr'], (t) =>
        t === 'teams' ? ['id'] : undefined,
      ),
    ).toEqual([
      { name: '__d1s_rowid', type: 'INTEGER', pk: 0 },
      { name: 'id', type: 'INTEGER', pk: 1 },
      { name: 'email', type: 'TEXT', pk: 0 },
      { name: 'team_id', type: 'INTEGER', pk: 0, fk: { table: 'teams', column: 'id' } },
      { name: 'expr', type: '', pk: 0 },
    ]);
  });
});
