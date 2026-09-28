import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * CodeMirror styled from the shadcn tokens, so it follows light/dark and the
 * remote accent (which re-points --ring) without its own dark theme.
 */
export const shadcnTheme = [
  EditorView.theme({
    "&": {
      color: "var(--foreground)",
      backgroundColor: "var(--background)",
      fontSize: "13px",
      height: "100%",
    },
    "&.cm-focused": {
      outline: "3px solid color-mix(in oklch, var(--ring) 50%, transparent)",
      outlineOffset: "-3px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontVariantLigatures: "none",
      lineHeight: "1.55",
    },
    ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    ".cm-gutters": {
      backgroundColor: "var(--background)",
      color: "var(--muted-foreground)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 50%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "color-mix(in oklch, var(--ring) 35%, transparent)" },
    ".cm-matchingBracket": {
      backgroundColor: "color-mix(in oklch, var(--ring) 25%, transparent)",
      outline: "1px solid var(--border)",
    },
    ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--ring) 30%, transparent)" },
    ".cm-searchMatch-selected": {
      backgroundColor: "color-mix(in oklch, var(--ring) 55%, transparent)",
    },
    ".cm-panels": {
      backgroundColor: "var(--muted)",
      color: "var(--foreground)",
      borderColor: "var(--border)",
    },
    ".cm-panels input, .cm-panels button": { fontSize: "12px" },
    ".cm-textfield": {
      backgroundColor: "var(--background)",
      border: "1px solid var(--input)",
      borderRadius: "calc(var(--radius) * 0.6)",
      color: "var(--foreground)",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--background)",
      border: "1px solid var(--border)",
      borderRadius: "calc(var(--radius) * 0.6)",
      color: "var(--foreground)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "calc(var(--radius) * 0.8)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--accent)",
      color: "var(--accent-foreground)",
    },
    ".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal" },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--code-keyword)" },
      { tag: [tags.string, tags.special(tags.string)], color: "var(--code-string)" },
      { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
      {
        tag: [tags.comment, tags.lineComment, tags.blockComment],
        color: "var(--code-comment)",
        fontStyle: "italic",
      },
      { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--code-keyword)" },
      { tag: [tags.propertyName, tags.special(tags.name)], color: "var(--foreground)" },
      { tag: tags.invalid, color: "var(--destructive)" },
    ]),
  ),
];
