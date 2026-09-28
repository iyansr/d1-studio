import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { UsageError } from "../../src/cli/args";
import { listen, resolvePort } from "../../src/cli/port";

describe("resolvePort", () => {
  test("--port beats D1_STUDIO_PORT beats the default", () => {
    expect(resolvePort({ flag: "5555", env: "8080", fallback: 4101 })).toEqual({
      port: 5555,
      strict: true,
    });
    expect(resolvePort({ env: "8080", fallback: 4101 })).toEqual({ port: 8080, strict: false });
    expect(resolvePort({ fallback: 4101 })).toEqual({ port: 4101, strict: false });
    expect(resolvePort({ env: "" })).toEqual({ port: 4101, strict: false });
  });

  test.each(["0", "65536", "-1", "abc", "12.5", "0x10", "1e3", ""])("rejects --port %j", (flag) => {
    expect(() => resolvePort({ flag })).toThrow(UsageError);
  });

  test("names the env var in errors", () => {
    expect(() => resolvePort({ env: "nope" })).toThrow(/D1_STUDIO_PORT must be an integer/);
  });

  test("accepts the range bounds", () => {
    expect(resolvePort({ flag: "1" }).port).toBe(1);
    expect(resolvePort({ flag: "65535" }).port).toBe(65535);
  });
});

describe("listen", () => {
  const app = { fetch: () => new Response("ok") };
  const servers: { close: (cb: () => void) => unknown }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  const occupy = async (): Promise<number> => {
    const dummy: Server = createServer();
    servers.push(dummy);
    await new Promise<void>((r) => dummy.listen(0, "127.0.0.1", r));
    const address = dummy.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return address.port;
  };

  test("binds the requested port when free", async () => {
    const busy = await occupy();
    const free = busy + 1;
    // Not guaranteed free, but the fallback path is covered below either way.
    const { server, port } = await listen(app, "127.0.0.1", free, false);
    servers.push(server);
    expect(port).toBeGreaterThanOrEqual(free);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("ok");
  });

  test("falls back to a later port when the port is busy", async () => {
    const busy = await occupy();
    const { server, port } = await listen(app, "127.0.0.1", busy, false);
    servers.push(server);
    expect(port).toBeGreaterThan(busy);
    expect(port).toBeLessThanOrEqual(busy + 10);
  });

  test("strict mode fails on a busy port", async () => {
    const busy = await occupy();
    await expect(listen(app, "127.0.0.1", busy, true)).rejects.toThrow(
      new UsageError(`Port ${busy} is in use. Choose another with \`--port\`.`),
    );
  });
});
