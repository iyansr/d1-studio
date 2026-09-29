import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { LocalDriver } from "../../src/drivers/local";
import type { Driver } from "../../src/drivers/types";
import type { BatchResponse, EditOp, WritePreview } from "../../src/shared/edits";
import { fakeD1 } from "../remote/fake-d1";
import { copyFixtureDb, type Harness, harness, scratchDir } from "./harness";

const dir = scratchDir("d1s-batch-");

const row = (rowid: number) => ({ kind: "rowid", rowid }) as const;
const batch = (h: Harness, ops: EditOp[], extra: object = {}, query = "") =>
  h.post(`/api/batch${query}`, { table: "users", ops, ...extra });
const errorOf = async (res: Response) =>
  (await res.json()) as {
    error: { message: string; code?: string; statementIndex?: number; opIndex?: number };
    preview?: WritePreview;
  };
const users = async (driver: Driver) =>
  (await driver.query("SELECT id, email, name FROM users ORDER BY id"))[0]?.rows;

describe("local", () => {
  let driver: LocalDriver;
  let h: Harness;
  beforeEach(async () => {
    driver = await LocalDriver.open(copyFixtureDb(dir), { readOnly: false });
    h = harness(driver);
    return () => driver.close();
  });
  const original = [
    [1, "ada@example.com", "Ada"],
    [2, "alan@example.com", "Alan"],
  ];

  test("dryRun returns the SQL, asks for nothing and changes nothing", async () => {
    const res = await batch(
      h,
      [
        { op: "insert", values: { email: "grace@example.com" } },
        { op: "update", key: row(1), set: { name: "Ada L." } },
        { op: "delete", key: row(2) },
      ],
      {},
      "?dryRun=1",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      statements: [
        { sql: 'DELETE FROM "users" WHERE rowid = ?', params: [2], dangerous: false },
        {
          sql: 'UPDATE "users" SET "name" = ? WHERE rowid = ?',
          params: ["Ada L.", 1],
          dangerous: false,
        },
        {
          sql: 'INSERT INTO "users" ("email") VALUES (?)',
          params: ["grace@example.com"],
          dangerous: false,
        },
      ],
      dangerous: false,
      requiresConfirm: "none",
    } satisfies WritePreview);
    expect(await users(driver)).toEqual(original);
  });

  test("applies the ops in one batch, without a confirmation", async () => {
    const res = await batch(h, [
      { op: "insert", values: { email: "grace@example.com" } },
      { op: "update", key: row(1), set: { name: "Ada L." } },
      { op: "delete", key: row(2) },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      statements: 3,
      inserted: 1,
      updated: 1,
      deleted: 1,
      warnings: [],
    } satisfies Partial<BatchResponse>);
    expect(await users(driver)).toEqual([
      [1, "ada@example.com", "Ada L."],
      // Deleting row 2 first frees its rowid.
      [2, "grace@example.com", null],
    ]);
  });

  test("a batch whose 3rd op fails leaves no changes", async () => {
    const res = await batch(h, [
      { op: "update", key: row(1), set: { name: "changed" } },
      { op: "delete", key: row(2) },
      // NOT NULL on email.
      { op: "insert", values: { email: null } },
    ]);
    expect(res.status).toBe(400);
    const { error } = await errorOf(res);
    expect(error.message).toMatch(/NOT NULL constraint failed: users\.email/);
    // Statement 2 of the reordered batch (delete, update, insert); op 2 as staged.
    expect(error).toMatchObject({ statementIndex: 2, opIndex: 2 });
    expect(await users(driver)).toEqual(original);
  });

  test("a row deleted between staging and apply is a conflict, and rolls back", async () => {
    await driver.query("DELETE FROM users WHERE id = 2");
    const res = await batch(h, [
      { op: "update", key: row(1), set: { name: "changed" } },
      { op: "update", key: row(2), set: { name: "changed" } },
    ]);
    expect(res.status).toBe(409);
    const { error } = await errorOf(res);
    expect(error).toMatchObject({ code: "conflict", statementIndex: 1, opIndex: 1 });
    expect(await users(driver)).toEqual([[1, "ada@example.com", "Ada"]]);
  });

  test("a delete of a vanished row is a conflict too", async () => {
    await driver.query("DELETE FROM users WHERE id = 1");
    const res = await batch(h, [
      { op: "delete", key: row(1) },
      { op: "insert", values: { email: "new@example.com" } },
    ]);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toMatchObject({ code: "conflict", opIndex: 0 });
    expect((await users(driver))?.map((r) => r[1])).toEqual(["alan@example.com"]);
  });

  test("a delete followed by re-adding the same unique value works", async () => {
    const res = await batch(h, [
      { op: "insert", values: { email: "ada@example.com" } },
      { op: "delete", key: row(1) },
    ]);
    expect(res.status).toBe(200);
    expect((await users(driver))?.map((r) => r[1])).toEqual([
      "alan@example.com",
      "ada@example.com",
    ]);
  });

  test("keys and 64-bit values reach SQLite intact", async () => {
    await driver.query("CREATE TABLE big (n INTEGER PRIMARY KEY, v INTEGER)");
    await driver.query("INSERT INTO big VALUES (9007199254740993, 1)");
    const res = await h.post("/api/batch", {
      table: "big",
      ops: [
        {
          op: "update",
          key: { kind: "pk", values: { n: { $int: "9007199254740993" } } },
          set: { v: { $int: "9223372036854775807" } },
        },
        {
          op: "update",
          key: { kind: "rowid", rowid: "9007199254740993" },
          set: { v: { $int: "-5" } },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect((await driver.query("SELECT v FROM big"))[0]?.rows).toEqual([[-5]]);
  });

  test.each([
    [
      "an unknown table",
      { table: "nope", ops: [{ op: "insert", values: {} }] },
      404,
      /No such table: nope/,
    ],
    [
      "an unknown column",
      { table: "users", ops: [{ op: "insert", values: { nope: 1 } }] },
      400,
      /No such column: users\.nope/,
    ],
    ["no ops", { table: "users", ops: [] }, 400, /nothing to apply/],
    ["a malformed op", { table: "users", ops: [{ op: "truncate" }] }, 400, /Unknown edit op/],
    ["a bad table", { table: 1, ops: [] }, 400, /"table" must be a string/],
    [
      "a bad confirm",
      { table: "users", ops: [{ op: "insert", values: {} }], confirm: false },
      400,
      /"confirm"/,
    ],
  ])("rejects %s", async (_, body, status, message) => {
    const res = await h.post("/api/batch", body);
    expect(res.status).toBe(status);
    if (message) expect((await errorOf(res)).error.message).toMatch(message);
    expect(await users(driver)).toEqual(original);
  });

  test("refuses to edit a view", async () => {
    await driver.query("CREATE VIEW v AS SELECT id, email FROM users");
    const res = await h.post("/api/batch", { table: "v", ops: [{ op: "delete", key: row(1) }] });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).error.message).toMatch(/a view and can't be edited/);
  });

  test("needs a session", async () => {
    const app = harness(driver);
    const res = await fetchWithoutCookie(app);
    expect(res.status).toBe(401);
  });
});

async function fetchWithoutCookie(h: Harness): Promise<Response> {
  const { createApp } = await import("../../src/server/app");
  return createApp(h.ctx).request("http://127.0.0.1:4101/api/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4101" },
    body: "{}",
  });
}

