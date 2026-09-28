import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { UserError } from "../../src/errors";
import { localD1FileName } from "../../src/local/filename";
import {
  assertSqliteFile,
  d1StateDir,
  listCandidates,
  locateLocalDb,
  resolveLocalTarget,
  resolvePersistDir,
} from "../../src/local/locate";
import { ANALYTICS_FILE, DB_FILE } from "../fixtures/make";

const project = path.resolve(import.meta.dirname, "../fixtures/project-two-dbs");
const fixtureDir = d1StateDir(path.join(project, ".wrangler", "state"));
const tmp = mkdtempSync(path.join(tmpdir(), "d1s-locate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("localD1FileName", () => {
  test.each([
    ["3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90", DB_FILE],
    ["b81c0d44-2e6f-4a19-8d3b-0c5e7a9f1d22", ANALYTICS_FILE],
  ])("%s", (id, file) => {
    expect(localD1FileName(id)).toBe(file);
  });
});

describe("resolvePersistDir", () => {
  const cwd = path.resolve("/work/app/sub");
  test("defaults to .wrangler/state next to the user config", () => {
    expect(
      resolvePersistDir({ cwd, userConfigPath: path.resolve("/work/app/wrangler.toml") }),
    ).toBe(path.resolve("/work/app/.wrangler/state"));
  });
  test("defaults to cwd without a config", () => {
    expect(resolvePersistDir({ cwd })).toBe(path.resolve("/work/app/sub/.wrangler/state"));
  });
  test("--persist-to is relative to cwd", () => {
    expect(
      resolvePersistDir({ cwd, persistTo: "../state", userConfigPath: "/elsewhere/wrangler.toml" }),
    ).toBe(path.resolve("/work/app/state"));
  });
});

describe("locateLocalDb", () => {
  test("derives the file from database_id", () => {
    expect(
      locateLocalDb(
        { binding: "DB", databaseId: "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90" },
        fixtureDir,
      ),
    ).toBe(path.join(fixtureDir, DB_FILE));
  });

  test("prefers preview_database_id, then database_id, then binding", () => {
    const dir = path.join(tmp, "prefer");
    mkdirSync(dir, { recursive: true });
    const binding = { binding: "B", databaseId: "real", previewDatabaseId: "preview" };
    for (const id of ["B", "real", "preview"])
      writeFileSync(path.join(dir, localD1FileName(id)), "");
    expect(locateLocalDb(binding, dir)).toBe(path.join(dir, localD1FileName("preview")));
    rmSync(path.join(dir, localD1FileName("preview")));
    expect(locateLocalDb(binding, dir)).toBe(path.join(dir, localD1FileName("real")));
    rmSync(path.join(dir, localD1FileName("real")));
    expect(locateLocalDb(binding, dir)).toBe(path.join(dir, localD1FileName("B")));
    rmSync(path.join(dir, localD1FileName("B")));
    expect(locateLocalDb(binding, dir)).toBeUndefined();
  });
});

describe("listCandidates", () => {
  test("lists databases with tables and counts, skipping metadata.sqlite and sidecars", async () => {
    const dir = path.join(tmp, "cands");
    mkdirSync(dir, { recursive: true });
    copyFileSync(path.join(fixtureDir, DB_FILE), path.join(dir, "a.sqlite"));
    copyFileSync(path.join(fixtureDir, ANALYTICS_FILE), path.join(dir, "b.sqlite"));
    copyFileSync(path.join(fixtureDir, "metadata.sqlite"), path.join(dir, "metadata.sqlite"));
    writeFileSync(path.join(dir, "a.sqlite-wal"), "");
    writeFileSync(path.join(dir, "notes.txt"), "");
    utimesSync(path.join(dir, "a.sqlite"), new Date(2000, 0, 1), new Date(2000, 0, 1));

    const list = await listCandidates(dir);
    expect(list.map((c) => [c.id, c.fileName])).toEqual([
      [0, "b.sqlite"],
      [1, "a.sqlite"],
    ]);
    expect(list[0]?.tables).toEqual([{ name: "events", rows: 4 }]);
    expect(list[1]?.tables).toEqual([
      { name: "sessions", rows: 3 },
      { name: "users", rows: 2 },
    ]);
    expect(list[1]?.mtime).toBe(new Date(2000, 0, 1).toISOString());
    expect(list[1]?.size).toBeGreaterThan(0);
  });

  test("counts rows for at most 5 tables", async () => {
    const dir = path.join(tmp, "many");
    mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "m.sqlite"));
    for (let i = 1; i <= 7; i++) db.exec(`CREATE TABLE t${i} (x); INSERT INTO t${i} VALUES (1)`);
    db.close();
    const [c] = await listCandidates(dir);
    expect(c?.tables.map((t) => t.rows)).toEqual([1, 1, 1, 1, 1, null, null]);
  });

  test("reports unreadable files instead of failing", async () => {
    const dir = path.join(tmp, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "junk.sqlite"),
      "definitely not sqlite, but long enough to have a header",
    );
    const [c] = await listCandidates(dir);
    expect(c?.tables).toEqual([]);
    expect(c?.error).toMatch(/not a database/);
  });

  test("an empty or missing dir has no candidates", async () => {
    const dir = path.join(tmp, "empty");
    mkdirSync(dir, { recursive: true });
    expect(await listCandidates(dir)).toEqual([]);
    expect(await listCandidates(path.join(tmp, "missing"))).toEqual([]);
  });
});

describe("resolveLocalTarget", () => {
  test("opens a derived match directly", async () => {
    expect(
      await resolveLocalTarget(
        { binding: "ANALYTICS", databaseId: "b81c0d44-2e6f-4a19-8d3b-0c5e7a9f1d22" },
        fixtureDir,
      ),
    ).toEqual({ kind: "file", path: path.join(fixtureDir, ANALYTICS_FILE) });
  });

  test("falls back to needs-db when files exist but none match", async () => {
    const target = await resolveLocalTarget({ binding: "OTHER", databaseId: "nope" }, fixtureDir);
    expect(target.kind).toBe("needs-db");
    if (target.kind === "needs-db") expect(target.candidates).toHaveLength(2);
  });

  test("stops with a hint when nothing is on disk", async () => {
    const dir = path.join(tmp, "nothing");
    mkdirSync(dir, { recursive: true });
    await expect(resolveLocalTarget({ binding: "DB" }, dir)).rejects.toThrow(UserError);
    await expect(resolveLocalTarget({ binding: "DB" }, dir)).rejects.toThrow(
      "Run `wrangler dev` or `wrangler d1 migrations apply --local` first.",
    );
    await expect(resolveLocalTarget({ binding: "DB" }, dir)).rejects.toThrow(
      "pass the same --persist-to here",
    );
  });
});

describe("assertSqliteFile", () => {
  test("accepts a SQLite file", () => {
    expect(() => assertSqliteFile(path.join(fixtureDir, DB_FILE))).not.toThrow();
  });
  test("rejects a missing file or a non-SQLite file", () => {
    expect(() => assertSqliteFile(path.join(tmp, "missing.sqlite"))).toThrow(/No such file/);
    const junk = path.join(tmp, "junk.db");
    writeFileSync(junk, "hello");
    expect(() => assertSqliteFile(junk)).toThrow(/is not a SQLite database/);
    expect(() => assertSqliteFile(tmp)).toThrow(/No such file/);
  });
});
