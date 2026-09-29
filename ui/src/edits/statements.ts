import type { PreviewStatement } from "@shared/edits";
import { inlineParams } from "@/lib/inline-sql";

/** What the dialog and the SQL sheet render: one statement, or a run of safe ones. */
export type Block =
  | { kind: "statement"; number: number; dangerous: boolean; text: string }
  | { kind: "run"; from: number; to: number; text: string };

/** Above this many statements, safe ones are shown together to keep the page light. */
const INDIVIDUAL_LIMIT = 40;

const show = (s: PreviewStatement): string => `${inlineParams(s.sql, s.params)};`;

/**
 * Lists every statement, params inlined. A long list merges consecutive safe
 * statements into one block; a destructive one always stands alone.
 */
export function groupStatements(statements: readonly PreviewStatement[]): Block[] {
  const blocks: Block[] = [];
  const merge = statements.length > INDIVIDUAL_LIMIT;
  statements.forEach((s, i) => {
    const number = i + 1;
    const last = blocks.at(-1);
    if (merge && !s.dangerous) {
      if (last?.kind === "run" && last.to === number - 1) {
        last.to = number;
        last.text += `\n${show(s)}`;
      } else {
        blocks.push({ kind: "run", from: number, to: number, text: show(s) });
      }
    } else {
      blocks.push({ kind: "statement", number, dangerous: s.dangerous, text: show(s) });
    }
  });
  return blocks;
}
