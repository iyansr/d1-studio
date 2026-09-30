import type { Cell } from "@shared/values";
import { CopyIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CodeEditor, type CodeEditorHandle } from "@/editor/code-editor";
import { CodeView } from "@/editor/code-view";
import { formatJson, jsonProblem } from "@/edits/values";
import { expandedText } from "./cells";

export interface ExpandedCell {
  column: string;
  type: string;
  /** 1-based row number across pages, or a row that isn't saved yet. */
  row: number | "new";
  value: Cell;
  /** Where the cell is in the grid; the grid stages an edit back to it. */
  at: { row: number; col: number };
  /** Editing is on, and this cell can be written. */
  editable: boolean;
}

/**
 * Long text and JSON (UI-6). Read-only, or editable when the grid allows it:
 * CodeMirror in JSON mode when the value parses, with invalid JSON blocking
 * "Stage change".
 */
export function CellSheet(props: {
  cell: ExpandedCell | null;
  onClose: () => void;
  onCopy: (value: Cell) => void;
  /** Stages the edited text on the cell. */
  onStage?: (cell: ExpandedCell, text: string) => void;
}) {
  const { cell } = props;
  return (
    <Sheet open={cell !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        {cell && (
          <SheetBody
            key={`${cell.at.row}:${cell.at.col}`}
            cell={cell}
            onClose={props.onClose}
            onCopy={props.onCopy}
            onStage={props.onStage}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody(props: {
  cell: ExpandedCell;
  onClose: () => void;
  onCopy: (value: Cell) => void;
  onStage?: (cell: ExpandedCell, text: string) => void;
}) {
  const { cell } = props;
  const shown = expandedText(cell.value);
  const editable = cell.editable && props.onStage !== undefined;
  const [text, setText] = useState(shown.text);
  const editor = useRef<CodeEditorHandle | null>(null);
  const json = shown.language === "json";
  const problem = editable && json ? jsonProblem(text) : null;
  const changed = text !== shown.text;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-mono">{cell.column}</SheetTitle>
        <SheetDescription>
          {cell.row === "new" ? "New row" : `Row ${cell.row}`}
          {cell.type ? ` · ${cell.type}` : ""}
          {json ? " · JSON, pretty-printed" : ""}
        </SheetDescription>
      </SheetHeader>
      {editable ? (
        <CodeEditor
          initialValue={shown.text}
          language={shown.language}
          label={`${cell.column} value`}
          onChange={setText}
          handleRef={editor}
          className="mx-4 flex-1"
        />
      ) : (
        <CodeView
          value={shown.text}
          language={shown.language}
          label={`${cell.column} value`}
          lineNumbers={json}
          className="mx-4 flex-1"
        />
      )}
      {problem !== null && (
        <Alert variant="destructive" className="mx-4 mt-3 w-auto">
          <AlertTitle>Invalid JSON</AlertTitle>
          <AlertDescription className="font-mono">{problem}</AlertDescription>
        </Alert>
      )}
      <SheetFooter>
        {editable ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={!json || problem !== null}
              onClick={() => editor.current?.replace(formatJson(text))}
            >
              Format
            </Button>
            <Button variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={!changed || problem !== null}
              onClick={() => {
                props.onStage?.(cell, text);
                props.onClose();
              }}
            >
              Stage change
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => props.onCopy(cell.value)}>
            <CopyIcon data-icon="inline-start" />
            Copy value
          </Button>
        )}
      </SheetFooter>
    </>
  );
}
