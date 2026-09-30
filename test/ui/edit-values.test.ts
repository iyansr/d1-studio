import { describe, expect, test } from "vitest";
import {
  editText,
  formatJson,
  inputKind,
  jsonProblem,
  parseInput,
  parseNumber,
} from "@/edits/values";

describe("inputKind", () => {
  test.each([
    ["INTEGER", 1, "number"],
    ["BIGINT", null, "number"],
    ["REAL", null, "number"],
    ["DOUBLE PRECISION", null, "number"],
    ["TEXT", "x", "text"],
    ["VARCHAR(20)", "x", "text"],
    ["NUMERIC", 1, "text"],
    ["DATETIME", null, "text"],
    ["BLOB", { $blob: 3 }, "text"],
    // No declared type: follow the value.
    ["", 5, "number"],
    ["", { $int: "9007199254740993" }, "number"],
    ["", "x", "text"],
    ["", null, "text"],
  ] as const)("%s holding %j: %s", (type, original, expected) => {
    expect(inputKind(type, original)).toBe(expected);
  });
});

describe("editText", () => {
  test.each([
    [null, ""],
    [undefined, ""],
    [42, "42"],
    [1.5, "1.5"],
    ["héllo", "héllo"],
    [{ $int: "9007199254740993" }, "9007199254740993"],
    [{ $blob: 3 }, ""],
  ] as const)("%j is %j", (value, expected) => {
    expect(editText(value)).toBe(expected);
  });
});

describe("parseNumber", () => {
  test.each([
    ["42", 42],
    ["-7", -7],
    ["+5", 5],
    ["1.50", 1.5],
    ["1e3", 1000],
    [" 12 ", 12],
    ["9007199254740993", { $int: "9007199254740993" }],
    ["-9223372036854775808", { $int: "-9223372036854775808" }],
    ["9223372036854775807", { $int: "9223372036854775807" }],
  ] as const)("%s", (text, value) => {
    expect(parseNumber(text)).toEqual({ ok: true, value });
  });

  test.each(["", "  ", "abc", "1.2.3", "1e999", "9223372036854775808", "NaN", "--1"])(
    "%j is invalid",
    (text) => {
      expect(parseNumber(text).ok).toBe(false);
    },
  );

  test("text passes through untouched, including empty", () => {
    expect(parseInput("text", "")).toEqual({ ok: true, value: "" });
    expect(parseInput("text", "  padded ")).toEqual({ ok: true, value: "  padded " });
    expect(parseInput("number", "3")).toEqual({ ok: true, value: 3 });
  });
});

describe("json", () => {
  test("accepts objects and arrays only", () => {
    expect(jsonProblem('{"a":1}')).toBeNull();
    expect(jsonProblem("[1,2]")).toBeNull();
    expect(jsonProblem("1")).toMatch(/object or array/);
    expect(jsonProblem("null")).toMatch(/object or array/);
    expect(jsonProblem('{"a":')).toEqual(expect.any(String));
    expect(jsonProblem("")).toEqual(expect.any(String));
  });

  test("formats with two spaces", () => {
    expect(formatJson('{"a":[1,2],"b":{}}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}');
  });
});
