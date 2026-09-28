import { describe, expect, test } from "vitest";
import { type Classification, classify } from "../../src/sql/classify";
import { quoteIdent } from "../../src/sql/ident";
import { splitStatements } from "../../src/sql/split";
import { tokenize } from "../../src/sql/tokenize";

const kinds = (sql: string) => tokenize(sql).map((t) => [t.kind, t.text]);

describe("tokenize", () => {
  test.each<[string, string, [string, string][]]>([
    ["empty input", "", []],
    ["whitespace only", " \n\t ", []],
    [
      "words, punct, numbers",
      "SELECT a, 1.5e3 FROM t",
      [
        ["word", "SELECT"],
        ["word", "a"],
        ["punct", ","],
        ["number", "1.5e3"],
        ["word", "FROM"],
        ["word", "t"],
      ],
    ],
    [
      "string with '' escape",
      "'it''s; -- not a comment'",
      [["string", "'it''s; -- not a comment'"]],
    ],
    [
      "quoted identifiers",
      '"a""b" `c``d` [e f]',
      [
        ["ident", '"a""b"'],
        ["ident", "`c``d`"],
        ["ident", "[e f]"],
      ],
    ],
    [
      "params",
      "? ?12 :name @at $dollar",
      [
        ["param", "?"],
        ["param", "?12"],
        ["param", ":name"],
        ["param", "@at"],
        ["param", "$dollar"],
      ],
    ],
    [
      "comments",
      "a -- line\n/* block; */ b",
      [
        ["word", "a"],
        ["comment", "-- line"],
        ["comment", "/* block; */"],
        ["word", "b"],
      ],
    ],
    ["blob literal", "x'00FF'", [["string", "x'00FF'"]]],
    ["hex number", "0x1F", [["number", "0x1F"]]],
    [
      "multi-char operators",
      "a->>'$.b' || c <> d",
      [
        ["word", "a"],
        ["punct", "->>"],
        ["string", "'$.b'"],
        ["punct", "||"],
        ["word", "c"],
        ["punct", "<>"],
        ["word", "d"],
      ],
    ],
    [
      "unicode identifiers",
      "SELECT naïve, 名前 FROM ütable",
      [
        ["word", "SELECT"],
        ["word", "naïve"],
        ["punct", ","],
        ["word", "名前"],
        ["word", "FROM"],
        ["word", "ütable"],
      ],
    ],
    ["unterminated string runs to end", "'abc", [["string", "'abc"]]],
    ["unterminated block comment", "/* abc", [["comment", "/* abc"]]],
  ])("%s", (_, sql, expected) => {
    expect(kinds(sql)).toEqual(expected);
  });

  test("tracks parenthesis depth", () => {
    expect(tokenize("a (b (c) d) e").map((t) => [t.text, t.depth])).toEqual([
      ["a", 0],
      ["(", 0],
      ["b", 1],
      ["(", 1],
      ["c", 2],
      [")", 1],
      ["d", 1],
      [")", 0],
      ["e", 0],
    ]);
  });
});

describe("splitStatements", () => {
  const split = (sql: string) => splitStatements(sql).map((s) => s.sql);

  test.each<[string, string, string[]]>([
    ["empty input", "", []],
    ["only comments and semicolons", "-- x\n; /* y */ ;;", []],
    ["single without semicolon", "SELECT 1", ["SELECT 1"]],
    ["two statements", "SELECT 1; SELECT 2;", ["SELECT 1", "SELECT 2"]],
    ["; inside strings", "SELECT ';'; SELECT 'a;b'", ["SELECT ';'", "SELECT 'a;b'"]],
    ["; inside identifiers", 'SELECT "a;b" FROM [c;d]', ['SELECT "a;b" FROM [c;d]']],
    [
      "; inside comments",
      "SELECT 1 /* ; */; -- ;\nSELECT 2",
      ["SELECT 1 /* ; */", "-- ;\nSELECT 2"],
    ],
    [
      "trigger body",
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = 1; DELETE FROM u; END; SELECT 1",
      [
        "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = 1; DELETE FROM u; END",
        "SELECT 1",
      ],
    ],
    [
      "temp trigger with CASE … END in the body",
      "create temp trigger tr before delete on t begin select case when old.a then raise(abort, 'no') end; end; select 2",
      [
        "create temp trigger tr before delete on t begin select case when old.a then raise(abort, 'no') end; end",
        "select 2",
      ],
    ],
    [
      "BEGIN transaction is not a trigger",
      "BEGIN; INSERT INTO t VALUES (1); COMMIT",
      ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"],
    ],
  ])("%s", (_, sql, expected) => {
    expect(split(sql)).toEqual(expected);
  });

  test("keeps offsets into the source", () => {
    const sql = "  SELECT 1 ;\n SELECT 2";
    const [a, b] = splitStatements(sql);
    expect(sql.slice(a?.start, a?.end)).toBe("SELECT 1");
    expect(sql.slice(b?.start, b?.end)).toBe("SELECT 2");
  });
});

