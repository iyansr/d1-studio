import { describe, expect, test } from "vitest";
import { groupStatements } from "@/edits/statements";
import { inlineParams, sqlLiteral } from "@/lib/inline-sql";

describe("sqlLiteral", () => {
  test.each([
    [null, "NULL"],
    [5, "5"],
    [-1.5, "-1.5"],
    [true, "1"],
    [{ $int: "9007199254740993" }, "9007199254740993"],
    ["it's", "'it''s'"],
    ["", "''"],
  ] as const)("%j is %s", (value, expected) => {
    expect(sqlLiteral(value)).toBe(expected);
  });
});

describe("inlineParams", () => {
  test("fills placeholders in order", () => {
    expect(inlineParams('UPDATE "t" SET "a" = ?, "b" = ? WHERE rowid = ?', ["x", null, 7])).toBe(
      'UPDATE "t" SET "a" = \'x\', "b" = NULL WHERE rowid = 7',
    );
  });

  test("leaves quoted text, comments and identifiers alone", () => {
    expect(inlineParams(`SELECT "why?", '?', \`?\`, [?] -- ?\n, /* ? */ ?`, [1])).toBe(
      `SELECT "why?", '?', \`?\`, [?] -- ?\n, /* ? */ 1`,
    );
  });

  test("a value containing ? or quotes doesn't disturb later placeholders", () => {
    expect(inlineParams("VALUES (?, ?)", ["what?", "it's"])).toBe("VALUES ('what?', 'it''s')");
  });

  test("numbered placeholders use their own position, a bare ? follows the largest so far", () => {
    expect(inlineParams("SELECT ?2, ?1, ?", ["a", "b", "c"])).toBe("SELECT 'b', 'a', 'c'");
  });

  test("missing values and other placeholder styles stay as written", () => {
    expect(inlineParams("SELECT ?, ?, :name", [1])).toBe("SELECT 1, ?, :name");
  });

  test("unterminated quotes run to the end without hanging", () => {
    expect(inlineParams("SELECT 'a ?", [1])).toBe("SELECT 'a ?");
  });
});

describe("groupStatements", () => {
  const s = (sql: string, dangerous = false) => ({ sql, params: [], dangerous });

  test("a short list is shown statement by statement, params inlined", () => {
    expect(
      groupStatements([
        { sql: "DELETE FROM t WHERE id = ?", params: [1], dangerous: false },
        s("DROP TABLE t", true),
      ]),
    ).toEqual([
      { kind: "statement", number: 1, dangerous: false, text: "DELETE FROM t WHERE id = 1;" },
      { kind: "statement", number: 2, dangerous: true, text: "DROP TABLE t;" },
    ]);
  });

  test("a long list merges runs of safe statements, and destructive ones stand alone", () => {
    const list = [
      ...Array.from({ length: 30 }, (_, i) => s(`INSERT INTO t VALUES (${i})`)),
      s("DROP TABLE t", true),
      ...Array.from({ length: 20 }, (_, i) => s(`DELETE FROM t WHERE id = ${i}`)),
    ];
    const blocks = groupStatements(list);
    expect(blocks.map((b) => b.kind)).toEqual(["run", "statement", "run"]);
    expect(blocks[0]).toMatchObject({ from: 1, to: 30 });
    expect(blocks[1]).toMatchObject({ number: 31, dangerous: true });
    expect(blocks[2]).toMatchObject({ from: 32, to: 51 });
    // Nothing is left out.
    expect(
      blocks
        .map((b) => b.text)
        .join("\n")
        .split("\n"),
    ).toHaveLength(51);
  });
});
