// `pnpm dev [project-dir] [cli flags…]`: rebuilds and restarts the CLI on
// change (tsup --watch) and runs Vite with an /api proxy to it. Open the
// `dev` link from the banner; the token handshake goes through the proxy.
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [dir = "test/fixtures/project-two-dbs", ...flags] = process.argv.slice(2);
if (process.argv.length <= 2) flags.push("--db", "DB");
const port = process.env.D1_STUDIO_PORT ?? "4101";
const env = { ...process.env, D1_STUDIO_DEV: "1", D1_STUDIO_PORT: port };
const shell = process.platform === "win32";

const cli = [
  `cd "${path.resolve(root, dir)}"`,
  `node "${path.join(root, "dist", "cli.js")}" --no-open --port ${port} ${flags.join(" ")}`,
].join(" && ");

const children = [
  spawn("pnpm", ["exec", "tsup", "--watch", "src", "--onSuccess", cli], {
    cwd: root,
    env,
    stdio: "inherit",
    shell,
  }),
  spawn("pnpm", ["--filter", "ui", "dev"], { cwd: root, env, stdio: "inherit", shell }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
