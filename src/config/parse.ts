import { readFileSync } from "node:fs";
import path from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml, TomlError } from "smol-toml";
import { UserError } from "../errors";
import { displayPath } from "../paths";

export interface D1Binding {
  binding: string;
  databaseName?: string;
  databaseId?: string;
  previewDatabaseId?: string;
}

export interface WranglerConfig {
  path: string;
  dir: string;
  accountId?: string;
  d1: D1Binding[];
  envs: Record<string, { d1: D1Binding[] }>;
}

export function parseConfig(file: string): WranglerConfig {
  const text = readFileSync(file, "utf8");
  const raw = file.endsWith(".toml") ? readToml(file, text) : readJsonc(file, text);
  if (!isRecord(raw)) {
    throw new UserError(`${displayPath(file)}: expected an object at the top level.`);
  }

  const envs: WranglerConfig["envs"] = {};
  if (isRecord(raw.env)) {
    for (const [name, env] of Object.entries(raw.env)) {
      if (isRecord(env)) envs[name] = { d1: readBindings(file, env.d1_databases, `env.${name}.`) };
    }
  }
  return {
    path: file,
    dir: path.dirname(file),
    accountId: typeof raw.account_id === "string" ? raw.account_id : undefined,
    d1: readBindings(file, raw.d1_databases, ""),
    envs,
  };
}

function readBindings(file: string, value: unknown, prefix: string): D1Binding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new UserError(`${displayPath(file)}: ${prefix}d1_databases must be an array.`);
  }
  return value.map((entry, i) => {
    if (!isRecord(entry) || typeof entry.binding !== "string" || entry.binding === "") {
      throw new UserError(`${displayPath(file)}: ${prefix}d1_databases[${i}] has no "binding".`);
    }
    const str = (key: string) => (typeof entry[key] === "string" ? entry[key] : undefined);
    return {
      binding: entry.binding,
      databaseName: str("database_name"),
      databaseId: str("database_id"),
      previewDatabaseId: str("preview_database_id"),
    };
  });
}

function readJsonc(file: string, text: string): unknown {
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first) {
    const { line, column } = lineColumn(text, first.offset);
    throw new UserError(
      `Failed to parse ${displayPath(file)}:${line}:${column}: ${printParseErrorCode(first.error)}`,
    );
  }
  return data;
}

function readToml(file: string, text: string): unknown {
  try {
    return parseToml(text);
  } catch (err) {
    if (err instanceof TomlError) {
      const reason = err.message.split("\n")[0];
      throw new UserError(
        `Failed to parse ${displayPath(file)}:${err.line}:${err.column}: ${reason}`,
      );
    }
    throw err;
  }
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
