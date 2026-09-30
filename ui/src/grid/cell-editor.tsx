import type { CellValue } from "@shared/edits";
import { BanIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type InputKind, parseInput } from "@/edits/values";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);

export type CommitKey = "enter" | "tab" | "blur";
export type CancelReason = CommitKey | "escape";

/**
 * The in-cell editor (T6): an `InputGroup` with a "Set NULL" button. Enter,
 * Tab and blur commit to staging, Esc cancels. A bad number sets
 * `aria-invalid` and blocks the commit. Uncontrolled, so a number input's
 * half-typed `1e` isn't clobbered.
 */
export function CellEditor(props: {
  label: string;
  kind: InputKind;
  /** The cell's text when editing starts, or the character that started it. */
  initial: string;
  /** Typing started it: the text counts as an edit even if it ends up equal. */
  seeded: boolean;
  onCommit: (value: CellValue, key: CommitKey) => void;
  onCancel: (reason: CancelReason) => void;
}) {
  const { kind, onCommit, onCancel } = props;
  const input = useRef<HTMLInputElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const touched = useRef(props.seeded);
  const done = useRef(false);
  const [invalid, setInvalid] = useState<string | null>(null);

  const latest = useRef({ onCommit, onCancel, initial: props.initial });
  latest.current = { onCommit, onCancel, initial: props.initial };

  /** Commits what is typed; false if it isn't valid. Untouched text is no edit. */
  const finish = (key: CommitKey): boolean => {
    const el = input.current;
    if (done.current || !el) return true;
    const text = el.value;
    if (!touched.current && text === latest.current.initial) {
      done.current = true;
      latest.current.onCancel(key);
      return true;
    }
    const parsed = el.validity.badInput
      ? ({ ok: false, message: "Enter a number." } as const)
      : parseInput(kind, text);
    if (!parsed.ok) {
      setInvalid(parsed.message);
      return false;
    }
    done.current = true;
    latest.current.onCommit(parsed.value, key);
    return true;
  };

  const setNull = () => {
    if (done.current) return;
    done.current = true;
    latest.current.onCommit(null, "enter");
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on mount and unmount only.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Typing started the edit: the caret goes after that character. Otherwise the
    // text is selected, so typing replaces it. (Number inputs have no caret to set.)
    if (!props.seeded) el.select();
    else if (kind === "text") el.setSelectionRange(el.value.length, el.value.length);
    return () => {
      // Scrolled out of view or the row went away: keep what was typed.
      if (!done.current && input.current) finish("blur");
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      done.current = true;
      onCancel("escape");
    } else if (event.key === "Enter") {
      event.preventDefault();
      finish("enter");
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      finish("tab");
    } else if (
      (event.key === "n" || event.key === "N") &&
      event.shiftKey &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      setNull();
    }
  };

  return (
    <InputGroup
      ref={group}
      data-editor=""
      className="h-full rounded-none border-0 bg-background ring-2 ring-ring ring-inset has-[[data-slot][aria-invalid=true]]:bg-destructive/10 has-[[data-slot][aria-invalid=true]]:ring-2 has-[[data-slot][aria-invalid=true]]:ring-destructive has-[[data-slot=input-group-control]:focus-visible]:ring-2"
      onBlur={(event) => {
        // Moving to "Set NULL" or its tooltip isn't leaving the editor.
        if (group.current?.contains(event.relatedTarget as Node | null)) return;
        if (!finish("blur")) input.current?.focus();
      }}
    >
      <InputGroupInput
        ref={input}
        type={kind}
        // A number input's own spinner arrows and step would only get in the way.
        step={kind === "number" ? "any" : undefined}
        defaultValue={props.initial}
        aria-label={props.label}
        aria-invalid={invalid !== null || undefined}
        title={invalid ?? undefined}
        autoComplete="off"
        spellCheck={false}
        className="h-full px-2 font-mono text-[13px] md:text-[13px]"
        onInput={() => {
          touched.current = true;
          if (invalid !== null) setInvalid(null);
        }}
        onKeyDown={onKeyDown}
      />
      <InputGroupAddon align="inline-end" className="py-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Set NULL"
                onMouseDown={(event) => event.preventDefault()}
                onClick={setNull}
              />
            }
          >
            <BanIcon />
          </TooltipTrigger>
          <TooltipContent>
            Set NULL{" "}
            <KbdGroup>
              <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>N</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </InputGroupAddon>
    </InputGroup>
  );
}
