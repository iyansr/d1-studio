import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { type RefObject, useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import { shadcnTheme } from './theme';

export interface CodeEditorHandle {
  /** Replaces the whole document (Format). */
  replace: (text: string) => void;
}

/**
 * An editable CodeMirror for a cell's text or JSON (UI-6). Tab is left to move
 * focus, so keyboard users aren't trapped.
 */
export function CodeEditor(props: {
  initialValue: string;
  language: 'json' | 'text';
  label: string;
  onChange: (value: string) => void;
  handleRef?: RefObject<CodeEditorHandle | null>;
  className?: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  /* oxlint-disable react-hooks/exhaustive-deps -- the editor is created once per mount. */
  useEffect(() => {
    if (!parent.current) return;
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: props.initialValue,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          props.language === 'json' ? json() : [],
          EditorView.contentAttributes.of({ 'aria-label': props.label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          shadcnTheme,
        ],
      }),
    });
    if (props.handleRef) {
      props.handleRef.current = {
        replace: (text) =>
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
      };
    }
    view.focus();
    return () => view.destroy();
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */

  return (
    <div
      ref={parent}
      className={cn('min-h-0 overflow-hidden rounded-md border', props.className)}
    />
  );
}
