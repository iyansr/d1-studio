import { describe, expect, test } from "vitest";
import { formatBanner, formatDatabase, formatHostWarning } from "../../src/cli/banner";
import { browserCommand } from "../../src/cli/browser";

// Vitest's stdout isn't a TTY, so styleText emits no colour codes.
describe("banner", () => {
  test("PRD format", () => {
    expect(
      formatBanner({
        version: "1.0.0",
        mode: "local",
        readOnly: false,
        database: formatDatabase("prod-db", "DB", "3f2a9c1e-5b7d"),
        source: { label: "config", value: "./wrangler.jsonc" },
        url: "http://127.0.0.1:4101/?t=abc",
      }),
    ).toBe(
      [
        "d1-studio v1.0.0",
        "  mode      local (read-write)",
        "  database  prod-db (binding DB, id 3f2a…)",
        "  config    ./wrangler.jsonc",
        "  studio    http://127.0.0.1:4101/?t=abc",
      ].join("\n"),
    );
  });

  test("read-only, file source and busy port note", () => {
    const text = formatBanner({
      version: "1.0.0",
      mode: "local",
      readOnly: true,
      database: formatDatabase("data.sqlite"),
      source: { label: "file", value: "./data.sqlite" },
      url: "http://127.0.0.1:4102/?t=abc",
      busyPort: 4101,
      notes: ["second note"],
    });
    expect(text).toContain("  mode      local (read-only)");
    expect(text).toContain("  database  data.sqlite\n");
    expect(text).toContain("  file      ./data.sqlite");
    expect(text).toContain("  note      port 4101 was in use\n  note      second note");
  });

  test("host warning box", () => {
    const box = formatHostWarning("0.0.0.0", false).split("\n");
    expect(box[0]).toMatch(/^┌─+┐$/);
    expect(box[1]).toContain("Warning: listening on 0.0.0.0");
    expect(box[2]).toContain("can read and write the database.");
    expect(new Set(box.map((l) => l.length)).size).toBe(1);
    expect(formatHostWarning("10.0.0.2", true)).toContain("can read the database.");
  });
});

describe("browserCommand", () => {
  const url = "http://127.0.0.1:4101/?t=abc";
  test.each([
    ["darwin", "open", [url]],
    ["linux", "xdg-open", [url]],
    ["win32", "cmd", ["/c", "start", '""', `"${url}"`]],
  ] as const)("%s", (platform, command, args) => {
    expect(browserCommand(url, platform)).toMatchObject({ command, args });
  });

  test("windows passes arguments verbatim", () => {
    expect(browserCommand(url, "win32").options).toEqual({ windowsVerbatimArguments: true });
  });
});
