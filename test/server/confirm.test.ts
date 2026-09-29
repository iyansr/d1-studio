import { describe, expect, test } from "vitest";
import {
  confirmationLevel,
  decideWrite,
  type WriteDecision,
  type WriteRequest,
  writePreview,
} from "../../src/server/confirm";

const base: WriteRequest = {
  mode: "remote",
  readOnly: false,
  dangerous: false,
  source: "grid",
  databaseName: "prod-db",
};

describe("confirmationLevel", () => {
  // mode × dangerous × source
  test.each([
    ["local", false, "grid", "none"],
    ["local", true, "grid", "none"],
    ["local", false, "editor", "none"],
    ["local", true, "editor", "none"],
    ["remote", false, "grid", "click"],
    ["remote", true, "grid", "type-name"],
    ["remote", false, "editor", "none"],
    ["remote", true, "editor", "type-name"],
  ] as const)("%s, dangerous=%s, %s: %s", (mode, dangerous, source, expected) => {
    expect(confirmationLevel({ mode, dangerous, source })).toBe(expected);
  });
});

describe("decideWrite", () => {
  const run: WriteDecision = { action: "run" };

  // mode × readOnly × dangerous, for a grid edit with no confirmation sent.
  test.each([
    ["local", false, false, run],
    ["local", false, true, run],
    ["local", true, false, { action: "refuse" }],
    ["local", true, true, { action: "refuse" }],
    ["remote", false, false, { action: "confirm", level: "click" }],
    ["remote", false, true, { action: "confirm", level: "type-name" }],
    ["remote", true, false, { action: "refuse" }],
    ["remote", true, true, { action: "refuse" }],
  ] as const)(
    "%s, readOnly=%s, dangerous=%s, no confirm",
    (mode, readOnly, dangerous, expected) => {
      expect(decideWrite({ ...base, mode, readOnly, dangerous })).toEqual(expected);
    },
  );

  test("a click confirms a safe write, and any string does too", () => {
    expect(decideWrite({ ...base, confirm: true })).toEqual(run);
    expect(decideWrite({ ...base, confirm: "prod-db" })).toEqual(run);
  });

  test("a dangerous write needs the exact database name", () => {
    const dangerous = { ...base, dangerous: true };
    expect(decideWrite({ ...dangerous, confirm: "prod-db" })).toEqual(run);
    for (const wrong of [true, "prod", "PROD-DB", "prod-db ", ""] as const) {
      expect(decideWrite({ ...dangerous, confirm: wrong })).toEqual({ action: "mismatch" });
    }
  });

  test("the editor only asks for dangerous SQL", () => {
    const editor = { ...base, source: "editor" } as const;
    expect(decideWrite(editor)).toEqual(run);
    expect(decideWrite({ ...editor, dangerous: true })).toEqual({
      action: "confirm",
      level: "type-name",
    });
  });

  test("local mode ignores whatever confirm says", () => {
    expect(decideWrite({ ...base, mode: "local", dangerous: true, confirm: "nope" })).toEqual(run);
  });
});

describe("writePreview", () => {
  test("classifies each statement", () => {
    const preview = writePreview(
      [
        { sql: "SELECT 1" },
        { sql: "DELETE FROM t" },
        { sql: "DELETE FROM t WHERE id = ?", params: [1] },
      ],
      { mode: "remote", source: "editor" },
    );
    expect(preview).toEqual({
      statements: [
        { sql: "SELECT 1", params: [], dangerous: false },
        { sql: "DELETE FROM t", params: [], dangerous: true },
        { sql: "DELETE FROM t WHERE id = ?", params: [1], dangerous: false },
      ],
      dangerous: true,
      requiresConfirm: "type-name",
    });
  });
});
