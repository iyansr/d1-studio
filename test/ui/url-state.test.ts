import { describe, expect, test } from "vitest";
import { DEFAULT_STATE, formatUrlState, parseUrlState } from "../../ui/src/lib/url-state";

describe("URL state", () => {
  test("defaults, and defaults aren't written", () => {
    expect(parseUrlState("")).toEqual(DEFAULT_STATE);
    expect(formatUrlState(DEFAULT_STATE)).toBe("");
  });

  test("round-trips every field", () => {
    const state = {
      table: "user events",
      tab: "structure" as const,
      page: 3,
      size: 500 as const,
      sort: [
        { col: "a:b", dir: "desc" as const },
        { col: "id", dir: "asc" as const },
      ],
      filters: [
        { col: "age", op: "ge" as const, value: 18 },
        { col: "email", op: "null" as const },
      ],
    };
    const search = formatUrlState(state);
    expect(search).toBe(
      "?table=user+events&tab=structure&p=3&size=500&sort=a%3Ab%3Adesc&sort=id%3Aasc&f=%5B%7B%22col%22%3A%22age%22%2C%22op%22%3A%22ge%22%2C%22value%22%3A18%7D%2C%7B%22col%22%3A%22email%22%2C%22op%22%3A%22null%22%7D%5D",
    );
    expect(parseUrlState(search)).toEqual(state);
  });

  test("the table is never `t`, which is the session token", () => {
    expect(formatUrlState({ ...DEFAULT_STATE, table: "users" })).toBe("?table=users");
    expect(parseUrlState("?t=users").table).toBeNull();
  });

  test.each([
    ["?tab=nope", { tab: "data" }],
    ["?p=-2", { page: 0 }],
    ["?p=x", { page: 0 }],
    ["?size=20", { size: 50 }],
    ["?sort=id", { sort: [] }],
    ["?f=nope", { filters: [] }],
    [
      '?f=[{"col":"a","op":"regexp","value":1},{"col":"b","op":"eq"},{"col":"c","op":"nnull"}]',
      { filters: [{ col: "c", op: "nnull" }] },
    ],
  ])("bad values fall back: %s", (search, expected) => {
    expect(parseUrlState(search)).toMatchObject(expected);
  });
});
