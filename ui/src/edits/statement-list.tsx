import type { PreviewStatement } from "@shared/edits";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { CodeView } from "@/editor/code-view";
import { groupStatements } from "./statements";

/** Every statement of a write, highlighted and read-only, destructive ones badged. */
export function StatementList({ statements }: { statements: readonly PreviewStatement[] }) {
  const blocks = useMemo(() => groupStatements(statements), [statements]);
  return (
    <ol className="flex flex-col gap-3" aria-label="Statements">
      {blocks.map((block) => {
        const label =
          block.kind === "statement"
            ? `${block.number}`
            : block.from === block.to
              ? `${block.from}`
              : `${block.from}–${block.to}`;
        return (
          <li key={label} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              <span>{label}</span>
              {block.kind === "statement" && block.dangerous && (
                <Badge variant="destructive">destructive</Badge>
              )}
            </div>
            <CodeView
              value={block.text}
              language="sql"
              label={`Statement ${label}`}
              lineNumbers={false}
            />
          </li>
        );
      })}
    </ol>
  );
}
