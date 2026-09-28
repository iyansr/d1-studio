import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalDriver } from "../../src/drivers/local";
import { BatchError, DbError } from "../../src/drivers/types";
import { decodeParam, encodeValue } from "../../src/shared/values";

const dir = mkdtempSync(path.join(tmpdir(), "d1s-local-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
let driver: LocalDriver;
let file: string;
beforeEach(async () => {
  file = path.join(dir, `db${n++}.sqlite`);
  driver = await LocalDriver.open(file, { readOnly: false });
  await driver.query("CREATE TABLE t (id INTEGER PRIMARY KEY, v)");
});
afterEach(() => driver.close());

const rows = async (sql: string) => (await driver.query(sql))[0]?.rows;

describe("encodeValue", () => {
  test.each<[unknown, unknown]>([
    [null, null],
    [undefined, null],
    [1n, 1],
    [-(2n ** 53n) + 1n, Number.MIN_SAFE_INTEGER],
    [2n ** 53n - 1n, Number.MAX_SAFE_INTEGER],
    [2n ** 53n, { $int: "9007199254740992" }],
    [-(2n ** 63n), { $int: "-9223372036854775808" }],
    [1.5, 1.5],
    ["text", "text"],
    [new Uint8Array([1, 2, 3]), { $blob: 3 }],
    [true, 1],
  ])("%s", (input, expected) => {
    expect(encodeValue(input)).toEqual(expected);
  });

  test("decodeParam", () => {
    expect(decodeParam({ $int: "9007199254740993" })).toBe(9007199254740993n);
    expect(decodeParam(false)).toBe(0);
    expect(() => decodeParam({ $int: "1.5" })).toThrow(TypeError);
  });
});

describe("LocalDriver", () => {
  test("round-trips every value type", async () => {
    await driver.query(
      "INSERT INTO t (v) VALUES (NULL), (42), (1.25), ('héllo'), (x'00ff10'), (?)",
      [{ $int: "9223372036854775807" }],
    );
    expect(await rows("SELECT v, typeof(v) FROM t ORDER BY id")).toEqual([
      [null, "null"],
      [42, "integer"],
      [1.25, "real"],
      ["héllo", "text"],
      [{ $blob: 3 }, "blob"],
      [{ $int: "9223372036854775807" }, "integer"],
    ]);
  });

  test("binds params of each JSON type", async () => {
    await driver.query("INSERT INTO t (v) VALUES (?), (?), (?), (?), (?)", [
      null,
      7,
      "s",
      true,
      { $int: "-9007199254740993" },
    ]);
    expect(await rows("SELECT v FROM t ORDER BY id")).toEqual([
      [null],
      [7],
      ["s"],
      [1],
      [{ $int: "-9007199254740993" }],
    ]);
  });

  test("keeps duplicate column names", async () => {
    const [result] = await driver.query("SELECT 1 AS id, 2 AS id");
    expect(result?.columns).toEqual(["id", "id"]);
    expect(result?.rows).toEqual([[1, 2]]);
  });

  test("runs each statement and reports changes", async () => {
    const results = await driver.query(
      "INSERT INTO t (v) VALUES (1), (2); UPDATE t SET v = v + 1; SELECT count(*) FROM t",
    );
    expect(results.map((r) => [r.columns, r.rows, r.changes])).toEqual([
      [[], [], 2],
      [[], [], 2],
      [["count(*)"], [[2]], undefined],
    ]);
    expect(results[0]?.lastRowId).toBe(2);
    for (const r of results) expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("RETURNING yields rows", async () => {
    const [r] = await driver.query("INSERT INTO t (v) VALUES ('a') RETURNING id, v");
    expect(r?.rows).toEqual([[1, "a"]]);
  });

  test("empty SQL yields no results", async () => {
    expect(await driver.query("  -- nothing\n")).toEqual([]);
  });

  test("engine errors keep the message and statement index", async () => {
    const err = await driver.query("SELECT 1; SELECT * FROM nope").catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toBe("no such table: nope");
    expect(err.statementIndex).toBe(1);
  });

  test("params with several statements are rejected", async () => {
    await expect(driver.query("SELECT ?; SELECT 2", [1])).rejects.toThrow(DbError);
  });

  test("a batch that fails at statement 2 commits nothing", async () => {
    const err = await driver
      .batch([
        { sql: "INSERT INTO t (v) VALUES (?)", params: ["first"] },
        { sql: "INSERT INTO nope VALUES (1)" },
        { sql: "INSERT INTO t (v) VALUES ('third')" },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(BatchError);
    expect(err).toMatchObject({ index: 1, message: "no such table: nope" });
    expect(await rows("SELECT count(*) FROM t")).toEqual([[0]]);
    // The connection is usable after the rollback.
    await driver.batch([{ sql: "INSERT INTO t (v) VALUES (1)" }]);
    expect(await rows("SELECT count(*) FROM t")).toEqual([[1]]);
  });

  test("a batch commits all statements", async () => {
    const results = await driver.batch([
      { sql: "INSERT INTO t (v) VALUES (1)" },
      { sql: "UPDATE t SET v = 2 WHERE id = ?", params: [1] },
      { sql: "SELECT v FROM t" },
    ]);
    expect(results.map((r) => r.changes ?? r.rows)).toEqual([1, 1, [[2]]]);
  });

  test("a batch entry must be one statement", async () => {
    await expect(driver.batch([{ sql: "SELECT 1; SELECT 2" }])).rejects.toMatchObject({
      index: 0,
    });
  });

  test("read-only open rejects writes", async () => {
    await driver.query("INSERT INTO t (v) VALUES (1)");
    const ro = await LocalDriver.open(file, { readOnly: true });
    try {
      expect(ro.readOnly).toBe(true);
      expect((await ro.query("SELECT count(*) FROM t"))[0]?.rows).toEqual([[1]]);
      await expect(ro.query("INSERT INTO t (v) VALUES (2)")).rejects.toThrow(
        "attempt to write a readonly database",
      );
      await expect(ro.batch([{ sql: "DELETE FROM t" }])).rejects.toBeInstanceOf(BatchError);
    } finally {
      await ro.close();
    }
  });

  test("keeps a trigger body as one statement", async () => {
    await driver.query(
      "CREATE TABLE log (n); CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1); INSERT INTO log VALUES (2); END; INSERT INTO t (v) VALUES (0)",
    );
    expect(await rows("SELECT n FROM log")).toEqual([[1], [2]]);
  });
});
