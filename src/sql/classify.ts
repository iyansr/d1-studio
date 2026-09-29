import { isKeyword, type Token, tokenize } from "./tokenize";

export type StatementKind =
  | "read"
  | "write"
  | "ddl"
  | "tx"
  | "pragma-read"
  | "pragma-write"
  | "other";

export interface Classification {
  kind: StatementKind;
  /** The deciding keyword, upper-case. For `WITH`, the statement after the CTEs. */
  keyword: string;
  /** `DROP`, `ALTER … DROP`, or top-level `UPDATE`/`DELETE` without `WHERE` (D12). */
  dangerous: boolean;
  /** A `WHERE` at the top level of the main statement. */
  hasWhere: boolean;
}

/** A statement that can't change the database (read-only mode, retries). */
export function isReadKind(kind: StatementKind): boolean {
  return kind === "read" || kind === "pragma-read";
}

const KINDS: Record<string, StatementKind> = {
  SELECT: "read",
  VALUES: "read",
  EXPLAIN: "read",
  INSERT: "write",
  REPLACE: "write",
  UPDATE: "write",
  DELETE: "write",
  CREATE: "ddl",
  DROP: "ddl",
  ALTER: "ddl",
  BEGIN: "tx",
  COMMIT: "tx",
  END: "tx",
  ROLLBACK: "tx",
  SAVEPOINT: "tx",
  RELEASE: "tx",
};

/** Pragmas that only read, even with a parenthesized argument (a table or schema name). */
const PRAGMA_READ_WITH_ARG = new Set([
  "collation_list",
  "compile_options",
  "database_list",
  "foreign_key_check",
  "foreign_key_list",
  "function_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "module_list",
  "pragma_list",
  "quick_check",
  "table_info",
  "table_list",
  "table_xinfo",
]);

/** Pragmas that read only when given no argument; `pragma x(1)` sets them. */
const PRAGMA_READ_NO_ARG = new Set([
  "application_id",
  "auto_vacuum",
  "busy_timeout",
  "cache_size",
  "data_version",
  "defer_foreign_keys",
  "encoding",
  "foreign_keys",
  "freelist_count",
  "journal_mode",
  "page_count",
  "page_size",
  "recursive_triggers",
  "schema_version",
  "user_version",
]);

const MAIN_AFTER_WITH = new Set(["SELECT", "VALUES", "INSERT", "REPLACE", "UPDATE", "DELETE"]);

export function classify(stmt: string | Token[]): Classification {
  const tokens = (typeof stmt === "string" ? tokenize(stmt) : stmt).filter(
    (t) => t.kind !== "comment",
  );
  const first = tokens[0];
  if (first?.kind !== "word") {
    return {
      kind: "other",
      keyword: first?.text.toUpperCase() ?? "",
      dangerous: false,
      hasWhere: false,
    };
  }

  let mainIndex = 0;
  let keyword = first.text.toUpperCase();
  if (keyword === "WITH") {
    mainIndex = skipCtes(tokens);
    const main = tokens[mainIndex];
    keyword = main?.kind === "word" ? main.text.toUpperCase() : "";
    if (!MAIN_AFTER_WITH.has(keyword)) {
      return { kind: "other", keyword, dangerous: false, hasWhere: false };
    }
  }

  const rest = tokens.slice(mainIndex + 1);
  const hasWhere = rest.some((t) => t.depth === 0 && isKeyword(t, "WHERE"));

  if (keyword === "PRAGMA") {
    return { kind: classifyPragma(rest), keyword, dangerous: false, hasWhere };
  }

  const kind = KINDS[keyword] ?? "other";
  const dangerous =
    keyword === "DROP" ||
    (keyword === "ALTER" && rest.some((t) => t.depth === 0 && isKeyword(t, "DROP"))) ||
    ((keyword === "UPDATE" || keyword === "DELETE") && !hasWhere);
  return { kind, keyword, dangerous, hasWhere };
}

/**
 * Index of the main statement keyword after `WITH [RECURSIVE] name [(cols)]
 * AS [[NOT] MATERIALIZED] (…) [, …]`.
 */
function skipCtes(tokens: Token[]): number {
  let i = 1;
  if (isKeyword(tokens[i], "RECURSIVE")) i++;
  for (;;) {
    i++; // CTE name
    if (tokens[i]?.text === "(") i = skipGroup(tokens, i);
    if (!isKeyword(tokens[i], "AS")) return i;
    i++;
    if (isKeyword(tokens[i], "NOT")) i++;
    if (isKeyword(tokens[i], "MATERIALIZED")) i++;
    if (tokens[i]?.text !== "(") return i;
    i = skipGroup(tokens, i);
    if (tokens[i]?.text !== ",") return i;
    i++;
  }
}

/** Index after the `)` matching the `(` at `open`. */
function skipGroup(tokens: Token[], open: number): number {
  const depth = tokens[open]?.depth ?? 0;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === "punct" && t.text === ")" && t.depth === depth) return i + 1;
  }
  return tokens.length;
}

/** `rest` starts after `PRAGMA`: `[schema.]name [= value | (arg)]`. */
function classifyPragma(rest: Token[]): StatementKind {
  let i = 0;
  if (rest[1]?.text === ".") i = 2;
  const nameToken = rest[i];
  if (!nameToken || (nameToken.kind !== "word" && nameToken.kind !== "ident")) {
    return "pragma-write";
  }
  const name = unquote(nameToken.text).toLowerCase();
  const after = rest.slice(i + 1);
  if (after.some((t) => t.text === "=")) return "pragma-write";
  if (after.length === 0) {
    return PRAGMA_READ_WITH_ARG.has(name) || PRAGMA_READ_NO_ARG.has(name)
      ? "pragma-read"
      : "pragma-write";
  }
  return PRAGMA_READ_WITH_ARG.has(name) ? "pragma-read" : "pragma-write";
}

function unquote(text: string): string {
  const q = text[0];
  if (q === '"' || q === "`") return text.slice(1, -1).replaceAll(q + q, q);
  if (q === "[") return text.slice(1, -1);
  return text;
}
