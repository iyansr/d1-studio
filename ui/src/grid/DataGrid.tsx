import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
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
  ChevronDownIcon,
  CopyIcon,
  EyeOffIcon,
  FilterIcon,
  KeyRoundIcon,
  LinkIcon,
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
import { readStored, writeStored } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { CellSheet, type ExpandedCell } from "./cell-sheet";
import { affinity, blobLabel, cellKind, cellText, isExpandable, TOOLTIP_CHARS } from "./cells";

export interface GridColumn {
  name: string;
  type: string;
  /** 1-based position in the primary key, or 0. */
  pk?: number;
  fk?: { table: string; column: string | null };
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
  /** Rows before this page, for aria-rowindex. */
  rowOffset?: number;
  /** All rows, when known, for aria-rowcount. */
  rowCount?: number;
  className?: string;
}

interface Meta {
  index: number;
  col: GridColumn;
}

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
  const header = col.name.length * 8.5 + col.type.length * 7 + icons + 64;
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
  const { columns, rows, sort, onSortChange, widthsKey } = props;
  const sortable = onSortChange !== undefined;

  // Names are unique in a table; SQL results can repeat them (`a.id, b.id`).
  const ids = useMemo(() => {
    const unique = new Set(columns.map((c) => c.name)).size === columns.length;
    return columns.map((c, i) => (unique ? c.name : `${i}:${c.name}`));
  }, [columns]);

  const defs = useMemo(
    () =>
      columns.map((col, index) =>
        helper.accessor((row): unknown => row[index] ?? null, {
          id: ids[index] as string,
          header: col.name,
          size: defaultWidth(col),
          enableSorting: sortable,
          meta: { index, col },
        }),
      ),
    [columns, ids, sortable],
  );

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
    count: rows.length,
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
    row: Math.min(Math.max(active.row, -1), rows.length - 1),
    col: Math.min(Math.max(active.col, 0), cols - 1),
  };
  const move = useCallback(
    (next: Active) => {
      const row = Math.min(Math.max(next.row, -1), rows.length - 1);
      const col = Math.min(Math.max(next.col, 0), cols - 1);
      focusPending.current = true;
      setActive({ row, col });
      if (row >= 0) rowVirtualizer.scrollToIndex(row, { align: "auto" });
      else scrollRef.current?.scrollTo({ top: 0 });
      if (virtualColumns) colVirtualizer.scrollToIndex(col, { align: "auto" });
    },
    [rows.length, cols, rowVirtualizer, colVirtualizer, virtualColumns],
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

  const [expanded, setExpanded] = useState<ExpandedCell | null>(null);
  const [menuCell, setMenuCell] = useState<Active | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const valueAt = (at: Active): Cell | undefined => {
    const header = headers[at.col];
    if (!header || at.row < 0) return undefined;
    return rows[at.row]?.[header.column.columnDef.meta?.index ?? 0];
  };
  const columnAt = (at: Active) => headers[at.col]?.column.columnDef.meta?.col;
  const expand = (at: Active) => {
    const value = valueAt(at);
    const col = columnAt(at);
    if (value === undefined || !col || !isExpandable(value)) return;
    setExpanded({
      column: col.name,
      type: col.type,
      row: (props.rowOffset ?? 0) + at.row + 1,
      value,
    });
  };
  const copy = async (value: Cell) => {
    try {
      await navigator.clipboard.writeText(cellText(value));
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>("[data-cell]");
    if (!cell || !tableRef.current?.contains(cell)) return;
    const at = clamped;
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
        next = ctrl ? { row: rows.length > 0 ? 0 : -1, col: 0 } : { ...at, col: 0 };
        break;
      case "End":
        next = ctrl ? { row: rows.length - 1, col: cols - 1 } : { ...at, col: cols - 1 };
        break;
      case "PageDown":
        next = { ...at, row: at.row + page };
        break;
      case "PageUp":
        next = { ...at, row: Math.max(at.row - page, at.row < 0 ? -1 : 0) };
        break;
      case "Enter":
        if (at.row >= 0) {
          event.preventDefault();
          expand(at);
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
        return;
    }
    event.preventDefault();
    move(next);
  };

  const menuValue = menuCell ? valueAt(menuCell) : undefined;
  const menuColumn = menuCell ? columnAt(menuCell) : undefined;
  const filterable = props.onAddFilter !== undefined && menuColumn !== undefined;

  const body = props.loading ? (
    <SkeletonRows cols={Math.max(cols, 1)} />
  ) : (
    <>
      {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
      {vRows.map((vr) => {
        const row = rows[vr.index] as Cell[];
        return (
          <TableRow
            key={vr.key}
            role="row"
            aria-rowindex={(props.rowOffset ?? 0) + vr.index + 2}
            className="hover:bg-muted/40"
          >
            {padLeft > 0 && <td aria-hidden style={{ width: padLeft }} />}
            {vCols.map((vc) => {
              const header = headers[vc.index];
              if (!header) return null;
              const meta = header.column.columnDef.meta as Meta;
              const value = row[meta.index] ?? null;
              const isActive = clamped.row === vr.index && clamped.col === vc.index;
              return (
                <GridCell
                  key={header.id}
                  value={value}
                  width={header.getSize()}
                  cellId={`${vr.index}:${vc.index}`}
                  colIndex={vc.index + 1}
                  tabbable={isActive}
                  onFocus={() => setActive({ row: vr.index, col: vc.index })}
                  onDoubleClick={() => expand({ row: vr.index, col: vc.index })}
                  onContextMenu={() => {
                    setActive({ row: vr.index, col: vc.index });
                    setMenuCell({ row: vr.index, col: vc.index });
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
        aria-rowcount={(props.rowCount ?? rows.length) + 1}
        aria-colcount={cols}
        onKeyDown={onKeyDown}
        style={{ width: table.getTotalSize(), tableLayout: "fixed" }}
        className="border-separate border-spacing-0"
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
      {!props.loading && rows.length === 0 && props.empty}
      <TooltipPrimitive.Root handle={tooltipHandle}>
        {({ payload }) =>
          payload ? (
            <TooltipContent className="max-w-md break-words whitespace-pre-wrap">
              {payload}
            </TooltipContent>
          ) : null
        }
      </TooltipPrimitive.Root>
      <CellSheet cell={expanded} onClose={() => setExpanded(null)} onCopy={copy} />
    </div>
  );
}

function GridCell(props: {
  value: Cell;
  width: number;
  cellId: string;
  colIndex: number;
  tabbable: boolean;
  onFocus: () => void;
  onDoubleClick: () => void;
  onContextMenu: () => void;
}) {
  const { value } = props;
  const kind = cellKind(value);
  const cellProps = {
    role: "gridcell",
    "data-cell": props.cellId,
    "aria-colindex": props.colIndex,
    tabIndex: props.tabbable ? 0 : -1,
    onFocus: props.onFocus,
    onDoubleClick: props.onDoubleClick,
    onContextMenu: props.onContextMenu,
    className: cn(
      "h-8 max-w-0 truncate border-r border-b px-2 py-0 outline-none focus:outline-2 focus:-outline-offset-2 focus:outline-ring",
      (kind === "number" || kind === "int") && "text-right tabular-nums",
    ),
  } as const;

  if (kind === "null") {
    return (
      <TableCell {...cellProps}>
        <span className="text-muted-foreground italic">NULL</span>
      </TableCell>
    );
  }
  if (kind === "number" || kind === "int") {
    return <TableCell {...cellProps}>{cellText(value)}</TableCell>;
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
        <Badge variant="outline" className="font-mono">
          {text.trimStart().startsWith("[") ? "[]" : "{}"}
        </Badge>
        <span className="truncate font-mono text-xs">{text}</span>
      </span>
    ) : (
      text
    );
  // Only likely-truncated text gets a tooltip; they share one popup.
  const truncated = text.length * 7 > props.width - 16 || text.includes("\n");
  if (!truncated) return <TableCell {...cellProps}>{content}</TableCell>;
  return (
    <TooltipTrigger
      handle={tooltipHandle}
      payload={text.length > TOOLTIP_CHARS ? `${text.slice(0, TOOLTIP_CHARS)}…` : text}
      render={<TableCell {...cellProps} />}
    >
      {content}
    </TooltipTrigger>
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
