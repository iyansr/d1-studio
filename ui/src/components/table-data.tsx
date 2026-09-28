import { PAGE_SIZES, type PageSize, ROWID_COLUMN } from "@shared/rows";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon, EyeIcon, RefreshCwIcon, TableIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { DataGrid } from "@/grid/DataGrid";
import { queries, type RowsRequest } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

/** The Data tab: server-paged, sorted and filtered rows of one table or view. */
export function TableData({ table }: { table: string; readOnly: boolean }) {
  const [url, setUrl] = useUrlState();
  const client = useQueryClient();
  const [hidden, setHidden] = useState<string[]>([]);
  // Totals per filter set, so paging doesn't recount.
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [counting, setCounting] = useState(false);

  const filterKey = JSON.stringify(url.filters);
  const tables = useQuery(queries.tables());
  const listed = tables.data?.tables.find((t) => t.name === table)?.rows;
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        {hidden.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setHidden([])}>
            <EyeIcon data-icon="inline-start" />
            Show {hidden.length} hidden {hidden.length === 1 ? "column" : "columns"}
          </Button>
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

      {rows.isError ? (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTitle>Couldn't load rows</AlertTitle>
            <AlertDescription className="font-mono">{rows.error.message}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUrl({ sort: [], filters: [], page: 0 })}
              >
                Reset view
              </Button>
            </AlertAction>
          </Alert>
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
