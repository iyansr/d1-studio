import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { CellValue } from "@shared/edits";
import type { Filter, Sort } from "@shared/rows";
import type { Cell } from "@shared/values";
import {
  type ColumnSizingState,
  type ColumnVisibilityState,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeOffIcon,
  FilterIcon,
  KeyRoundIcon,
  LinkIcon,
  PencilIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RowRef, StagedEdits, StagedSnapshot } from "@/edits/staged-edits";
import { editText, inputKind } from "@/edits/values";
import { readStored, writeStored } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { type CancelReason, CellEditor, type CommitKey } from "./cell-editor";
import { CellSheet, type ExpandedCell } from "./cell-sheet";
import { affinity, blobLabel, cellKind, cellText, isExpandable, TOOLTIP_CHARS } from "./cells";

export interface GridColumn {
  name: string;
  type: string;
  /** 1-based position in the primary key, or 0. */
  pk?: number;
  fk?: { table: string; column: string | null };
}

/**
 * Editing (plan 04-T6). When given, the grid gets a select column, pinned
 * rows for staged inserts, and cell editing. Staged values live in `store`;
 * `staged` is its snapshot, so the owner re-renders the grid on every change.
 */
export interface GridEditing {
  store: StagedEdits;
  staged: StagedSnapshot;
  /** How the server finds a page row; `undefined` when it can't be edited. */
  identify: (row: Cell[]) => RowRef | undefined;
  /** Columns that can't be written (generated). */
  readonlyColumns: ReadonlySet<string>;
  /** Ids of the selected rows (existing or inserted). */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
}

export interface DataGridProps {
  /** Accessible name of the grid. */
  label: string;
  columns: GridColumn[];
  rows: Cell[][];
  /** Column names not shown (e.g. the rowid key). */
  hidden?: string[];
  /** Server-side sort. Without `onSortChange`, headers don't sort (static grid). */
  sort?: Sort[];
  onSortChange?: (sort: Sort[]) => void;
  onHideColumn?: (name: string) => void;
  /** "Filter…" in the header menu. */
  onFilterColumn?: (name: string) => void;
  /** "Filter by this value" / "Is NULL" in the cell menu. */
  onAddFilter?: (filter: Filter) => void;
  /** First load: skeleton rows instead of the (empty) body. */
  loading?: boolean;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
  /** Remembers column widths in localStorage under this key. */
  widthsKey?: string;
  editing?: GridEditing;
  /** Rows before this page, for aria-rowindex. */
  rowOffset?: number;
  /** All rows, when known, for aria-rowcount. */
  rowCount?: number;
  className?: string;
}

interface Meta {
  index: number;
  col: GridColumn;
  /** The leading checkbox column of an editable grid. */
  select?: boolean;
}

/** One row on screen: a staged insert (pinned first) or a row of the page. */
type DisplayRow =
  | { kind: "insert"; id: string; values: Readonly<Record<string, CellValue>> }
  | { kind: "data"; index: number; row: Cell[]; ref: RowRef | undefined };

const SELECT_ID = "__select";
const SELECT_WIDTH = 44;
const SELECT_COLUMN: GridColumn = { name: SELECT_ID, type: "" };

/** Row styling that says what is staged (semantic tokens from index.css). */
type RowState = "inserted" | "deleted" | "failed";

const features = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  columnResizingFeature,
  columnVisibilityFeature,
  columnMeta: {} as Meta,
});
const helper = createColumnHelper<typeof features, Cell[]>();

const ROW_HEIGHT = 33;
const HEADER_HEIGHT = 37;
/** Columns are virtualised above this many (plan 02-T5). */
const VIRTUAL_COLUMNS = 30;
const tooltipHandle = TooltipPrimitive.createHandle<string>();

function defaultWidth(col: GridColumn): number {
  const byType = { integer: 110, real: 120, numeric: 120, text: 220, blob: 150 }[
    affinity(col.type)
  ];
  // Name, type, key/link icons, the menu button and padding.
  const icons = (col.pk ? 20 : 0) + (col.fk ? 20 : 0);
  const header = col.name.length * 8 + col.type.length * 7.3 + icons + 64;
  return Math.min(Math.max(byType, header), 360);
}

/** Position of the focused cell. `row` -1 is the header row. */
interface Active {
  row: number;
  col: number;
}

/**
 * TanStack Table rendered with the shadcn Table parts, virtualised with
 * TanStack Virtual (UI-3, UI-6 display). Used by the Data tab (server-sorted
 * pages) and the SQL results (static). `role="grid"` keyboard model:
 * arrows, Home/End, Ctrl+Home/End, PageUp/PageDown, Enter expands,
 * Ctrl/Cmd+C copies.
 */
