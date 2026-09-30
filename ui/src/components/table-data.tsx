import type { BatchResponse, Confirm, EditOp, WritePreview } from "@shared/edits";
import {
  type Filter,
  PAGE_SIZES,
  type PageSize,
  ROWID_COLUMN,
  type RowsColumn,
} from "@shared/rows";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  PlusIcon,
  RefreshCwIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
import { FilterBadges, FilterBuilder } from "@/components/filter-builder";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { WriteConfirmDialog } from "@/edits/confirm-dialog";
import { EditToolbar, SqlPreviewSheet } from "@/edits/edit-toolbar";
import { identifyRow } from "@/edits/row-key";
import { isInsertId } from "@/edits/staged-edits";
import { useStagedEdits } from "@/edits/useStagedEdits";
import { DataGrid, type GridEditing } from "@/grid/DataGrid";
import { ApiError, api, type Meta, queries, type RowsRequest } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

/** The Data tab: server-paged, sorted and filtered rows of one table or view. */
export function TableData({ table, meta }: { table: string; meta: Meta }) {
  const readOnly = meta.readOnly;
  const [url, setUrl] = useUrlState();
  const client = useQueryClient();
  const [hidden, setHidden] = useState<string[]>([]);
  // Totals per filter set, so paging doesn't recount.
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [counting, setCounting] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterSeed, setFilterSeed] = useState<string | null>(null);
  const schema = useQuery(queries.schema(table));
  const filterColumns = useMemo<RowsColumn[]>(
    () => schema.data?.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) ?? [],
    [schema.data],
  );
  const setFilters = (filters: Filter[]) => setUrl({ filters, page: 0 });

  const filterKey = JSON.stringify(url.filters);
  const tables = useQuery(queries.tables());
  // Remote counts come from the sidebar's lazy count; never fetched from here.
  const counts = useQuery({ ...queries.tableCounts(), enabled: false });
  const listed =
    tables.data?.tables.find((t) => t.name === table)?.rows ?? counts.data?.counts[table];
  const knownTotal =
    url.filters.length === 0 && typeof listed === "number" ? listed : totals[filterKey];

  const request: RowsRequest = {
    limit: url.size,
    offset: url.page * url.size,
    sort: url.sort,
    filters: url.filters,
    count: counting && knownTotal === undefined,
  };
  const rows = useQuery(queries.rows(table, request));
  const page = rows.data;

  // Editing (plan 04): staged per table, applied as one transaction.
  const { store, staged } = useStagedEdits(table);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<Pending2 | null>(null);
  const [sqlPreview, setSqlPreview] = useState<WritePreview | null>(null);
  const editable = !readOnly && page !== undefined && page.key.kind !== "none";
  const readonlyColumns = useMemo(
    () =>
      new Set(schema.data?.columns.filter((c) => c.generated || c.hidden).map((c) => c.name) ?? []),
    [schema.data],
  );
  const editing = useMemo<GridEditing | undefined>(() => {
    if (!editable || !page) return undefined;
    return {
      store,
      staged,
      identify: (row) => identifyRow(page.key, page.columns, row),
      readonlyColumns,
      selected,
      onSelectedChange: setSelected,
    };
  }, [editable, page, store, staged, readonlyColumns, selected]);
  // Selected rows belong to the page they were picked on.
  const view = JSON.stringify([url.page, url.size, url.sort, url.filters]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear when the view changes.
  useEffect(() => setSelected(new Set()), [view]);

  useEffect(() => {
    if (page?.total !== undefined) setTotals((t) => ({ ...t, [filterKey]: page.total as number }));
  }, [page?.total, filterKey]);

  const offset = request.offset;
  const count = page?.rows.length ?? 0;
  const total =
    knownTotal ?? (page && !page.hasMore && !rows.isPlaceholderData ? offset + count : undefined);
  const hiddenColumns = useMemo(
    () => [...(page?.key.kind === "rowid" ? [ROWID_COLUMN] : []), ...hidden],
    [page?.key.kind, hidden],
  );

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["rows", table] });
    void client.invalidateQueries({ queryKey: ["tables"] });
    setTotals({});
  };

  const preview = useMutation({
    mutationFn: (v: Pending & { purpose: "confirm" | "show" }) =>
      api.batchPreview({ table, ops: v.ops }),
    onSuccess: (data, v) => {
      if (v.purpose === "show") setSqlPreview(data);
      else setConfirming({ preview: data, ops: v.ops, ids: v.ids });
    },
    onError: (error) => toast.error(error.message),
  });

  const send = useMutation({
    mutationFn: (v: Pending & { confirm?: Confirm }) =>
      api.batch({ table, ops: v.ops, ...(v.confirm !== undefined && { confirm: v.confirm }) }),
    onSuccess: (result) => {
      setConfirming(null);
      store.discardAll();
      setSelected(new Set());
      toast.success(applied(result));
      if (result.warnings.length > 0) {
        toast.warning(
          `${result.warnings.length} ${result.warnings.length === 1 ? "change" : "changes"} matched no row: the row was changed or deleted since it was loaded.`,
        );
      }
      refresh();
      void client.invalidateQueries({ queryKey: ["table-counts"] });
      void client.invalidateQueries({ queryKey: ["usage"] });
    },
    onError: (error, v) => {
      void client.invalidateQueries({ queryKey: ["usage"] });
      const api = error instanceof ApiError ? error : undefined;
      // The server wants a confirmation we didn't send.
      if (api?.confirmation) {
        setConfirming({ preview: api.confirmation, ops: v.ops, ids: v.ids });
        return;
      }
      // Point at the row; the changes stay staged so nothing is lost.
      const id = api?.detail.opIndex === undefined ? undefined : v.ids[api.detail.opIndex];
      if (id) store.markFailed(id);
      // From the confirmation dialog the error shows there, beside the SQL.
      if (v.confirm === undefined) toast.error(error.message);
    },
  });
  const busy = preview.isPending || send.isPending;

  const apply = () => {
    const built = store.buildOps();
    if (built.ops.length === 0) return;
    store.markFailed(null);
    // Local runs at once; remote shows the SQL first (T7).
    if (meta.mode === "remote") preview.mutate({ ...built, purpose: "confirm" });
    else send.mutate(built);
  };
  const showSql = () => preview.mutate({ ...store.buildOps(), purpose: "show" });
  const discard = () => {
    store.discardAll();
    setSelected(new Set());
  };
  const deleteSelected = () => {
    const refs = (page?.rows ?? []).flatMap((row) => {
      const ref = editing?.identify(row);
      return ref && selected.has(ref.id) ? [ref] : [];
    });
    const inserted = [...selected].filter(isInsertId).map((id) => ({ id }));
    store.deleteRows([...refs, ...inserted]);
    setSelected(new Set());
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <FilterBuilder
          columns={filterColumns}
          filters={url.filters}
          onApply={setFilters}
          open={filterOpen}
          seed={filterSeed}
          onOpenChange={(open) => {
            setFilterOpen(open);
            if (!open) setFilterSeed(null);
          }}
        />
        <FilterBadges
          filters={url.filters}
          onRemove={(i) => setFilters(url.filters.filter((_, j) => j !== i))}
        />
        {hidden.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setHidden([])}>
            <EyeIcon data-icon="inline-start" />
            Show {hidden.length} hidden {hidden.length === 1 ? "column" : "columns"}
          </Button>
        )}
        {editable && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => store.addRow()}>
              <PlusIcon data-icon="inline-start" />
              Add row
            </Button>
            {selected.size > 0 && (
              <Button variant="destructive" size="sm" onClick={deleteSelected}>
                <Trash2Icon data-icon="inline-start" />
                Delete {selected.size} {selected.size === 1 ? "row" : "rows"}
              </Button>
            )}
          </div>
        )}
        {!readOnly && page && !editable && (
          <span className="text-xs text-muted-foreground">
            {schema.data?.type === "view"
              ? "Views can't be edited."
              : "No primary key or rowid, so rows can't be edited."}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh"
          onClick={refresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {editable && staged.count > 0 && (
        <EditToolbar
          count={staged.count}
          busy={busy}
          onApply={apply}
          onDiscard={discard}
          onShowSql={showSql}
        />
      )}

      {rows.isError ? (
        <div className="p-4">
          <ErrorAlert
            title="Couldn't load rows"
            error={rows.error}
            onRetry={() => void rows.refetch()}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUrl({ sort: [], filters: [], page: 0 })}
            >
              Reset view
            </Button>
          </ErrorAlert>
        </div>
      ) : (
        <DataGrid
          label={`${table} rows`}
          columns={page?.columns ?? []}
          rows={page?.rows ?? []}
          hidden={hiddenColumns}
          sort={url.sort}
          onSortChange={(sort) => setUrl({ sort, page: 0 })}
          onHideColumn={(name) => setHidden((h) => [...h, name])}
          onFilterColumn={(name) => {
            setFilterSeed(name);
            setFilterOpen(true);
          }}
          onAddFilter={(filter) => setFilters([...url.filters, filter])}
          editing={editing}
          loading={rows.isPending}
          widthsKey={table}
          rowOffset={offset}
          rowCount={total ?? offset + count + (page?.hasMore ? 1 : 0)}
          empty={
            <NoRows
              filtered={url.filters.length > 0}
              pastEnd={url.page > 0}
              onClearFilters={() => setUrl({ filters: [], page: 0 })}
              onFirstPage={() => setUrl({ page: 0 })}
            />
          }
        />
      )}

      <WriteConfirmDialog
        preview={confirming?.preview ?? null}
        database={meta.database?.name ?? ""}
        account={meta.account}
        atomic
        running={send.isPending && send.variables?.confirm !== undefined}
        error={
          confirming && send.error && !(send.error instanceof ApiError && send.error.confirmation)
            ? send.error
            : null
        }
        onRun={(confirm) =>
          confirming && send.mutate({ ops: confirming.ops, ids: confirming.ids, confirm })
        }
        onCancel={() => {
          setConfirming(null);
          send.reset();
        }}
      />
      <SqlPreviewSheet preview={sqlPreview} onClose={() => setSqlPreview(null)} />

      <footer className="flex flex-wrap items-center gap-3 border-t px-3 py-2 text-sm">
        <ToggleGroup
          aria-label="Rows per page"
          variant="outline"
          size="sm"
          spacing={0}
          value={[String(url.size)]}
          onValueChange={(value) => {
            const size = Number(value[0]);
            if (PAGE_SIZES.includes(size as PageSize)) {
              // Keep the first visible row on screen.
              setUrl({ size: size as PageSize, page: Math.floor(offset / size) });
            }
          }}
        >
          {PAGE_SIZES.map((size) => (
            <ToggleGroupItem key={size} value={String(size)} aria-label={`${size} rows per page`}>
              {size}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-muted-foreground tabular-nums" aria-live="polite">
          {count > 0 ? `Rows ${formatCount(offset + 1)}–${formatCount(offset + count)}` : "No rows"}
          {total !== undefined && ` of ${formatCount(total)}`}
        </span>
        {total === undefined && count > 0 && (
          <Button variant="link" size="sm" className="px-0" onClick={() => setCounting(true)}>
            {counting ? "counting…" : "count"}
          </Button>
        )}
        {rows.isFetching && !rows.isPending && <Spinner />}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous page"
            disabled={url.page === 0}
            onClick={() => setUrl({ page: Math.max(0, url.page - 1) })}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next page"
            disabled={!page?.hasMore || rows.isPlaceholderData}
            onClick={() => setUrl({ page: url.page + 1 })}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </footer>
    </div>
  );
}

function NoRows(props: {
  filtered: boolean;
  pastEnd: boolean;
  onClearFilters: () => void;
  onFirstPage: () => void;
}) {
  const [title, description] = props.pastEnd
    ? ["Past the last page", "There are no rows on this page."]
    : props.filtered
      ? ["No matching rows", "No rows match these filters."]
      : ["No rows", "This table is empty."];
  return (
    <Empty className="absolute inset-x-0 top-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TableIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {(props.pastEnd || props.filtered) && (
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={props.pastEnd ? props.onFirstPage : props.onClearFilters}
          >
            {props.pastEnd ? "Go to the first page" : "Clear filters"}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** What Apply sends: the ops, and the staged row each came from. */
interface Pending {
  ops: EditOp[];
  ids: string[];
}

/** The confirmation dialog's state: the SQL to show, and what to send when confirmed. */
interface Pending2 extends Pending {
  preview: WritePreview;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function applied(result: BatchResponse): string {
  const parts = [
    result.updated > 0 && `${plural(result.updated, "row")} updated`,
    result.inserted > 0 && `${plural(result.inserted, "row")} inserted`,
    result.deleted > 0 && `${plural(result.deleted, "row")} deleted`,
  ].filter(Boolean);
  return `Applied ${plural(result.statements, "change")}: ${parts.join(", ") || "no rows changed"}.`;
}
