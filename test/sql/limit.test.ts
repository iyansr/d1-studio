import { describe, expect, test } from "vitest";
import { AUTO_LIMIT, applyAutoLimit } from "../../src/sql/limit";

const limited = (sql: string) => `${sql} LIMIT ${AUTO_LIMIT + 1}`;

describe("applyAutoLimit", () => {
  test.each([
    ["SELECT * FROM t", limited("SELECT * FROM t")],
    ["select * from t order by id desc", limited("select * from t order by id desc")],
    ["SELECT * FROM t;", limited("SELECT * FROM t")],
    ["SELECT * FROM t; -- all of it\n", limited("SELECT * FROM t")],
    ["SELECT * FROM t /* trailing */", limited("SELECT * FROM t")],
    ["-- leading\nSELECT 1", limited("-- leading\nSELECT 1")],
    // A LIMIT inside a subquery or CTE doesn't bound the outer query.
    [
      "SELECT * FROM (SELECT * FROM t LIMIT 5) JOIN u",
      limited("SELECT * FROM (SELECT * FROM t LIMIT 5) JOIN u"),
    ],
    [
      "WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x",
      limited("WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x"),
    ],
    // A compound query is limited as a whole.
    ["SELECT a FROM t UNION SELECT a FROM u", limited("SELECT a FROM t UNION SELECT a FROM u")],
    ["VALUES (1), (2)", limited("VALUES (1), (2)")],
    ["SELECT 'LIMIT 5', \"limit\" FROM t", limited("SELECT 'LIMIT 5', \"limit\" FROM t")],
  ])("%j is limited", (sql, expected) => {
    expect(applyAutoLimit(sql)).toEqual({ sql: expected, applied: true });
  });

  test.each([
    "SELECT * FROM t LIMIT 10",
    "select * from t limit 10 offset 20",
    "SELECT * FROM t LIMIT 5 -- mine",
    "WITH x AS (SELECT 1) SELECT * FROM x LIMIT 3",
    "EXPLAIN SELECT * FROM t",
    "EXPLAIN QUERY PLAN SELECT * FROM t",
    "PRAGMA table_list",
    "DELETE FROM t",
    "WITH x AS (SELECT 1) DELETE FROM t",
    "SELECT 1; SELECT 2",
    "",
    "-- nothing",
  ])("%j is left alone", (sql) => {
    expect(applyAutoLimit(sql)).toEqual({ sql, applied: false });
  });
});