export function DataGrid(props: DataGridProps) {
  const { columns, rows, sort, onSortChange, widthsKey, editing } = props;
  const sortable = onSortChange !== undefined;
  const staged = editing?.staged;

  // Staged inserts sit above the page, newest first.
  const display = useMemo<DisplayRow[]>(() => {
    const data = rows.map<DisplayRow>((row, index) => ({
      kind: "data",
      index,
      row,
      ref: editing?.identify(row),
    }));
    if (!editing) return data;
    const inserts = editing.staged.inserts.map<DisplayRow>((r) => ({
      kind: "insert",
      id: r.tempId,
      values: r.values,
    }));
    return [...inserts, ...data];
  }, [rows, editing]);
  const insertCount = staged?.inserts.length ?? 0;

  // Names are unique in a table; SQL results can repeat them (`a.id, b.id`).
  const ids = useMemo(() => {
    const unique = new Set(columns.map((c) => c.name)).size === columns.length;
    return columns.map((c, i) => (unique ? c.name : `${i}:${c.name}`));
  }, [columns]);

  const editable = editing !== undefined;
  const defs = useMemo(() => {
    const data = columns.map((col, index) =>
      helper.accessor((row): unknown => row[index] ?? null, {
        id: ids[index] as string,
        header: col.name,
        size: defaultWidth(col),
        enableSorting: sortable,
        meta: { index, col },
      }),
    );
    if (!editable) return data;
    const select = helper.accessor((): unknown => null, {
      id: SELECT_ID,
      header: "",
      size: SELECT_WIDTH,
      enableSorting: false,
      enableResizing: false,
      meta: { index: -1, col: SELECT_COLUMN, select: true },
    });
    return [select, ...data];
  }, [columns, ids, sortable, editable]);

  const [sizing, setSizing] = useState<ColumnSizingState>(() =>
    widthsKey ? readStored(`widths:${widthsKey}`, {}) : {},
  );
  useEffect(() => {
    if (widthsKey) writeStored(`widths:${widthsKey}`, sizing);
  }, [widthsKey, sizing]);

  const sorting = useMemo<SortingState>(
    () => (sort ?? []).map((s) => ({ id: s.col, desc: s.dir === "desc" })),
    [sort],
  );
  const visibility = useMemo<ColumnVisibilityState>(
    () => Object.fromEntries((props.hidden ?? []).map((name) => [name, false])),
    [props.hidden],
  );

  const table = useTable({
    features,
    columns: defs,
    data: rows,
    getRowId: (_row, index) => String(index),
    defaultColumn: { minSize: 60, maxSize: 1200 },
    columnResizeMode: "onChange",
    manualSorting: true,
    enableMultiSort: true,
    enableMultiRemove: true,
    enableSortingRemoval: true,
    sortDescFirst: false,
    state: { sorting, columnSizing: sizing, columnVisibility: visibility },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      onSortChange?.(next.map((s) => ({ col: s.id, dir: s.desc ? "desc" : "asc" })));
    },
    onColumnSizingChange: (updater) =>
      setSizing((prev) => (typeof updater === "function" ? updater(prev) : updater)),
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const cols = headers.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 12,
  });
  const virtualColumns = cols > VIRTUAL_COLUMNS;
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: cols,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => headers[i]?.getSize() ?? 150,
    overscan: 4,
    enabled: virtualColumns,
  });
  const sizeKey = headers.map((h) => h.getSize()).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when widths change.
  useEffect(() => {
    if (virtualColumns) colVirtualizer.measure();
  }, [sizeKey, virtualColumns, colVirtualizer]);

  const vRows = rowVirtualizer.getVirtualItems();
  const vCols = virtualColumns
    ? colVirtualizer.getVirtualItems()
    : headers.map((_, index) => ({ index, start: 0, end: 0 }));
  const padTop = vRows.length > 0 ? (vRows[0]?.start ?? 0) - HEADER_HEIGHT : 0;
  const padBottom =
    vRows.length > 0 ? rowVirtualizer.getTotalSize() - (vRows[vRows.length - 1]?.end ?? 0) : 0;
  const padLeft = virtualColumns ? (vCols[0]?.start ?? 0) : 0;
  const padRight = virtualColumns
    ? colVirtualizer.getTotalSize() - (vCols[vCols.length - 1]?.end ?? 0)
    : 0;

  // T11 perf: request start is marked in api.rows; this marks first paint.
  useEffect(() => {
    if (rows.length === 0) return;
    const frame = requestAnimationFrame(() => performance.mark("d1s:grid-painted"));
    return () => cancelAnimationFrame(frame);
  }, [rows]);

  // Keyboard model.
  const [active, setActive] = useState<Active>({ row: 0, col: 0 });
  const focusPending = useRef(false);
  const clamped: Active = {
    row: Math.min(Math.max(active.row, -1), display.length - 1),
    col: Math.min(Math.max(active.col, 0), cols - 1),
  };
  const move = useCallback(
    (next: Active) => {
      const row = Math.min(Math.max(next.row, -1), display.length - 1);
      const col = Math.min(Math.max(next.col, 0), cols - 1);
      focusPending.current = true;
      setActive({ row, col });
      if (row >= 0) rowVirtualizer.scrollToIndex(row, { align: "auto" });
      else scrollRef.current?.scrollTo({ top: 0 });
      if (virtualColumns) colVirtualizer.scrollToIndex(col, { align: "auto" });
    },
    [display.length, cols, rowVirtualizer, colVirtualizer, virtualColumns],
  );
  useLayoutEffect(() => {
    if (!focusPending.current) return;
    const el = tableRef.current?.querySelector<HTMLElement>(
      `[data-cell="${clamped.row}:${clamped.col}"]`,
    );
    if (el) {
      focusPending.current = false;
      el.focus({ preventScroll: true });
    }
  });

  // "Add row": the new row is pinned at the top, so bring it into view and focus it.
  const seenInserts = useRef(insertCount);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new insert should move focus.
  useEffect(() => {
    if (insertCount > seenInserts.current) move({ row: 0, col: editable ? 1 : 0 });
    seenInserts.current = insertCount;
  }, [insertCount]);

  const [expanded, setExpanded] = useState<ExpandedCell | null>(null);
  const [menuCell, setMenuCell] = useState<Active | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** The cell being edited in place; `seed` is the character that started it. */
  const [editCell, setEditCell] = useState<{ at: Active; seed?: string } | null>(null);
  /** The row the last shift-click range starts from. */
  const anchor = useRef<number | null>(null);

  const metaAt = (at: Active): Meta | undefined => headers[at.col]?.column.columnDef.meta;
  const columnAt = (at: Active) => metaAt(at)?.col;

  const isDeleted = (dr: DisplayRow | undefined): boolean =>
    dr?.kind === "data" && dr.ref !== undefined && staged?.deletes.has(dr.ref.id) === true;
  const rowIdOf = (dr: DisplayRow | undefined): string | undefined =>
    dr?.kind === "insert" ? dr.id : dr?.ref?.id;

  /** A cell's shown value: staged over stored. `undefined` is an unset insert (DEFAULT). */
  const stateOf = (dr: DisplayRow, meta: Meta): { value: Cell | undefined; staged: boolean } => {
    if (dr.kind === "insert") {
      const value = dr.values[meta.col.name];
      return { value, staged: value !== undefined };
    }
    const set = dr.ref ? staged?.updates.get(dr.ref.id)?.set : undefined;
    if (set && Object.hasOwn(set, meta.col.name)) {
      return { value: set[meta.col.name] as CellValue, staged: true };
    }
    return { value: dr.row[meta.index] ?? null, staged: false };
  };

  const valueAt = (at: Active): Cell | undefined => {
    const meta = metaAt(at);
    const dr = display[at.row];
    if (!meta || meta.select || !dr || at.row < 0) return undefined;
    return stateOf(dr, meta).value;
  };

  /** Can this cell be written? Not generated columns, deleted rows or BLOBs (v1). */
  const canEdit = (at: Active): boolean => {
    const meta = metaAt(at);
    const dr = display[at.row];
    if (!editing || !meta || meta.select || !dr || at.row < 0) return false;
    if (editing.readonlyColumns.has(meta.col.name)) return false;
    if (dr.kind === "insert") return !meta.col.type.toUpperCase().includes("BLOB");
    if (!dr.ref || isDeleted(dr)) return false;
    return cellKind(stateOf(dr, meta).value ?? null) !== "blob";
  };

  /** Stages `value` on a cell, routing to the insert or the existing row. */
  const stageCell = (at: Active, value: CellValue) => {
    const meta = metaAt(at);
    const dr = display[at.row];
    if (!editing || !meta || !dr) return;
    if (dr.kind === "insert") editing.store.setInsertCell(dr.id, meta.col.name, value);
    else if (dr.ref) {
      editing.store.setCell(dr.ref, meta.col.name, value, dr.row[meta.index] ?? null);
    }
  };
  const revertAt = (at: Active) => {
    const meta = metaAt(at);
    const dr = display[at.row];
    if (!editing || !meta || !dr) return;
    if (dr.kind === "insert") editing.store.setInsertCell(dr.id, meta.col.name, undefined);
    else if (dr.ref) editing.store.revertCell(dr.ref.id, meta.col.name);
  };
  const deleteRowAt = (at: Active) => {
    const dr = display[at.row];
    if (!editing || !dr) return;
    if (dr.kind === "insert") editing.store.deleteRows([{ id: dr.id }]);
    else if (dr.ref) editing.store.deleteRows([dr.ref]);
  };

  const expand = (at: Active) => {
    const value = valueAt(at);
    const meta = metaAt(at);
    const dr = display[at.row];
    if (value === undefined || !meta || !dr || !isExpandable(value)) return;
    setExpanded({
      column: meta.col.name,
      type: meta.col.type,
      row: dr.kind === "insert" ? "new" : (props.rowOffset ?? 0) + dr.index + 1,
      value,
      at,
      editable: canEdit(at),
    });
  };

  /** Enter, F2, double-click or typing. Long text and JSON open the sheet instead. */
  const startEdit = (at: Active, seed?: string) => {
    if (!canEdit(at)) {
      expand(at);
      return;
    }
    const value = valueAt(at);
    if (seed === undefined && value !== undefined && isExpandable(value)) expand(at);
    else setEditCell({ at, seed });
  };
  const finishEdit = (at: Active, how: CommitKey | CancelReason) => {
    setEditCell(null);
    // Leaving by clicking elsewhere must not pull focus back.
    if (how === "blur") return;
    if (how === "tab") move({ row: at.row, col: at.col + 1 });
    else {
      focusPending.current = true;
      setActive(at);
    }
  };

  const copy = async (value: Cell) => {
    try {
      await navigator.clipboard.writeText(cellText(value));
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  };

  // Selection (T6): keyed by row id, Shift-click selects a range.
  const selectableId = (dr: DisplayRow | undefined) => (isDeleted(dr) ? undefined : rowIdOf(dr));
  const toggleRow = (index: number, shift: boolean) => {
    if (!editing) return;
    const id = selectableId(display[index]);
    if (!id) return;
    const next = new Set(editing.selected);
    const on = !next.has(id);
    const from = shift && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = shift && anchor.current !== null ? Math.max(anchor.current, index) : index;
    for (let i = from; i <= to; i++) {
      const rid = selectableId(display[i]);
      if (rid) on ? next.add(rid) : next.delete(rid);
    }
    anchor.current = index;
    editing.onSelectedChange(next);
  };
  const selectableIds = display.flatMap((dr) => selectableId(dr) ?? []);
  const selectedHere = selectableIds.filter((id) => editing?.selected.has(id)).length;
  const allSelected = selectableIds.length > 0 && selectedHere === selectableIds.length;
  const toggleAll = () =>
    editing?.onSelectedChange(allSelected ? new Set() : new Set(selectableIds));

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement;
    // Keys typed into the cell editor belong to it, not to the grid.
    if (target.closest("[data-editor]")) return;
    const cell = target.closest<HTMLElement>("[data-cell]");
    if (!cell || !tableRef.current?.contains(cell)) return;
    const at = clamped;
    const onSelect = metaAt(at)?.select === true;
    const ctrl = event.ctrlKey || event.metaKey;
    const page = Math.max(
      1,
      Math.floor(((scrollRef.current?.clientHeight ?? 400) - HEADER_HEIGHT) / ROW_HEIGHT) - 1,
    );
    let next: Active | undefined;
    switch (event.key) {
      case "ArrowRight":
        next = { ...at, col: at.col + 1 };
        break;
      case "ArrowLeft":
        next = { ...at, col: at.col - 1 };
        break;
      case "ArrowDown":
        if (event.altKey && at.row === -1) {
          setOpenMenu(headers[at.col]?.id ?? null);
          event.preventDefault();
          return;
        }
        next = { ...at, row: at.row + 1 };
        break;
      case "ArrowUp":
        next = { ...at, row: at.row - 1 };
        break;
      case "Home":
        next = ctrl ? { row: display.length > 0 ? 0 : -1, col: 0 } : { ...at, col: 0 };
        break;
      case "End":
        next = ctrl ? { row: display.length - 1, col: cols - 1 } : { ...at, col: cols - 1 };
        break;
      case "PageDown":
        next = { ...at, row: at.row + page };
        break;
      case "PageUp":
        next = { ...at, row: Math.max(at.row - page, at.row < 0 ? -1 : 0) };
        break;
      case "Enter":
        if (at.row >= 0 && !onSelect) {
          event.preventDefault();
          if (editing) startEdit(at);
          else expand(at);
        }
        return;
      case "F2":
        if (editing && at.row >= 0 && !onSelect) {
          event.preventDefault();
          startEdit(at);
        }
        return;
      case " ":
        if (editing && onSelect) {
          event.preventDefault();
          if (at.row >= 0) toggleRow(at.row, event.shiftKey);
          else toggleAll();
        }
        return;
      case "c":
      case "C": {
        if (!ctrl || at.row < 0 || window.getSelection()?.toString()) return;
        const value = valueAt(at);
        if (value !== undefined) {
          event.preventDefault();
          void copy(value);
        }
        return;
      }
      default:
        // Typing a character starts editing with it, like a spreadsheet.
        if (
          editing &&
          at.row >= 0 &&
          !onSelect &&
          event.key.length === 1 &&
          !ctrl &&
          !event.altKey &&
          canEdit(at)
        ) {
          event.preventDefault();
          startEdit(at, event.key);
        }
        return;
    }
    event.preventDefault();
    move(next);
  };

  const menuValue = menuCell ? valueAt(menuCell) : undefined;
  const menuColumn = menuCell ? columnAt(menuCell) : undefined;
  const menuMeta = menuCell ? metaAt(menuCell) : undefined;
  const menuRow = menuCell ? display[menuCell.row] : undefined;
  const menuStaged = menuMeta && menuRow ? stateOf(menuRow, menuMeta).staged : false;
  const filterable =
    props.onAddFilter !== undefined && menuColumn !== undefined && menuMeta?.select !== true;

  const body = props.loading ? (
    <SkeletonRows cols={Math.max(cols, 1)} />
  ) : (
    <>
      {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
      {vRows.map((vr) => {
        const dr = display[vr.index];
        if (!dr) return null;
        const rowId = rowIdOf(dr);
        // The row a failed apply pointed at stands out over its other state.
        const rowState: RowState | undefined =
          rowId !== undefined && staged?.failed === rowId
            ? "failed"
            : dr.kind === "insert"
              ? "inserted"
              : isDeleted(dr)
                ? "deleted"
                : undefined;
        const rowIndex =
          dr.kind === "insert" ? vr.index + 2 : (props.rowOffset ?? 0) + insertCount + dr.index + 2;
        return (
          <TableRow
            key={vr.key}
            role="row"
            aria-rowindex={rowIndex}
            data-row-state={rowState}
            aria-selected={rowId !== undefined && editing?.selected.has(rowId) ? true : undefined}
            className="hover:bg-muted/40"
          >
            {padLeft > 0 && <td aria-hidden style={{ width: padLeft }} />}
            {vCols.map((vc) => {
              const header = headers[vc.index];
              if (!header) return null;
              const meta = header.column.columnDef.meta as Meta;
              const at: Active = { row: vr.index, col: vc.index };
              const cellId = `${vr.index}:${vc.index}`;
              const isActive = clamped.row === vr.index && clamped.col === vc.index;
              if (meta.select) {
                return (
                  <SelectCell
                    key={header.id}
                    cellId={cellId}
                    colIndex={vc.index + 1}
                    tabbable={isActive}
                    width={header.getSize()}
                    label={
                      dr.kind === "insert"
                        ? "Select new row"
                        : `Select row ${(props.rowOffset ?? 0) + dr.index + 1}`
                    }
                    checked={rowId !== undefined && editing?.selected.has(rowId) === true}
                    disabled={selectableId(dr) === undefined}
                    state={rowState}
                    onFocus={() => setActive(at)}
                    onToggle={(shift) => toggleRow(vr.index, shift)}
                  />
                );
              }
              const shown = stateOf(dr, meta);
              const editingHere =
                editCell !== null && editCell.at.row === at.row && editCell.at.col === at.col;
              return (
                <GridCell
                  key={header.id}
                  value={shown.value ?? null}
                  placeholder={shown.value === undefined}
                  staged={shown.staged}
                  state={rowState}
                  width={header.getSize()}
                  cellId={cellId}
                  colIndex={vc.index + 1}
                  tabbable={isActive}
                  editor={
                    editingHere ? (
                      <CellEditor
                        label={`Edit ${meta.col.name}`}
                        kind={inputKind(meta.col.type, shown.value)}
                        initial={editCell.seed ?? editText(shown.value)}
                        seeded={editCell.seed !== undefined}
                        onCommit={(value, how) => {
                          stageCell(at, value);
                          finishEdit(at, how);
                        }}
                        onCancel={(how) => finishEdit(at, how)}
                      />
                    ) : undefined
                  }
                  onFocus={() => setActive(at)}
                  onDoubleClick={() => (editing ? startEdit(at) : expand(at))}
                  onContextMenu={() => {
                    setActive(at);
                    setMenuCell(at);
                  }}
                />
              );
            })}
            {padRight > 0 && <td aria-hidden style={{ width: padRight }} />}
          </TableRow>
        );
      })}
      {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
    </>
  );

  return (
    <div
      ref={scrollRef}
      className={cn(
        "relative min-h-0 flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible",
        props.className,
      )}
    >
      <Table
        ref={tableRef}
        role="grid"
        aria-label={props.label}
        aria-rowcount={(props.rowCount ?? rows.length) + insertCount + 1}
        aria-colcount={cols}
        onKeyDown={onKeyDown}
        style={{ width: table.getTotalSize(), tableLayout: "fixed" }}
        className="border-separate border-spacing-0 font-mono text-[13px]"
      >
        <TableHeader className="sticky top-0 z-10 bg-background [&_tr]:border-0">
          <TableRow role="row" aria-rowindex={1} className="hover:bg-transparent">
            {padLeft > 0 && <th aria-hidden style={{ width: padLeft }} />}
            {vCols.map((vc) => {
              const header = headers[vc.index];
              if (!header) return null;
              const meta = header.column.columnDef.meta as Meta;
              const sorted = header.column.getIsSorted();
              const sortIndex = sorting.length > 1 ? header.column.getSortIndex() : -1;
              if (meta.select) {
                return (
                  <TableHead
                    key={header.id}
                    role="columnheader"
                    aria-colindex={vc.index + 1}
                    style={{ width: header.getSize(), height: HEADER_HEIGHT }}
                    className="sticky left-0 z-20 border-r border-b bg-background p-0"
                  >
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: the grid's roving-focus target, like the other header cells. */}
                    <div
                      data-cell={`-1:${vc.index}`}
                      tabIndex={clamped.row === -1 && clamped.col === vc.index ? 0 : -1}
                      onFocus={() => setActive({ row: -1, col: vc.index })}
                      className="flex h-full items-center justify-center bg-muted/50 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <Checkbox
                        aria-label="Select all rows"
                        tabIndex={-1}
                        checked={allSelected}
                        indeterminate={selectedHere > 0 && !allSelected}
                        disabled={selectableIds.length === 0}
                        onCheckedChange={toggleAll}
                        className="data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:before:absolute data-indeterminate:before:h-0.5 data-indeterminate:before:w-2 data-indeterminate:before:bg-primary-foreground data-indeterminate:[&_svg]:hidden"
                      />
                    </div>
                  </TableHead>
                );
              }
              return (
                <TableHead
                  key={header.id}
                  role="columnheader"
                  aria-colindex={vc.index + 1}
                  aria-sort={
                    sortable
                      ? sorted === "asc"
                        ? "ascending"
                        : sorted === "desc"
                          ? "descending"
                          : "none"
                      : undefined
                  }
                  style={{ width: header.getSize(), height: HEADER_HEIGHT }}
                  className="relative border-r border-b bg-muted/50 p-0"
                >
                  <div className="flex h-full items-center">
                    <button
                      type="button"
                      data-cell={`-1:${vc.index}`}
                      tabIndex={clamped.row === -1 && clamped.col === vc.index ? 0 : -1}
                      onFocus={() => setActive({ row: -1, col: vc.index })}
                      onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
                      aria-disabled={!sortable || undefined}
                      title={sortable ? "Sort (Shift-click adds a sort)" : undefined}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      {meta.col.pk ? (
                        <KeyRoundIcon
                          aria-label="Primary key"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                      {meta.col.fk && <ForeignKeyIcon fk={meta.col.fk} />}
                      <span className="truncate font-medium">{meta.col.name}</span>
                      {meta.col.type && (
                        <span className="truncate text-xs font-normal text-muted-foreground">
                          {meta.col.type}
                        </span>
                      )}
                      {sorted && (
                        <span className="ml-auto flex shrink-0 items-center text-xs text-muted-foreground">
                          {sorted === "asc" ? (
                            <ArrowUpIcon aria-label="ascending" className="size-3.5" />
                          ) : (
                            <ArrowDownIcon aria-label="descending" className="size-3.5" />
                          )}
                          {sortIndex >= 0 && sortIndex + 1}
                        </span>
                      )}
                    </button>
                    {(sortable || props.onHideColumn || props.onFilterColumn) && (
                      <DropdownMenu
                        open={openMenu === header.id}
                        onOpenChange={(open) => setOpenMenu(open ? header.id : null)}
                      >
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon-xs" className="mr-1 shrink-0" />
                          }
                          tabIndex={-1}
                          aria-label={`${meta.col.name} column menu`}
                        >
                          <ChevronDownIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          <DropdownMenuGroup>
                            {sortable && (
                              <>
                                <DropdownMenuItem
                                  onClick={() => header.column.toggleSorting(false, false)}
                                >
                                  <ArrowUpIcon />
                                  Sort ascending
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => header.column.toggleSorting(true, false)}
                                >
                                  <ArrowDownIcon />
                                  Sort descending
                                </DropdownMenuItem>
                              </>
                            )}
                            {props.onFilterColumn && (
                              <DropdownMenuItem
                                onClick={() => props.onFilterColumn?.(meta.col.name)}
                              >
                                <FilterIcon />
                                Filter…
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuGroup>
                          {props.onHideColumn && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  onClick={() => props.onHideColumn?.(meta.col.name)}
                                >
                                  <EyeOffIcon />
                                  Hide column
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {/* Pointer-only resize handle; double-click resets the width. */}
                  <div
                    aria-hidden
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    onDoubleClick={() => header.column.resetSize()}
                    data-resizing={header.column.getIsResizing() || undefined}
                    className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-ring/50 data-resizing:bg-ring"
                  />
                </TableHead>
              );
            })}
            {padRight > 0 && <th aria-hidden style={{ width: padRight }} />}
          </TableRow>
        </TableHeader>
        <ContextMenu onOpenChange={(open) => !open && setMenuCell(null)}>
          <ContextMenuTrigger render={<TableBody />} className="select-text">
            {body}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {editing && menuCell && metaAt(menuCell) && !metaAt(menuCell)?.select && (
              <>
                <ContextMenuGroup>
                  <ContextMenuItem
                    disabled={!canEdit(menuCell)}
                    // After the menu has closed and given focus back.
                    onClick={() => window.setTimeout(() => startEdit(menuCell), 50)}
                  >
                    <PencilIcon />
                    Edit cell
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!canEdit(menuCell)}
                    onClick={() => stageCell(menuCell, null)}
                  >
                    <BanIcon />
                    Set NULL
                  </ContextMenuItem>
                  <ContextMenuItem disabled={!menuStaged} onClick={() => revertAt(menuCell)}>
                    <Undo2Icon />
                    Revert change
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={
                      rowIdOf(display[menuCell.row]) === undefined ||
                      isDeleted(display[menuCell.row])
                    }
                    onClick={() => deleteRowAt(menuCell)}
                  >
                    <Trash2Icon />
                    Delete row
                  </ContextMenuItem>
                </ContextMenuGroup>
                <ContextMenuSeparator />
              </>
            )}
            {filterable && menuColumn && (
              <>
                <ContextMenuGroup>
                  <ContextMenuItem
                    disabled={
                      menuValue === undefined ||
                      menuValue === null ||
                      cellKind(menuValue) === "blob"
                    }
                    onClick={() => {
                      if (
                        menuValue === undefined ||
                        menuValue === null ||
                        cellKind(menuValue) === "blob"
                      )
                        return;
                      props.onAddFilter?.({
                        col: menuColumn.name,
                        op: "eq",
                        value: menuValue as Exclude<Cell, null | { $blob: number }>,
                      });
                    }}
                  >
                    <FilterIcon />
                    Filter by this value
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => props.onAddFilter?.({ col: menuColumn.name, op: "null" })}
                  >
                    <FilterIcon />
                    Is NULL
                  </ContextMenuItem>
                </ContextMenuGroup>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuGroup>
              <ContextMenuItem
                disabled={menuValue === undefined}
                onClick={() => menuValue !== undefined && void copy(menuValue)}
              >
                <CopyIcon />
                Copy value
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      </Table>
      {!props.loading && display.length === 0 && props.empty}
      <TooltipPrimitive.Root handle={tooltipHandle}>
        {({ payload }) =>
          payload ? (
            <TooltipContent className="max-w-md break-words whitespace-pre-wrap">
              {payload}
            </TooltipContent>
          ) : null
        }
      </TooltipPrimitive.Root>
      <CellSheet
        cell={expanded}
        onClose={() => setExpanded(null)}
        onCopy={copy}
        onStage={(cell, text) => stageCell(cell.at, text)}
      />
    </div>
  );
}

/** Edge and tint per staged row state (semantic tokens, 02-T1). */
const ROW_STATE_CELL: Record<RowState, string> = {
  inserted: "bg-inserted/10",
  deleted: "text-muted-foreground line-through",
  failed: "bg-destructive/10",
};
const ROW_STATE_EDGE: Record<RowState, string> = {
  inserted: "border-l-2 border-l-inserted",
  deleted: "border-l-2 border-l-deleted",
  failed: "border-l-2 border-l-destructive",
};

function GridCell(props: {
  value: Cell;
  /** An insert column left unset: shown as DEFAULT. */
  placeholder: boolean;
  staged: boolean;
  state: RowState | undefined;
  width: number;
  cellId: string;
  colIndex: number;
  tabbable: boolean;
  /** Replaces the content while the cell is being edited. */
  editor?: ReactNode;
  onFocus: () => void;
  onDoubleClick: () => void;
  onContextMenu: () => void;
}) {
  const { value } = props;
  const kind = cellKind(value);
  const cellProps = {
    role: "gridcell",
    "data-cell": props.cellId,
    "data-staged": props.staged || undefined,
    "aria-description": props.staged ? "edited" : undefined,
    "aria-colindex": props.colIndex,
    tabIndex: props.tabbable ? 0 : -1,
    onFocus: props.onFocus,
    onDoubleClick: props.onDoubleClick,
    onContextMenu: props.onContextMenu,
    className: cn(
      "relative h-8 max-w-0 truncate border-r border-b px-2 py-0 outline-none focus:outline-2 focus:-outline-offset-2 focus:outline-ring",
      (kind === "number" || kind === "int") && "text-right tabular-nums",
      props.state && ROW_STATE_CELL[props.state],
      props.staged && "bg-staged/15",
      props.editor && "overflow-visible p-0",
    ),
  } as const;
  const dot = props.staged && !props.editor && (
    <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-staged" />
  );

  if (props.editor) return <TableCell {...cellProps}>{props.editor}</TableCell>;
  if (props.placeholder) {
    return (
      <TableCell {...cellProps}>
        <span className="text-foreground/70 italic">DEFAULT</span>
      </TableCell>
    );
  }
  if (kind === "null") {
    return (
      <TableCell {...cellProps}>
        <span className="text-muted-foreground italic">NULL</span>
        {dot}
      </TableCell>
    );
  }
  if (kind === "number" || kind === "int") {
    return (
      <TableCell {...cellProps}>
        {cellText(value)}
        {dot}
      </TableCell>
    );
  }
  if (kind === "blob") {
    return (
      <TableCell {...cellProps}>
        <Badge variant="secondary">{blobLabel((value as { $blob: number }).$blob)}</Badge>
      </TableCell>
    );
  }
  const text = value as string;
  const content =
    kind === "json" ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <Badge variant="outline">{text.trimStart().startsWith("[") ? "[]" : "{}"}</Badge>
        <span className="truncate">{text}</span>
      </span>
    ) : (
      text
    );
  // Only likely-truncated text gets a tooltip; they share one popup.
  const truncated = text.length * 7.9 > props.width - 16 || text.includes("\n");
  if (!truncated) {
    return (
      <TableCell {...cellProps}>
        {content}
        {dot}
      </TableCell>
    );
  }
  return (
    <TooltipTrigger
      handle={tooltipHandle}
      payload={text.length > TOOLTIP_CHARS ? `${text.slice(0, TOOLTIP_CHARS)}…` : text}
      render={<TableCell {...cellProps} />}
    >
      {content}
      {dot}
    </TooltipTrigger>
  );
}

/** The row checkbox. Shift-click selects the range from the last one clicked. */
function SelectCell(props: {
  cellId: string;
  colIndex: number;
  tabbable: boolean;
  width: number;
  label: string;
  checked: boolean;
  disabled: boolean;
  state: RowState | undefined;
  onFocus: () => void;
  onToggle: (shift: boolean) => void;
}) {
  const shift = useRef(false);
  return (
    <TableCell
      role="gridcell"
      data-cell={props.cellId}
      aria-colindex={props.colIndex}
      tabIndex={props.tabbable ? 0 : -1}
      onFocus={props.onFocus}
      className={cn(
        "sticky left-0 z-[1] h-8 border-r border-b bg-background p-0 outline-none focus:outline-2 focus:-outline-offset-2 focus:outline-ring",
        props.state && ROW_STATE_EDGE[props.state],
      )}
    >
      {/* The modifier is read on the way in: `onCheckedChange` doesn't carry it. */}
      <div
        className="flex h-full items-center justify-center"
        onClickCapture={(event) => {
          shift.current = event.shiftKey;
        }}
      >
        <Checkbox
          aria-label={props.label}
          tabIndex={-1}
          checked={props.checked}
          disabled={props.disabled}
          onCheckedChange={() => props.onToggle(shift.current)}
        />
      </div>
    </TableCell>
  );
}

function ForeignKeyIcon({ fk }: { fk: NonNullable<GridColumn["fk"]> }) {
  const target = `${fk.table}.${fk.column ?? "?"}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="flex shrink-0"
        aria-label={`Foreign key to ${target}`}
      >
        <LinkIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent>→ {target}</TooltipContent>
    </Tooltip>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return Array.from({ length: 8 }, (_, r) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
    <TableRow key={r} className="hover:bg-transparent">
      {Array.from({ length: cols }, (_, c) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
        <TableCell key={c} className="h-8 border-b px-2 py-0">
          <Skeleton className="h-4 w-3/4" />
        </TableCell>
      ))}
    </TableRow>
  ));
}
