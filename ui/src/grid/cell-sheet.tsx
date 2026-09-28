import type { Cell } from "@shared/values";
import { CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CodeView } from "@/editor/code-view";
import { expandedText } from "./cells";

export interface ExpandedCell {
  column: string;
  type: string;
  /** 1-based row number across pages. */
  row: number;
  value: Cell;
}

/** Long text and JSON, read-only (UI-6). Plan 04 makes it editable. */
export function CellSheet(props: {
  cell: ExpandedCell | null;
  onClose: () => void;
  onCopy: (value: Cell) => void;
}) {
  const { cell } = props;
  const shown = cell ? expandedText(cell.value) : null;
  return (
    <Sheet open={cell !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{cell?.column}</SheetTitle>
          <SheetDescription>
            Row {cell?.row}
            {cell?.type ? ` · ${cell.type}` : ""}
            {shown?.language === "json" ? " · JSON, pretty-printed" : ""}
          </SheetDescription>
        </SheetHeader>
        {cell && shown && (
          <CodeView
            value={shown.text}
            language={shown.language}
            label={`${cell.column} value`}
            lineNumbers={shown.language === "json"}
            className="mx-4 flex-1"
          />
        )}
        <SheetFooter>
          <Button variant="outline" onClick={() => cell && props.onCopy(cell.value)}>
            <CopyIcon data-icon="inline-start" />
            Copy value
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
