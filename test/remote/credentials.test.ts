import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, test, vi } from "vitest";
import { UserError } from "../../src/errors";
import { D1ApiError, NO_D1_ACCESS } from "../../src/remote/client";
import {
  explainAuthError,
  findWrangler,
  NO_CREDENTIALS,
  parseAuthToken,
  type ResolveOptions,
  type RunResult,
  resolveCredentials,
  type WranglerCommand,
} from "../../src/remote/credentials";
import { Secret } from "../../src/remote/secret";
import { fixture, sequence } from "./stub";

const TOKEN = "cf-oauth-token-SECRET-4f1c9e";
const ACCOUNT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const local: WranglerCommand = { file: "node", args: ["/p/node_modules/wrangler/bin/wrangler.js"] };
const global: WranglerCommand = { file: "wrangler", args: [] };

const ok = (json: unknown): RunResult => ({
  code: 0,
  stdout: `${JSON.stringify(json, null, 2)}\n`,
  stderr: "",
});
const loggedOut: RunResult = {
  code: 1,
  stdout: "",
  stderr: "✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.\n",
};

/** The error a promise rejects with; fails the test if it resolves. */
const failure = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as Error,
  );

function options(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    env: {},
    cwd: "/p",
    tty: false,
    findWrangler: () => [local, global],
    run: vi.fn(async () => ok({ type: "oauth", token: TOKEN })),
    fetch: sequence(fixture("accounts")).fetch,
    ...overrides,
  };
}

