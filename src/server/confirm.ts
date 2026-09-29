import type { Confirm, ConfirmLevel, PreviewStatement, WritePreview } from "../shared/edits";
import { classify } from "../sql/classify";

/** Where a write comes from. The SQL editor's user wrote the SQL themselves. */
export type WriteSource = "grid" | "editor";

export interface WriteRequest {
  mode: "local" | "remote";
  readOnly: boolean;
  dangerous: boolean;
  source: WriteSource;
  /** What the request carried, if anything. */
  confirm?: Confirm;
  databaseName: string;
}

/**
 * What a write needs before it runs (D12). Local mode never asks. Remote
 * write mode asks for a click on grid edits, and for the typed database
 * name on destructive SQL from anywhere. The server enforces this, not only
 * the UI.
 */
export function confirmationLevel(
  req: Pick<WriteRequest, "mode" | "dangerous" | "source">,
): ConfirmLevel {
  if (req.mode === "local") return "none";
  if (req.dangerous) return "type-name";
  return req.source === "grid" ? "click" : "none";
}

export type WriteDecision =
  | { action: "run" }
  /** Read-only mode: 403. */
  | { action: "refuse" }
  /** Nothing (or too little) was confirmed: 409, with the level needed. */
  | { action: "confirm"; level: "click" | "type-name" }
  /** The typed name is wrong: 403. */
  | { action: "mismatch" };

export function decideWrite(req: WriteRequest): WriteDecision {
  if (req.readOnly) return { action: "refuse" };
  const level = confirmationLevel(req);
  if (level === "none") return { action: "run" };
  if (req.confirm === undefined) return { action: "confirm", level };
  if (level === "type-name" && req.confirm !== req.databaseName) return { action: "mismatch" };
  return { action: "run" };
}

/** The statements as they will run, each classified, and what confirming them takes. */
export function writePreview(
  statements: { sql: string; params?: PreviewStatement["params"] }[],
  req: Pick<WriteRequest, "mode" | "source">,
): WritePreview {
  const listed = statements.map((s) => ({
    sql: s.sql,
    params: s.params ?? [],
    dangerous: classify(s.sql).dangerous,
  }));
  const dangerous = listed.some((s) => s.dangerous);
  return {
    statements: listed,
    dangerous,
    requiresConfirm: confirmationLevel({ ...req, dangerous }),
  };
}