describe("classify", () => {
  const c = (
    kind: Classification["kind"],
    keyword: string,
    dangerous = false,
    hasWhere = false,
  ) => ({
    kind,
    keyword,
    dangerous,
    hasWhere,
  });

  test.each<[string, Classification]>([
    ["", c("other", "")],
    ["-- only a comment", c("other", "")],
    ["SELECT * FROM t", c("read", "SELECT")],
    ["select * from t where id = 1", c("read", "SELECT", false, true)],
    ["VALUES (1), (2)", c("read", "VALUES")],
    ["EXPLAIN QUERY PLAN SELECT 1", c("read", "EXPLAIN")],
    ["EXPLAIN DELETE FROM t", c("read", "EXPLAIN")],
    ["/* DELETE */ SELECT 'DROP TABLE t'", c("read", "SELECT")],
    ["-- DROP TABLE t\nSELECT 1", c("read", "SELECT")],
    ["/**/DELETE FROM t", c("write", "DELETE", true)],
    ["INSERT INTO t VALUES (1)", c("write", "INSERT")],
    ["INSERT INTO t SELECT * FROM u WHERE x", c("write", "INSERT", false, true)],
    ["REPLACE INTO t VALUES (1)", c("write", "REPLACE")],
    [
      "INSERT INTO t (id, n) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET n = excluded.n",
      c("write", "INSERT"),
    ],
    ["UPDATE t SET a = 1", c("write", "UPDATE", true)],
    ["update t set a = 1 where id = 2", c("write", "UPDATE", false, true)],
    ["UPDATE t SET a = (SELECT b FROM u WHERE u.id = t.id)", c("write", "UPDATE", true)],
    ["DELETE FROM t", c("write", "DELETE", true)],
    ["delete from t where id in (select id from u)", c("write", "DELETE", false, true)],
    ["WITH x AS (SELECT 1) SELECT * FROM x", c("read", "SELECT")],
    ["WITH x AS (SELECT 1) DELETE FROM t", c("write", "DELETE", true)],
    ["WITH x AS (SELECT 1) DELETE FROM t WHERE id IN x", c("write", "DELETE", false, true)],
    [
      "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT n FROM r",
      c("read", "SELECT"),
    ],
    [
      "with a as not materialized (select 1), b as materialized (with c as (select 2) select * from c) update t set x = 1",
      c("write", "UPDATE", true),
    ],
    ['WITH "delete" AS (SELECT 1) SELECT * FROM "delete"', c("read", "SELECT")],
    ["WITH x AS (SELECT 1)", c("other", "")],
    ["CREATE TABLE t (a)", c("ddl", "CREATE")],
    ["CREATE TRIGGER tr AFTER INSERT ON t BEGIN DELETE FROM u; END", c("ddl", "CREATE")],
    ["DROP TABLE t", c("ddl", "DROP", true)],
    ["drop index if exists i", c("ddl", "DROP", true)],
    ["ALTER TABLE t ADD COLUMN b", c("ddl", "ALTER")],
    ["ALTER TABLE t DROP COLUMN b", c("ddl", "ALTER", true)],
    ["BEGIN IMMEDIATE", c("tx", "BEGIN")],
    ["COMMIT", c("tx", "COMMIT")],
    ["ROLLBACK TO sp", c("tx", "ROLLBACK")],
    ["SAVEPOINT sp", c("tx", "SAVEPOINT")],
    ["pragma table_info(x)", c("pragma-read", "PRAGMA")],
    ['PRAGMA main.table_xinfo("my table")', c("pragma-read", "PRAGMA")],
    ["PRAGMA table_list", c("pragma-read", "PRAGMA")],
    ["PRAGMA foreign_keys", c("pragma-read", "PRAGMA")],
    ["pragma foreign_keys = on", c("pragma-write", "PRAGMA")],
    ["PRAGMA foreign_keys(0)", c("pragma-write", "PRAGMA")],
    ["pragma writable_schema=1", c("pragma-write", "PRAGMA")],
    ["PRAGMA optimize", c("pragma-write", "PRAGMA")],
    ["PRAGMA user_version = 3", c("pragma-write", "PRAGMA")],
    ["PRAGMA", c("pragma-write", "PRAGMA")],
    ["ATTACH 'x.db' AS x", c("other", "ATTACH")],
    ["VACUUM", c("other", "VACUUM")],
    ["REINDEX", c("other", "REINDEX")],
    ["ANALYZE", c("other", "ANALYZE")],
    ["SeLeCt 1", c("read", "SELECT")],
    ["SELECT 名前 FROM ütable WHERE naïve = 1", c("read", "SELECT", false, true)],
    ["(SELECT 1)", c("other", "(")],
  ])("%j", (sql, expected) => {
    expect(classify(sql)).toEqual(expected);
  });

  test("accepts statement tokens from the splitter", () => {
    const [stmt] = splitStatements("-- x\nDELETE FROM t;");
    expect(classify(stmt?.tokens ?? [])).toEqual(c("write", "DELETE", true));
  });
});

describe("quoteIdent", () => {
  test.each([
    ["users", '"users"'],
    ['we"ird', '"we""ird"'],
    ["名前", '"名前"'],
    ["", '""'],
  ])("%j", (name, quoted) => {
    expect(quoteIdent(name)).toBe(quoted);
  });
});