describe("token precedence", () => {
  test("CLOUDFLARE_API_TOKEN wins and Wrangler is never run", async () => {
    const run = vi.fn();
    const creds = await resolveCredentials(
      options({ env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, run }),
    );
    expect(creds.token.reveal()).toBe(TOKEN);
    expect(creds).toMatchObject({ source: "env", accountId: ACCOUNT });
    expect(run).not.toHaveBeenCalled();
  });

  test("otherwise the project's Wrangler, from the config dir", async () => {
    const run = vi.fn(async () => ok({ type: "oauth", token: TOKEN }));
    const creds = await resolveCredentials(
      options({ run, projectDir: "/p/app", configAccountId: ACCOUNT }),
    );
    expect(creds).toMatchObject({ source: "wrangler", accountId: ACCOUNT });
    expect(creds.token.reveal()).toBe(TOKEN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(local, "/p/app");
  });

  test("a missing local Wrangler falls through to the global one", async () => {
    const run = vi.fn(async (c: WranglerCommand) =>
      c === local
        ? { notFound: true, code: null, stdout: "", stderr: "" }
        : ok({ type: "api_token", token: TOKEN }),
    );
    const creds = await resolveCredentials(options({ run, configAccountId: ACCOUNT }));
    expect(creds.token.reveal()).toBe(TOKEN);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("logged out: the first Wrangler that runs decides", async () => {
    const run = vi.fn(async () => loggedOut);
    await expect(resolveCredentials(options({ run }))).rejects.toThrow(
      new UserError(NO_CREDENTIALS),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "no Wrangler at all",
      { notFound: true, code: null, stdout: "", stderr: "" },
      "isn't installed",
    ],
    [
      "an old Wrangler",
      { code: 1, stdout: "", stderr: "Unknown arguments: auth, token" },
      "Upgrade it",
    ],
    ["global API key", ok({ type: "api_key", key: TOKEN, email: "a@b.c" }), "CLOUDFLARE_API_KEY"],
    ["a timeout", { timedOut: true, code: null, stdout: "", stderr: "" }, "within 10 s"],
    ["garbage", { code: 0, stdout: `token: ${TOKEN}`, stderr: "" }, "doesn't recognise"],
  ])("%s: exits with the login hint", async (_, result, hint) => {
    const err = await failure(
      resolveCredentials(options({ run: async () => result as RunResult })),
    );
    expect(err).toBeInstanceOf(UserError);
    expect(err.message.split("\n")[0]).toBe(NO_CREDENTIALS);
    expect(err.message).toContain(hint);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("parseAuthToken", () => {
  test("accepts oauth and api_token JSON, ignoring text around it", () => {
    expect(parseAuthToken(ok({ type: "oauth", token: TOKEN }))).toEqual({ ok: true, token: TOKEN });
    expect(
      parseAuthToken({
        code: 0,
        stdout: `warn\n{"type":"api_token","token":"${TOKEN}\\n"}\n`,
        stderr: "",
      }),
    ).toEqual({ ok: true, token: TOKEN });
  });

  test("rejects an empty token or an unknown type", () => {
    expect(parseAuthToken(ok({ type: "oauth", token: "  " }))).toEqual({
      ok: false,
      reason: "unrecognised",
    });
    expect(parseAuthToken(ok({ type: "sso", token: TOKEN }))).toEqual({
      ok: false,
      reason: "unrecognised",
    });
  });
});

describe("account", () => {
  test("CLOUDFLARE_ACCOUNT_ID, then the config, then the API", async () => {
    const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "from-env" };
    const fetch = vi.fn();
    expect(
      (await resolveCredentials(options({ env, configAccountId: "from-config", fetch }))).accountId,
    ).toBe("from-env");
    expect(
      (
        await resolveCredentials(
          options({ env: { CLOUDFLARE_API_TOKEN: TOKEN }, configAccountId: "from-config", fetch }),
        )
      ).accountId,
    ).toBe("from-config");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("one account from the API is used", async () => {
    const one = fixture("accounts");
    const body = one.body as { result: unknown[] };
    body.result = body.result.slice(0, 1);
    const creds = await resolveCredentials(options({ fetch: sequence(one).fetch }));
    expect(creds).toMatchObject({ accountId: ACCOUNT, accountName: "Acme Inc" });
  });

  test("several accounts on a TTY: prompt", async () => {
    const selectAccount = vi.fn(
      async (accounts: { id: string; name: string }[]) => accounts[1] as never,
    );
    const creds = await resolveCredentials(options({ tty: true, selectAccount }));
    expect(selectAccount).toHaveBeenCalledOnce();
    expect(creds.accountName).toBe("Side Project");
  });

  test("several accounts without a TTY: fail with the list", async () => {
    const err = await failure(resolveCredentials(options()));
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain(`Acme Inc (${ACCOUNT})`);
    expect(err.message).toContain("Side Project (f0e1d2c3b4a5968778695a4b3c2d1e0f)");
    expect(err.message).toContain("Set CLOUDFLARE_ACCOUNT_ID");
  });

  test("a rejected token while listing accounts", async () => {
    const err = await failure(
      resolveCredentials(options({ fetch: sequence(fixture("error-unauthenticated")).fetch })),
    );
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain("Cloudflare didn't accept the token");
    expect(err.message).toContain("wrangler login");
  });
});

test("explainAuthError maps 403 to the D1 permission hint", () => {
  expect(explainAuthError(new D1ApiError("Authentication error", 403, 10000)).message).toBe(
    NO_D1_ACCESS,
  );
  const other = new D1ApiError("boom", 500);
  expect(explainAuthError(other)).toBe(other);
});

describe("findWrangler", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "d1s-wrangler-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const install = (dir: string, bin: unknown) => {
    const pkg = path.join(dir, "node_modules", "wrangler");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "wrangler", bin }));
    return pkg;
  };

  test("walks up to the git root, nearest first, then the global command", () => {
    const repo = path.join(tmp, "repo");
    const app = path.join(repo, "apps", "web");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(app, { recursive: true });
    const rootPkg = install(repo, {
      wrangler: "./bin/wrangler.js",
      wrangler2: "./bin/wrangler.js",
    });
    const appPkg = install(app, "bin/wrangler.js");
    // Above the git root: never used.
    install(tmp, "./bin/wrangler.js");

    const commands = findWrangler([app, repo]);
    const scripts = commands.map((c) => c.args[0]);
    expect(scripts[0]).toBe(path.join(appPkg, "bin", "wrangler.js"));
    expect(scripts[1]).toBe(path.join(rootPkg, "bin", "wrangler.js"));
    expect(commands[0]?.file).toBe(process.execPath);
    if (process.platform !== "win32") {
      expect(commands).toHaveLength(3);
      expect(commands[2]).toEqual({ file: "wrangler", args: [] });
    }
  });
});

describe("redaction", () => {
  test("the credentials never print the token", async () => {
    const creds = await resolveCredentials(options({ configAccountId: ACCOUNT }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    console.log(creds);
    console.log("%s %o %j", creds.token, creds, creds);
    const printed = log.mock.calls.map((args) => args.map((a) => inspect(a)).join(" ")).join("\n");
    log.mockRestore();

    for (const text of [
      printed,
      JSON.stringify(creds),
      inspect(creds, { depth: 10, showHidden: true }),
      String(creds.token),
      `${creds.token}`,
      creds.token.toString(),
      JSON.stringify({ nested: { token: creds.token } }),
    ]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(JSON.stringify(creds)).toContain("[redacted]");
  });

  test("no error path carries the token", async () => {
    const results: RunResult[] = [
      { code: 0, stdout: `token: ${TOKEN}`, stderr: "" },
      ok({ type: "api_key", key: TOKEN, email: "x" }),
      { code: 2, stdout: TOKEN, stderr: TOKEN },
    ];
    for (const result of results) {
      const err = (await resolveCredentials(options({ run: async () => result })).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(`${err.message}\n${err.stack}\n${inspect(err)}`).not.toContain(TOKEN);
    }
    for (const name of ["error-auth", "error-unauthenticated", "error-sql"]) {
      const err = (await resolveCredentials(
        options({ env: { CLOUDFLARE_API_TOKEN: TOKEN }, fetch: sequence(fixture(name)).fetch }),
      ).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(UserError);
      expect(`${err.message}\n${err.stack}\n${inspect(err)}`).not.toContain(TOKEN);
    }
  });

  test("Secret reveals only through reveal()", () => {
    const s = new Secret(TOKEN);
    expect(s.reveal()).toBe(TOKEN);
    expect(inspect({ s })).toBe("{ s: [redacted] }");
    expect(Object.keys(s)).toEqual([]);
  });
});