describe("read-only", () => {
  test.each([
    [
      "local",
      async () => ({ driver: await LocalDriver.open(copyFixtureDb(dir), { readOnly: true }) }),
    ],
    ["remote", async () => fakeD1(copyFixtureDb(dir), { readOnly: true })],
  ] as const)("%s: 403, and nothing reaches the database", async (_, open) => {
    const opened = await open();
    const h = harness(opened.driver);
    const requests = "requests" in opened ? opened.requests : undefined;
    const before = requests?.length ?? 0;
    for (const [op, keyword] of [
      [{ op: "insert", values: { email: "x@y.z" } }, "INSERT"],
      [{ op: "update", key: row(1), set: { name: "x" } }, "UPDATE"],
      [{ op: "delete", key: row(1) }, "DELETE"],
    ] as const) {
      for (const query of ["", "?dryRun=1"]) {
        const res = await batch(h, [op], {}, query);
        expect(res.status).toBe(403);
        expect((await errorOf(res)).error.message).toBe(
          `Read-only mode: ${keyword} is not allowed. Restart with --write to enable edits.`,
        );
      }
    }
    expect(requests?.length ?? 0).toBe(before);
    expect((await opened.driver.query("SELECT count(*) FROM users"))[0]?.rows).toEqual([[2]]);
    await opened.driver.close();
    if ("close" in opened) opened.close();
  });
});

