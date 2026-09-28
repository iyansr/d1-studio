import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { SQLite, type SQLNamespace, sql } from "@codemirror/lang-sql";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { type RefObject, useEffect, useRef } from "react";
import type { SchemaTable } from "@/lib/api";
import { shadcnTheme } from "./theme";

export interface SqlEditorHandle {
  /** The selection if there is one, otherwise the whole document. */
  runnable: () => string;
  focus: () => void;
}

/** Table → column completions for lang-sql. */
export function sqlNamespace(tables: SchemaTable[]): SQLNamespace {
  return Object.fromEntries(
    tables.map((t) => [
      t.name,
      t.columns.map((c) => ({ label: c.name, type: "property", detail: c.type || undefined })),
    ]),
  );
}

/**
 * CodeMirror 6 with SQLite highlighting, schema autocomplete and search
 * (UI-7). Mod-Enter runs; Tab is left to move focus, so keyboard users
 * aren't trapped.
 */
export function SqlEditor(props: {
  initialValue: string;
  schema: SQLNamespace;
  onChange: (value: string) => void;
  onRun: (sql: string) => void;
  handleRef: RefObject<SqlEditorHandle | null>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // Keymaps and listeners read the latest callbacks through refs.
  const latest = useRef(props);
  latest.current = props;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once.
  useEffect(() => {
    if (!parent.current) return;
    const runnable = (state: EditorState) => {
      const { from, to } = state.selection.main;
      return from === to ? state.doc.toString() : state.sliceDoc(from, to);
    };
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: props.initialValue,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: (v) => {
                  latest.current.onRun(runnable(v.state));
                  return true;
                },
              },
            ]),
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
          ]),
          language.current.of(
            sql({ dialect: SQLite, schema: props.schema, upperCaseKeywords: true }),
          ),
          placeholder("SELECT * FROM …"),
          EditorView.contentAttributes.of({ "aria-label": "SQL editor" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          shadcnTheme,
        ],
      }),
    });
    view.current = editor;
    props.handleRef.current = {
      runnable: () => runnable(editor.state),
      focus: () => editor.focus(),
    };
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // Autocomplete follows the schema (it changes after DDL).
  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(
        sql({ dialect: SQLite, schema: props.schema, upperCaseKeywords: true }),
      ),
    });
  }, [props.schema]);

  return <div ref={parent} className="h-full min-h-0 overflow-hidden" />;
}
