import { UserError } from "../errors";
import { displayPath } from "../paths";
import type { D1Binding, WranglerConfig } from "./parse";

/**
 * The bindings for `env`, or the top-level ones without it. Wrangler doesn't
 * inherit `d1_databases` into environments, so neither do we.
 */
export function selectBindings(cfg: WranglerConfig, env?: string): D1Binding[] {
  if (env === undefined) {
    const withD1 = Object.keys(cfg.envs).filter((name) => cfg.envs[name]?.d1.length);
    if (cfg.d1.length === 0 && withD1.length > 0) {
      throw new UserError(
        `No top-level d1_databases in ${displayPath(cfg.path)}. ` +
          `These environments have D1: ${withD1.join(", ")}. Pass --env <name>.`,
      );
    }
    return cfg.d1;
  }
  const found = cfg.envs[env];
  if (!found) {
    const names = Object.keys(cfg.envs);
    const available = names.length > 0 ? `Available: ${names.join(", ")}.` : "It defines none.";
    throw new UserError(`Unknown environment "${env}" in ${displayPath(cfg.path)}. ${available}`);
  }
  return found.d1;
}

export type SelectPrompt = (bindings: D1Binding[]) => Promise<D1Binding>;

export async function pickBinding(
  bindings: D1Binding[],
  db: string | undefined,
  options: { tty: boolean; prompt?: SelectPrompt; source?: string },
): Promise<D1Binding> {
  const where = options.source ? ` in ${options.source}` : "";
  if (bindings.length === 0) {
    throw new UserError(`No d1_databases${where}.`);
  }
  if (db !== undefined) {
    const match =
      bindings.find((b) => b.binding === db) ?? bindings.find((b) => b.databaseName === db);
    if (!match) {
      throw new UserError(
        `No D1 binding or database named "${db}"${where}. Available: ${bindings.map(label).join(", ")}.`,
      );
    }
    return match;
  }
  const [only] = bindings;
  if (only && bindings.length === 1) return only;
  if (!options.tty) {
    throw new UserError(
      `Multiple D1 databases: ${bindings.map((b) => b.binding).join(", ")}. Pass --db <name>.`,
    );
  }
  return (options.prompt ?? clackPrompt)(bindings);
}

function label(b: D1Binding): string {
  return b.databaseName && b.databaseName !== b.binding
    ? `${b.binding} (${b.databaseName})`
    : b.binding;
}

const clackPrompt: SelectPrompt = async (bindings) => {
  const { isCancel, select } = await import("@clack/prompts");
  const choice = await select({
    message: "Which D1 database?",
    options: bindings.map((b, i) => ({ value: i, label: label(b), hint: b.databaseId })),
  });
  if (isCancel(choice)) throw new UserError("Cancelled.");
  const picked = bindings[choice];
  if (!picked) throw new UserError("Cancelled.");
  return picked;
};
