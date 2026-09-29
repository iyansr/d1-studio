import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "dist", "cli.js");

interface Options {
  /** Fixture project under e2e/fixtures. */
  project: string;
  cliArgs: string[];
}

/** Starts `node dist/cli.js --no-open --port 0` and reads the token URL from stdout. */
async function startStudio(
  project: string,
  args: string[],
): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [cli, "--no-open", "--port", "0", ...args], {
    cwd: path.join(root, "e2e", "fixtures", project),
    env: { ...process.env, NO_COLOR: "1" },
  });
  let out = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    out += d;
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI didn't start:\n${out}`)), 15_000);
    child.stdout?.on("data", () => {
      const match = /studio\s+(http:\/\/\S+)/.exec(out);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => reject(new Error(`CLI exited ${code}:\n${out}`)));
  });
  return { child, url };
}

export const test = base.extend<Options & { studioUrl: string }>({
  project: ["project", { option: true }],
  cliArgs: [["--no-write"], { option: true }],
  studioUrl: async ({ project, cliArgs }, use) => {
    const { child, url } = await startStudio(project, cliArgs);
    await use(url);
    child.kill();
  },
  // Every test opens the studio through the token link and fails on any
  // browser console error (this catches CSP violations too).
  page: async ({ page, studioUrl }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(studioUrl);
    await use(page);
    expect(errors, "browser console errors").toEqual([]);
  },
});

export { expect };

/** Goes to a studio URL (the session cookie is already set). */
export async function open(page: Page, search: string) {
  const url = new URL(page.url());
  await page.goto(`${url.origin}/${search}`);
}

export const footer = (page: Page) => page.locator("footer");
export const grid = (page: Page, name: string) => page.getByRole("grid", { name });
