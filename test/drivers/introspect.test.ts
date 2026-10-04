import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  countRows,
  describe as describeTable,
  listTables,
  partialWhere,
  type QueryFn,
  SchemaCache,
  UnknownIdentifierError,
} from '../../src/drivers/introspect';
import { LocalDriver } from '../../src/drivers/local';
import type { Driver } from '../../src/drivers/types';
import { quoteString } from '../../src/sql/ident';
import { fakeD1 } from '../remote/fake-d1';

const SCHEMA = `
  CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
  CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'anon');
  CREATE TABLE books (
    author_id INTEGER NOT NULL REFERENCES authors (id) ON DELETE CASCADE ON UPDATE SET NULL,
    seq INTEGER NOT NULL,
    title TEXT,
    title_upper TEXT GENERATED ALWAYS AS (upper(title)) VIRTUAL,
    title_len INTEGER GENERATED ALWAYS AS (length(title)) STORED,
    PRIMARY KEY (seq, author_id)
  );
  CREATE TABLE tags (tag TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
  CREATE TABLE book_tags (
    author_id INTEGER, seq INTEGER, tag TEXT REFERENCES tags,
    FOREIGN KEY (author_id, seq) REFERENCES books (author_id, seq) ON DELETE RESTRICT
  );
  CREATE TABLE strict_t (a INTEGER, b TEXT) STRICT;
  CREATE INDEX books_title_partial ON books (title DESC) WHERE title IS NOT NULL;
  CREATE UNIQUE INDEX authors_lower_name ON authors (lower(name), id);
  CREATE VIEW book_titles AS SELECT a.name, b.title FROM books b JOIN authors a ON a.id = b.author_id;
  CREATE TABLE "we""ird name" (x);
  INSERT INTO authors (name) VALUES ('Ada'), ('Alan');
  INSERT INTO books (author_id, seq, title) VALUES (1, 1, 'Notes'), (1, 2, NULL), (2, 1, 'Computing');
`;

