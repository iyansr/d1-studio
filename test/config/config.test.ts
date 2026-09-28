import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { findConfig } from "../../src/config/find";
import { parseConfig } from "../../src/config/parse";
import { pickBinding, selectBindings } from "../../src/config/select";
import { UserError } from "../../src/errors";

const fixtures = path.resolve(import.meta.dirname, "../fixtures/configs");
const fx = (...p: string[]) => path.join(fixtures, ...p);

const tmp = mkdtempSync(path.join(tmpdir(), "d1s-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const write = (rel: string, text = "") => {
  const file = path.join(tmp, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};

describe("findConfig", () => {
  test("finds wrangler.jsonc in cwd", () => {
    expect(findConfig(fx("jsonc-comments-trailing"))).toEqual({
      path: fx("jsonc-comments-trailing", "wrangler.jsonc"),
      userConfigPath: fx("jsonc-comments-trailing", "wrangler.jsonc"),
      redirected: false,
    });
  });

  test("prefers wrangler.json over wrangler.toml", () => {
    expect(findConfig(fx("json-and-toml"))?.path).toBe(fx("json-and-toml", "wrangler.json"));
  });

  test("prefers wrangler.jsonc over wrangler.toml", () => {
    write("prec/wrangler.toml");
    write("prec/wrangler.jsonc", "{}");
    write("prec/.git/HEAD");
    expect(findConfig(path.join(tmp, "prec"))?.path).toBe(path.join(tmp, "prec/wrangler.jsonc"));
  });

  test("walks up from a nested directory", () => {
    expect(findConfig(fx("nested", "sub", "dir"))?.path).toBe(fx("nested", "wrangler.toml"));
  });

  test("returns undefined when nothing is found up to the git root", () => {
    expect(findConfig(fx("no-config"))).toBeUndefined();
  });

  test("stops at a .git directory or file", () => {
    write("outer/wrangler.toml");
    write("outer/repo/.git", "gitdir: /elsewhere");
    mkdirSync(path.join(tmp, "outer/repo/sub"), { recursive: true });
    expect(findConfig(path.join(tmp, "outer/repo/sub"))).toBeUndefined();
    write("outer2/wrangler.toml");
    mkdirSync(path.join(tmp, "outer2/repo/.git/objects"), { recursive: true });
    expect(findConfig(path.join(tmp, "outer2/repo"))).toBeUndefined();
  });

  test("searches the git root itself", () => {
    write("rooted/wrangler.toml");
    write("rooted/.git/HEAD");
    mkdirSync(path.join(tmp, "rooted/a/b"), { recursive: true });
    expect(findConfig(path.join(tmp, "rooted/a/b"))?.path).toBe(
      path.join(tmp, "rooted/wrangler.toml"),
    );
  });

  test("follows a deploy redirect", () => {
    expect(findConfig(fx("redirected"))).toEqual({
      path: fx("redirected", "dist", "app", "wrangler.json"),
      userConfigPath: fx("redirected", "wrangler.jsonc"),
      redirected: true,
    });
  });

  test("a nearer user config beats a redirect further up", () => {
    write("redir/.wrangler/deploy/config.json", '{"configPath":"../../gen/wrangler.json"}');
    write("redir/gen/wrangler.json", "{}");
    write("redir/.git/HEAD");
    write("redir/pkg/wrangler.toml");
    expect(findConfig(path.join(tmp, "redir/pkg"))?.redirected).toBe(false);
    expect(findConfig(path.join(tmp, "redir"))?.path).toBe(
      path.join(tmp, "redir/gen/wrangler.json"),
    );
  });

  test("rejects a broken redirect", () => {
    write("badredir/.wrangler/deploy/config.json", '{"configPath":"../../missing.json"}');
    write("badredir/.git/HEAD");
    expect(() => findConfig(path.join(tmp, "badredir"))).toThrow(/doesn't exist/);
    write("badredir2/.wrangler/deploy/config.json", "{}");
    write("badredir2/.git/HEAD");
    expect(() => findConfig(path.join(tmp, "badredir2"))).toThrow(/no "configPath"/);
  });

  test("--config uses the given path relative to cwd", () => {
    expect(findConfig(fixtures, "toml/wrangler.toml")?.path).toBe(fx("toml", "wrangler.toml"));
    expect(() => findConfig(fixtures, "missing.toml")).toThrow(UserError);
    expect(() => findConfig(fixtures, "missing.toml")).toThrow(/Config file not found/);
  });
});

describe("parseConfig", () => {
  test("JSONC with comments and trailing commas", () => {
    expect(parseConfig(fx("jsonc-comments-trailing", "wrangler.jsonc"))).toEqual({
      path: fx("jsonc-comments-trailing", "wrangler.jsonc"),
      dir: fx("jsonc-comments-trailing"),
      accountId: "acc-123",
      d1: [
        {
          binding: "DB",
          databaseName: "app-db",
          databaseId: "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90",
          previewDatabaseId: undefined,
        },
      ],
      envs: {},
    });
  });

  test("TOML", () => {
    const cfg = parseConfig(fx("toml", "wrangler.toml"));
    expect(cfg.accountId).toBe("acc-toml");
    expect(cfg.d1).toEqual([
      {
        binding: "DB",
        databaseName: "toml-db",
        databaseId: "b81c0d44-2e6f-4a19-8d3b-0c5e7a9f1d22",
        previewDatabaseId: "preview-1",
      },
    ]);
  });

  test("environments", () => {
    const cfg = parseConfig(fx("with-envs", "wrangler.toml"));
    expect(cfg.d1.map((b) => b.databaseName)).toEqual(["top-db"]);
    expect(cfg.envs.staging?.d1.map((b) => b.databaseName)).toEqual(["staging-db"]);
    expect(cfg.envs.empty).toEqual({ d1: [] });
  });

  test("JSON parse errors carry file, line and column", () => {
    const file = write(
      "broken/wrangler.jsonc",
      '{\n  "d1_databases": [\n    { "binding" "DB" }\n  ]\n}',
    );
    expect(() => parseConfig(file)).toThrow(/wrangler\.jsonc:3:17: ColonExpected$/);
  });

  test("TOML parse errors carry file, line and column", () => {
    const file = write("broken/wrangler.toml", 'name = "x"\nbinding = \n');
    expect(() => parseConfig(file)).toThrow(/wrangler\.toml:2:11: Invalid TOML document/);
  });

  test("a binding entry without a name is an error", () => {
    const file = write("nobind/wrangler.json", '{"d1_databases":[{"database_id":"x"}]}');
    expect(() => parseConfig(file)).toThrow(/d1_databases\[0\] has no "binding"/);
  });
});

describe("selectBindings", () => {
  const cfg = parseConfig(fx("with-envs", "wrangler.toml"));

  test("top level without --env", () => {
    expect(selectBindings(cfg).map((b) => b.databaseId)).toEqual(["top-id"]);
  });

  test("only the env's bindings with --env, no inheritance", () => {
    expect(selectBindings(cfg, "staging").map((b) => b.databaseId)).toEqual(["staging-id"]);
    expect(selectBindings(cfg, "empty")).toEqual([]);
  });

  test("without --env, env-only bindings name the environments that have D1", () => {
    const envOnly = parseConfig(fx("env-only", "wrangler.jsonc"));
    expect(() => selectBindings(envOnly)).toThrow(
      /^No top-level d1_databases in .*wrangler\.jsonc\. These environments have D1: local, prod\. Pass --env <name>\.$/,
    );
    expect(selectBindings(envOnly, "local").map((b) => b.databaseId)).toEqual(["local-db-id"]);
    expect(selectBindings(envOnly, "preview")).toEqual([]);
  });

  test("unknown env lists the available ones", () => {
    expect(() => selectBindings(cfg, "prod")).toThrow(
      /Unknown environment "prod" in .*\. Available: staging, empty\./,
    );
  });
});

describe("pickBinding", () => {
  const multi = parseConfig(fx("multi-db", "wrangler.jsonc")).d1;

  test("--db matches binding or database_name", async () => {
    expect((await pickBinding(multi, "ANALYTICS", { tty: false })).binding).toBe("ANALYTICS");
    expect((await pickBinding(multi, "main-db", { tty: false })).binding).toBe("DB");
    await expect(pickBinding(multi, "nope", { tty: false })).rejects.toThrow(
      'No D1 binding or database named "nope". Available: DB (main-db), ANALYTICS (analytics).',
    );
  });

  test("a single binding is used directly", async () => {
    const [first] = multi;
    expect(await pickBinding(multi.slice(0, 1), undefined, { tty: false })).toBe(first);
  });

  test("several without a TTY fail with the names", async () => {
    await expect(pickBinding(multi, undefined, { tty: false })).rejects.toThrow(
      "Multiple D1 databases: DB, ANALYTICS. Pass --db <name>.",
    );
  });

  test("several on a TTY prompt", async () => {
    const prompt = vi.fn(async (b: typeof multi) => b[1] as (typeof multi)[number]);
    expect((await pickBinding(multi, undefined, { tty: true, prompt })).binding).toBe("ANALYTICS");
    expect(prompt).toHaveBeenCalledWith(multi);
  });

  test("no bindings is an error", async () => {
    await expect(pickBinding([], undefined, { tty: false, source: "./w.toml" })).rejects.toThrow(
      "No d1_databases in ./w.toml.",
    );
  });
});
