import type { RowsKey } from "@shared/rows";
import { describe, expect, test, vi } from "vitest";
import { identifyRow } from "@/edits/row-key";
import { type RowRef, StagedEdits, sameValue } from "@/edits/staged-edits";

const row = (n: number): RowRef => ({ id: `r:${n}`, key: { kind: "rowid", rowid: n } });

describe("StagedEdits", () => {
  test("counts changed cells, inserted rows and deleted rows", () => {
    const s = new StagedEdits();
    expect(s.count).toBe(0);
    s.setCell(row(1), "a", "x", "old");
    s.setCell(row(1), "b", 2, 1);
    s.setCell(row(2), "a", null, "old");
    expect(s.count).toBe(3);
    s.addRow();
    s.deleteRows([row(3)]);
    expect(s.count).toBe(5);
  });

  test("setting a cell back to its original un-stages it", () => {
    const s = new StagedEdits();
    s.setCell(row(1), "a", "x", "old");
    s.setCell(row(1), "a", "old", "old");
    expect(s.count).toBe(0);
    expect(s.getSnapshot().updates.size).toBe(0);
    s.setCell(row(1), "n", { $int: "9007199254740993" }, { $int: "9007199254740993" });
    s.setCell(row(1), "z", null, null);
    expect(s.count).toBe(0);
  });

  test("keys on the row's key, so a re-sorted page keeps its changes", () => {
    const s = new StagedEdits();
    s.setCell(row(7), "a", "x", "old");
    // The same row, now at another index on another page: same id, same entry.
    s.setCell(row(7), "b", "y", "old");
    expect(s.getSnapshot().updates.size).toBe(1);
    expect(s.getSnapshot().updates.get("r:7")?.set).toEqual({ a: "x", b: "y" });
  });

  test("reverts a cell, and a row", () => {
    const s = new StagedEdits();
    s.setCell(row(1), "a", "x", "o");
    s.setCell(row(1), "b", "y", "o");
    s.revertCell("r:1", "a");
    expect(s.getSnapshot().updates.get("r:1")?.set).toEqual({ b: "y" });
    s.revertCell("r:1", "b");
    expect(s.getSnapshot().updates.has("r:1")).toBe(false);
    s.deleteRows([row(2)]);
    s.revertRow("r:2");
    expect(s.count).toBe(0);
    s.setCell(row(3), "a", "x", "o");
    s.revertRow("r:3");
    expect(s.count).toBe(0);
  });

  test("a deleted row drops its edits and refuses new ones", () => {
    const s = new StagedEdits();
    s.setCell(row(1), "a", "x", "o");
    s.deleteRows([row(1)]);
    expect(s.getSnapshot().updates.size).toBe(0);
    expect(s.count).toBe(1);
    s.setCell(row(1), "a", "again", "o");
    expect(s.count).toBe(1);
  });

  test("inserted rows: DEFAULT until set, revertable, removed by deleting", () => {
    const s = new StagedEdits();
    const a = s.addRow();
    const b = s.addRow();
    expect(a).not.toBe(b);
    s.setInsertCell(a, "name", "Ada");
    s.setInsertCell(a, "note", null);
    expect(s.getSnapshot().inserts.find((r) => r.tempId === a)?.values).toEqual({
      name: "Ada",
      note: null,
    });
    s.setInsertCell(a, "note", undefined);
    expect(s.getSnapshot().inserts.find((r) => r.tempId === a)?.values).toEqual({ name: "Ada" });
    // Newest first, so it is pinned at the top.
    expect(s.getSnapshot().inserts.map((r) => r.tempId)).toEqual([b, a]);
    s.deleteRows([{ id: a }]);
    s.revertRow(b);
    expect(s.count).toBe(0);
  });

  test("builds ops: deletes, updates, then inserts oldest first, with the row each came from", () => {
    const s = new StagedEdits();
    s.setCell(row(1), "a", "x", "o");
    s.deleteRows([row(2)]);
    const first = s.addRow();
    const second = s.addRow();
    s.setInsertCell(first, "a", "first");
    s.setInsertCell(second, "a", "second");
    expect(s.buildOps()).toEqual({
      ops: [
        { op: "delete", key: { kind: "rowid", rowid: 2 } },
        { op: "update", key: { kind: "rowid", rowid: 1 }, set: { a: "x" } },
        { op: "insert", values: { a: "first" } },
        { op: "insert", values: { a: "second" } },
      ],
      ids: ["r:2", "r:1", first, second],
    });
  });

  test("a blank inserted row builds an insert with no values (DEFAULT VALUES)", () => {
    const s = new StagedEdits();
    s.addRow();
    expect(s.buildOps().ops).toEqual([{ op: "insert", values: {} }]);
  });

  test("marks a failed row until anything changes", () => {
    const s = new StagedEdits();
    s.setCell(row(1), "a", "x", "o");
    s.markFailed("r:1");
    expect(s.getSnapshot().failed).toBe("r:1");
    s.setCell(row(1), "b", "y", "o");
    expect(s.getSnapshot().failed).toBeNull();
  });

  test("discardAll empties it", () => {
    const s = new StagedEdits();
    s.setCell(row(1), "a", "x", "o");
    s.addRow();
    s.deleteRows([row(2)]);
    s.discardAll();
    expect(s.count).toBe(0);
    expect(s.buildOps()).toEqual({ ops: [], ids: [] });
  });

  test("notifies subscribers with a new snapshot per change", () => {
    const s = new StagedEdits();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    const before = s.getSnapshot();
    s.setCell(row(1), "a", "x", "o");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).not.toBe(before);
    expect(before.count).toBe(0);
    off();
    s.discardAll();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("sameValue", () => {
  test.each<[Parameters<typeof sameValue>[0], Parameters<typeof sameValue>[1], boolean]>([
    [null, null, true],
    [null, "", false],
    ["", null, false],
    [1, 1, true],
    [1, "1", false],
    ["a", "a", true],
    [{ $int: "9007199254740993" }, { $int: "9007199254740993" }, true],
    [{ $int: "9007199254740993" }, { $int: "9007199254740995" }, false],
    [{ $int: "5" }, 5, false],
    [{ $blob: 3 }, { $int: "3" }, false],
  ])("%j vs %j: %s", (a, b, expected) => {
    expect(sameValue(a, b)).toBe(expected);
  });
});

describe("identifyRow", () => {
  const cols = (...names: string[]) => names.map((name) => ({ name }));

  test("a rowid table by its hidden rowid column", () => {
    const ref = identifyRow(
      { kind: "rowid", columns: ["__d1s_rowid"] },
      cols("__d1s_rowid", "name"),
      [42, "Ada"],
    );
    expect(ref).toEqual({ id: "r:42", key: { kind: "rowid", rowid: 42 } });
  });

  test("a rowid past 2^53 travels as a string", () => {
    const ref = identifyRow({ kind: "rowid", columns: ["__d1s_rowid"] }, cols("__d1s_rowid"), [
      { $int: "9007199254740993" },
    ]);
    expect(ref).toEqual({
      id: "r:9007199254740993",
      key: { kind: "rowid", rowid: "9007199254740993" },
    });
  });

  test("a composite key from its columns, in key order", () => {
    const ref = identifyRow({ kind: "pk", columns: ["user", "org"] }, cols("org", "user", "role"), [
      3,
      9,
      "admin",
    ]);
    expect(ref).toEqual({
      id: "p:[9,3]",
      key: { kind: "pk", values: { user: 9, org: 3 } },
    });
  });

  test("distinct keys never share an id", () => {
    const key: RowsKey = { kind: "pk", columns: ["a", "b"] };
    const id = (a: string, b: string) => identifyRow(key, cols("a", "b"), [a, b])?.id;
    expect(id("1,2", "3")).not.toBe(id("1", "2,3"));
  });

  test("no key, or a NULL or BLOB key value, can't be edited", () => {
    expect(identifyRow({ kind: "none", columns: [] }, cols("a"), [1])).toBeUndefined();
    expect(identifyRow({ kind: "pk", columns: ["a"] }, cols("a"), [null])).toBeUndefined();
    expect(identifyRow({ kind: "pk", columns: ["a"] }, cols("a"), [{ $blob: 2 }])).toBeUndefined();
  });
});