const dir = mkdtempSync(path.join(tmpdir(), 'd1s-introspect-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Open = (file: string) => Promise<{ driver: Driver; close: () => unknown }>;

/** The same suite runs over both drivers (D5); remote goes through a fake D1 API. */
const backends: [string, Open][] = [
  [
    'local',
    async (file) => {
      const driver = await LocalDriver.open(file, { readOnly: false });
      return { driver, close: () => driver.close() };
    },
  ],
  ['remote', (file) => fakeD1(file)],
];

describe.each(backends)('%s', (name, open) => {
  let driver: Driver;
  let query: QueryFn;
  let close: () => unknown;
  beforeAll(async () => {
    ({ driver, close } = await open(path.join(dir, `${name}.sqlite`)));
    await driver.query(SCHEMA);
    query = driver.query.bind(driver);
  });
  afterAll(() => close());

  const tableInfo = async (name: string) => {
    const t = (await listTables(query)).find((x) => x.name === name);
    if (!t) throw new Error(`missing ${name}`);
    return t;
  };

  describe('listTables', () => {
    test('lists main-schema tables and views with flags', async () => {
      const tables = await listTables(query);
      expect(tables.map((t) => [t.name, t.type, t.withoutRowid, t.strict, t.hidden])).toEqual([
        ['_cf_KV', 'table', true, false, true],
        ['authors', 'table', false, false, false],
        ['book_tags', 'table', false, false, false],
        ['book_titles', 'view', false, false, false],
        ['books', 'table', false, false, false],
        ['d1_migrations', 'table', false, false, true],
        ['sqlite_schema', 'table', false, false, true],
        ['strict_t', 'table', false, true, false],
        ['tags', 'table', true, false, false],
        ['we"ird name', 'table', false, false, false],
      ]);
    });

    test('falls back to sqlite_schema without PRAGMA table_list', async () => {
      const fallback: QueryFn = (sql, params) =>
        sql === 'PRAGMA table_list'
          ? Promise.reject(new Error('unknown pragma'))
          : query(sql, params);
      const tables = await listTables(fallback);
      expect(tables.find((t) => t.name === 'tags')).toMatchObject({
        withoutRowid: true,
        strict: false,
      });
      expect(tables.find((t) => t.name === 'strict_t')).toMatchObject({ strict: true });
      expect(tables.find((t) => t.name === 'book_titles')?.type).toBe('view');
      expect(tables.find((t) => t.name === '_cf_KV')?.hidden).toBe(true);
    });
  });

  describe('countRows', () => {
    test('counts tables and views in one query', async () => {
      const spy = vi.fn(query);
      expect(await countRows(spy, ['authors', 'books', 'book_titles', 'we"ird name'])).toEqual({
        authors: 2,
        books: 3,
        book_titles: 3,
        'we"ird name': 0,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('a failing count becomes null without losing the others', async () => {
      await driver.query(
        'CREATE TABLE gone (x); CREATE VIEW broken AS SELECT * FROM gone; DROP TABLE gone',
      );
      try {
        expect(await countRows(query, ['books', 'broken'])).toEqual({ books: 3, broken: null });
      } finally {
        await driver.query('DROP VIEW broken');
      }
    });
  });

  // oxlint-disable-next-line vitest/valid-title -- names the function under test.
  describe('describe', () => {
    test('composite PK, generated columns, FKs with actions, partial index', async () => {
      const schema = await describeTable(query, await tableInfo('books'));
      expect(schema).toMatchObject({
        name: 'books',
        type: 'table',
        withoutRowid: false,
        rowid: true,
        primaryKey: ['seq', 'author_id'],
      });
      expect(schema.columns.map((c) => [c.name, c.type, c.notNull, c.pk, c.generated])).toEqual([
        ['author_id', 'INTEGER', true, 2, null],
        ['seq', 'INTEGER', true, 1, null],
        ['title', 'TEXT', false, 0, null],
        ['title_upper', 'TEXT', false, 0, 'virtual'],
        ['title_len', 'INTEGER', false, 0, 'stored'],
      ]);
      expect(schema.foreignKeys).toEqual([
        {
          id: 0,
          table: 'authors',
          from: ['author_id'],
          to: ['id'],
          onUpdate: 'SET NULL',
          onDelete: 'CASCADE',
          match: 'NONE',
        },
      ]);
      expect(schema.indexes).toEqual([
        {
          name: 'books_title_partial',
          unique: false,
          origin: 'c',
          partial: true,
          columns: ['title'],
          desc: [true],
          where: 'title IS NOT NULL',
          sql: 'CREATE INDEX books_title_partial ON books (title DESC) WHERE title IS NOT NULL',
        },
        {
          name: 'sqlite_autoindex_books_1',
          unique: true,
          origin: 'pk',
          partial: false,
          columns: ['seq', 'author_id'],
          desc: [false, false],
          where: null,
          sql: null,
        },
      ]);
      expect(schema.sql).toMatch(/^CREATE TABLE books/);
    });

    test.each([
      ['CREATE INDEX i ON t (a) WHERE a > 0', 'a > 0'],
      [
        "CREATE INDEX i ON t (coalesce(a, 'WHERE')) where (b IN (SELECT 1 WHERE 1));",
        '(b IN (SELECT 1 WHERE 1))',
      ],
      ['CREATE INDEX "where" ON t ("where")', null],
    ])('partialWhere(%j)', (sql, where) => {
      expect(partialWhere(sql)).toBe(where);
    });

    test('WITHOUT ROWID table has no rowid', async () => {
      const schema = await describeTable(query, await tableInfo('tags'));
      expect(schema).toMatchObject({ withoutRowid: true, rowid: false, primaryKey: ['tag'] });
    });

    test('multi-column FK and implied parent key', async () => {
      const schema = await describeTable(query, await tableInfo('book_tags'));
      // SQLite numbers foreign keys in reverse declaration order.
      expect(
        schema.foreignKeys.map((fk) => [fk.id, fk.table, fk.from, fk.to, fk.onDelete]),
      ).toEqual([
        [0, 'books', ['author_id', 'seq'], ['author_id', 'seq'], 'RESTRICT'],
        [1, 'tags', ['tag'], [null], 'NO ACTION'],
      ]);
    });

    test('expression index columns are null', async () => {
      const schema = await describeTable(query, await tableInfo('authors'));
      expect(schema.indexes.find((i) => i.name === 'authors_lower_name')).toMatchObject({
        unique: true,
        columns: [null, 'id'],
      });
      expect(schema.columns[1]).toMatchObject({
        name: 'name',
        defaultValue: "'anon'",
        notNull: true,
      });
    });

    test('view', async () => {
      const schema = await describeTable(query, await tableInfo('book_titles'));
      expect(schema).toMatchObject({ type: 'view', rowid: false, indexes: [], foreignKeys: [] });
      expect(schema.columns.map((c) => c.name)).toEqual(['name', 'title']);
      expect(schema.sql).toMatch(/^CREATE VIEW book_titles/);
    });

    test('names needing quotes', async () => {
      const schema = await describeTable(query, await tableInfo('we"ird name'));
      expect(schema.columns.map((c) => c.name)).toEqual(['x']);
      expect(schema.sql).toBe('CREATE TABLE "we""ird name" (x)');
    });

    test('_cf_KV', async () => {
      const schema = await describeTable(query, await tableInfo('_cf_KV'));
      expect(schema).toMatchObject({ withoutRowid: true, primaryKey: ['key'] });
    });
  });

  describe('SchemaCache', () => {
    test('caches until invalidated', async () => {
      const spy = vi.fn(query);
      const cache = new SchemaCache(spy);
      await cache.tables();
      await cache.describe('authors');
      const calls = spy.mock.calls.length;
      await cache.tables();
      await cache.describe('authors');
      expect(spy.mock.calls.length).toBe(calls);
      cache.invalidate();
      await cache.tables();
      expect(spy.mock.calls.length).toBe(calls + 1);
    });

    test('assertTable and assertColumns reject unknown identifiers', async () => {
      const cache = new SchemaCache(query);
      await expect(cache.assertTable('nope')).rejects.toBeInstanceOf(UnknownIdentifierError);
      await expect(cache.assertTable('AUTHORS')).rejects.toMatchObject({ kind: 'table' });
      await expect(cache.assertColumns('authors', ['id', 'name'])).resolves.toMatchObject({
        name: 'authors',
      });
      await expect(cache.assertColumns('authors', ['id', 'bogus'])).rejects.toMatchObject({
        kind: 'column',
        message: 'No such column: authors.bogus',
      });
    });

    test('sees new tables after invalidate', async () => {
      const cache = new SchemaCache(query);
      await cache.tables();
      await driver.query('CREATE TABLE late (x)');
      await expect(cache.assertTable('late')).rejects.toThrow();
      cache.invalidate();
      await expect(cache.assertTable('late')).resolves.toMatchObject({ name: 'late' });
    });
  });
});

test('quoteString', () => {
  expect(quoteString("it's")).toBe("'it''s'");
});
