import { describe, expect, test } from "vitest";
import { parseCli, UsageError } from "../../src/cli/args";

const run = (argv: string[]) => {
  const parsed = parseCli(argv);
  if (parsed.kind !== "run") throw new Error(`expected run, got ${parsed.kind}`);
  return parsed.options;
};

describe("parseCli", () => {
  test("defaults to local, writable, open, loopback", () => {
    expect(run([])).toEqual({
      mode: "local",
      path: undefined,
      port: undefined,
      host: "127.0.0.1",
      db: undefined,
      config: undefined,
      env: undefined,
      persistTo: undefined,
      write: true,
      open: true,
      yes: false,
    });
  });

  test("--write defaults by mode and can be overridden", () => {
    expect(run(["--local"]).write).toBe(true);
    expect(run(["--local", "--no-write"]).write).toBe(false);
    expect(run(["--remote"]).write).toBe(false);
    expect(run(["--remote", "--write"]).write).toBe(true);
  });

  test("flags and aliases", () => {
    const o = run([
      "--remote",
      "-p",
      "5555",
      "--host",
      "0.0.0.0",
      "--db",
      "prod",
      "--config",
      "w.toml",
      "--env",
      "staging",
      "--no-open",
      "-y",
    ]);
    expect(o).toMatchObject({
      mode: "remote",
      port: "5555",
      host: "0.0.0.0",
      db: "prod",
      config: "w.toml",
      env: "staging",
      open: false,
      yes: true,
    });
    expect(run(["--persist-to", "state"]).persistTo).toBe("state");
  });

  test("positional path for local", () => {
    expect(run(["--local", "./data.sqlite"])).toMatchObject({
      mode: "local",
      path: "./data.sqlite",
    });
    expect(run(["./data.sqlite"]).path).toBe("./data.sqlite");
  });

  test("help and version", () => {
    expect(parseCli(["--help"]).kind).toBe("help");
    expect(parseCli(["-h"]).kind).toBe("help");
    expect(parseCli(["--version"]).kind).toBe("version");
    expect(parseCli(["-v"]).kind).toBe("version");
  });

  test.each([
    [["--local", "--remote"], "--local and --remote are mutually exclusive."],
    [["--remote", "./x.sqlite"], "A database path can't be used with --remote."],
    [["a.sqlite", "b.sqlite"], "Expected at most one database path, got 2."],
    [["--bogus"], "Unknown option --bogus."],
    [["--db"], "--db needs a value."],
    [["--port"], "--port needs a value."],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(new UsageError(message));
  });
});
