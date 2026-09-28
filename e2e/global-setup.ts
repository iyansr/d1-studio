import { existsSync } from "node:fs";
import path from "node:path";
import { makeE2eFixtures } from "./fixtures/make";

export default function setup() {
  const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("dist/cli.js is missing; run `pnpm build` first.");
  makeE2eFixtures();
}
