import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { findConfig } from "../config/find";
import { parseConfig } from "../config/parse";
import { pickBinding, selectBindings } from "../config/select";
import { LocalDriver } from "../drivers/local";
import type { Driver } from "../drivers/types";
import { UserError } from "../errors";
import {
  assertSqliteFile,
  d1StateDir,
  resolveLocalTarget,
  resolvePersistDir,
} from "../local/locate";
import { displayPath } from "../paths";
import { createApp } from "../server/app";
import { type AppContext, type DatabaseMeta, readySession, type Session } from "../server/context";
import { createToken, isLoopback } from "../server/security";
import { WRANGLER_DEV_WRITES } from "../shared/notices";
import { type CliOptions, parseCli, renderHelp } from "./args";
import { type BannerInfo, formatBanner, formatDatabase, formatHostWarning } from "./banner";
import { openBrowser } from "./browser";
import { listen, resolvePort } from "./port";

/** ui/vite.config.ts */
const VITE_PORT = 5173;

interface Opened {
  session: Session;
  database: string;
  source?: BannerInfo["source"];
  openCandidate?: AppContext["openCandidate"];
  drivers: Driver[];
}

/** Runs the CLI. Resolves once the server is listening (or on --help/--version). */
export async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed.kind === "help") {
    console.log(await renderHelp());
    return;
  }
  if (parsed.kind === "version") {
    console.log(__VERSION__);
    return;
  }
  const options = parsed.options;
  const { port, strict } = resolvePort({ flag: options.port, env: process.env.D1_STUDIO_PORT });
  if (options.mode === "remote") {
    throw new UserError("Remote mode isn't available in this build yet.");
  }

  const readOnly = !options.write;
  const opened = await openLocal(options, readOnly);
  // `pnpm dev`: the UI is served by Vite, which proxies /api here.
  const dev = process.env.D1_STUDIO_DEV === "1";
  const ctx: AppContext = {
    version: __VERSION__,
    mode: "local",
    readOnly,
    token: createToken(),
    bind: { host: options.host, port },
    uiDir: fileURLToPath(new URL("./ui/", import.meta.url)),
    devHosts: dev ? [`localhost:${VITE_PORT}`, `127.0.0.1:${VITE_PORT}`] : undefined,
    session: opened.session,
    notices: readOnly ? [] : [WRANGLER_DEV_WRITES],
    openCandidate: opened.openCandidate,
  };

  let server: Awaited<ReturnType<typeof listen>>["server"];
  try {
    const listening = await listen(createApp(ctx), options.host, port, strict);
    server = listening.server;
    ctx.bind.port = listening.port;
  } catch (err) {
    await Promise.all(opened.drivers.map((d) => d.close()));
    throw err;
  }

  const urlHost = ["0.0.0.0", "::"].includes(options.host) ? "127.0.0.1" : options.host;
  const hostPart = urlHost.includes(":") && !urlHost.startsWith("[") ? `[${urlHost}]` : urlHost;
  const url = `http://${hostPart}:${ctx.bind.port}/?t=${ctx.token}`;
  console.log(
    formatBanner({
      version: __VERSION__,
      mode: "local",
      readOnly,
      database: opened.database,
      source: opened.source,
      url,
      devUrl: dev ? `http://localhost:${VITE_PORT}/?t=${ctx.token}` : undefined,
      busyPort: port !== 0 && ctx.bind.port !== port ? port : undefined,
      notes: readOnly
        ? []
        : ["writes here can make concurrent `wrangler dev` writes fail (SQLITE_BUSY)"],
    }),
  );
  if (!isLoopback(options.host)) console.log(`\n${formatHostWarning(options.host, readOnly)}`);
  if (isDebug()) console.error(`[d1-studio] ready in ${performance.now().toFixed(0)} ms`);

  if (options.open) {
    openBrowser(url, () => console.error("Couldn't open a browser. Open the studio link above."));
  }

  const shutdown = () => {
    server.close();
    server.closeAllConnections();
    Promise.all(opened.drivers.map((d) => d.close())).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function openLocal(options: CliOptions, readOnly: boolean): Promise<Opened> {
  const cwd = process.cwd();

  if (options.path !== undefined) {
    const file = path.resolve(cwd, options.path);
    assertSqliteFile(file);
    const driver = await LocalDriver.open(file, { readOnly });
    const name = path.basename(file);
    return {
      session: readySession(driver, { name, binding: null, id: null }),
      database: name,
      source: { label: "file", value: displayPath(file, cwd) },
      drivers: [driver],
    };
  }

  const found = findConfig(cwd, options.config);
  if (!found) {
    throw new UserError(
      "No wrangler.json, wrangler.jsonc or wrangler.toml found here or in any parent directory.\n" +
        "Run d1-studio inside a Wrangler project, or pass a SQLite file: d1-studio --local ./data.sqlite",
    );
  }
  const config = parseConfig(found.path);
  const where = `${displayPath(config.path, cwd)}${options.env ? ` [env.${options.env}]` : ""}`;
  const binding = await pickBinding(selectBindings(config, options.env), options.db, {
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    source: where,
  });
  const persistDir = resolvePersistDir({
    cwd,
    persistTo: options.persistTo,
    userConfigPath: found.userConfigPath,
  });
  const target = await resolveLocalTarget(binding, d1StateDir(persistDir));

  const id = binding.previewDatabaseId ?? binding.databaseId;
  const database: DatabaseMeta = {
    name: binding.databaseName ?? binding.binding,
    binding: binding.binding,
    id: id ?? null,
  };
  const source: BannerInfo["source"] = {
    label: "config",
    value: `${displayPath(found.path, cwd)}${found.redirected ? " (redirected)" : ""}`,
  };
  const label = formatDatabase(database.name, binding.binding, id);

  if (target.kind === "file") {
    const driver = await LocalDriver.open(target.path, { readOnly });
    return { session: readySession(driver, database), database: label, source, drivers: [driver] };
  }

  const drivers: Driver[] = [];
  return {
    session: { state: "needs-db", candidates: target.candidates, unmatched: database },
    database: `${label}: no file matched; pick one of ${target.candidates.length} in the studio`,
    source,
    drivers,
    openCandidate: async (candidate) => {
      const driver = await LocalDriver.open(candidate.path, { readOnly });
      drivers.push(driver);
      return { driver, database };
    },
  };
}

function isDebug(): boolean {
  return (process.env.DEBUG ?? "")
    .split(",")
    .some((s) => s.trim() === "d1-studio" || s.trim() === "*");
}