describe("remote write mode (mocked D1)", () => {
  let fake: Awaited<ReturnType<typeof fakeD1>>;
  let h: Harness;
  beforeEach(async () => {
    fake = await fakeD1(copyFixtureDb(dir), { readOnly: false });
    h = harness(fake.driver);
    return () => {
      fake.close();
    };
  });
  const ops: EditOp[] = [
    { op: "update", key: row(1), set: { name: "Ada L." } },
    { op: "insert", values: { email: "grace@example.com" } },
  ];
  const sent = () =>
    fake.requests
      .filter((r) => r.method === "POST")
      .map((r) => r.body as { batch?: { sql: string; params?: unknown[] }[] });

  test("without a confirmation it answers 409 with the statements, and runs nothing", async () => {
    const before = sent().length;
    const res = await batch(h, ops);
    expect(res.status).toBe(409);
    const body = await errorOf(res);
    expect(body.error.code).toBe("confirmation_required");
    expect(body.preview?.requiresConfirm).toBe("click");
    expect(body.preview?.statements.map((s) => s.sql)).toEqual([
      'UPDATE "users" SET "name" = ? WHERE rowid = ?',
      'INSERT INTO "users" ("email") VALUES (?)',
    ]);
    // Only the schema lookups went out, no write.
    expect(
      sent()
        .slice(before)
        .some((b) => b.batch?.some((s) => /^(UPDATE|INSERT)/.test(s.sql))),
    ).toBe(false);
  });

  test("dryRun asks for a click and matches what runs", async () => {
    const preview = (await (await batch(h, ops, {}, "?dryRun=1")).json()) as WritePreview;
    expect(preview.requiresConfirm).toBe("click");
    const res = await batch(h, ops, { confirm: true });
    expect(res.status).toBe(200);
    const run = sent().at(-1)?.batch;
    expect(run?.map((s) => s.sql)).toEqual(preview.statements.map((s) => s.sql));
    expect(run?.map((s) => s.params ?? [])).toEqual(preview.statements.map((s) => s.params));
  });

  test("a click or the database name runs the batch", async () => {
    expect((await batch(h, ops, { confirm: true })).status).toBe(200);
    expect((await batch(h, [{ op: "delete", key: row(2) }], { confirm: "prod-db" })).status).toBe(
      200,
    );
    expect((await fake.driver.query("SELECT id, name FROM users ORDER BY id"))[0]?.rows).toEqual([
      [1, "Ada L."],
      [3, null],
    ]);
  });

  test("a row that no longer matches is reported as a warning, not rolled back (S1)", async () => {
    await fake.driver.query("DELETE FROM users WHERE id = 2");
    const res = await batch(
      h,
      [
        { op: "update", key: row(1), set: { name: "still applied" } },
        { op: "update", key: row(2), set: { name: "gone" } },
      ],
      { confirm: true },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.updated).toBe(1);
    expect(body.warnings).toEqual([
      { opIndex: 1, message: expect.stringMatching(/Update matched 0 rows, expected 1/) },
    ]);
  });

  test("a failing statement leaves the database unchanged", async () => {
    const res = await batch(
      h,
      [
        { op: "update", key: row(1), set: { name: "changed" } },
        { op: "insert", values: { email: null } },
      ],
      { confirm: true },
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).error.message).toMatch(/NOT NULL constraint failed: users\.email/);
    expect((await fake.driver.query("SELECT name FROM users WHERE id = 1"))[0]?.rows).toEqual([
      ["Ada"],
    ]);
  });

  test("the cached counts follow inserts and deletes without a recount", async () => {
    const counts = async () =>
      ((await (await h.get("/api/tables/counts")).json()) as { counts: Record<string, number> })
        .counts;
    expect((await counts()).users).toBe(2);
    const reads = () => sent().length;
    const before = reads();
    await batch(
      h,
      [
        { op: "insert", values: { email: "a@b.c" } },
        { op: "insert", values: { email: "d@e.f" } },
        { op: "delete", key: row(1) },
      ],
      { confirm: true },
    );
    const after = reads();
    expect((await counts()).users).toBe(3);
    // The batch itself, and nothing to recount.
    expect(reads() - after).toBe(0);
    expect(after - before).toBeGreaterThan(0);
  });
});

void path;
