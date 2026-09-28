import { json } from "@codemirror/lang-json";
import { SQLite, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { shadcnTheme } from "./theme";

const LANGUAGES = {
  sql: () => sql({ dialect: SQLite }),
  json: () => json(),
  text: () => [],
};

/** Read-only, selectable code (DDL, JSON and long text). */
export function CodeView(props: {
  value: string;
  language: keyof typeof LANGUAGES;
  label: string;
  className?: string;
  lineNumbers?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { value, language, label } = props;
  const numbers = props.lineNumbers ?? true;

  useEffect(() => {
    if (!ref.current) return;
    const view = new EditorView({
      parent: ref.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label }),
          numbers ? lineNumbers() : [],
          LANGUAGES[language](),
          shadcnTheme,
        ],
      }),
    });
    return () => view.destroy();
  }, [value, language, label, numbers]);

  return (
    <div ref={ref} className={cn("min-h-0 overflow-hidden rounded-md border", props.className)} />
  );
}
