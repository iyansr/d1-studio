import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayIcon, SquareTerminalIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SqlEditor, type SqlEditorHandle, sqlNamespace } from "@/editor/sql-editor";
import { DataGrid } from "@/grid/DataGrid";
import { ApiError, api, type QueryResult, queries } from "@/lib/api";
import { formatCount, formatDuration } from "@/lib/format";
import { readStored, writeStored } from "@/lib/storage";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);
const EMPTY_SCHEMA = {};

type Outcome =
  | { kind: "results"; results: QueryResult[]; notices: string[] }
  | { kind: "error"; message: string; statementIndex?: number };

/** The SQL tab (UI-7, UI-8): editor above, one results tab per statement below. */
export function SqlView({ databaseId }: { databaseId: string }) {
  const storageKey = `sql:${databaseId}`;
  const [initial] = useState(() => readStored(storageKey, ""));
  const editor = useRef<SqlEditorHandle | null>(null);
  const client = useQueryClient();
  const schema = useQuery(queries.schemaAll());
  const namespace = useMemo(
    () => (schema.data ? sqlNamespace(schema.data.tables) : EMPTY_SCHEMA),
    [schema.data],
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tab, setTab] = useState("0");
  const saveTimer = useRef<number | undefined>(undefined);

  const run = useMutation({
    mutationFn: (sql: string) => api.query(sql),
    onSuccess: (body) => {
      const results = body.results;
      // Auto-LIMIT and similar notices arrive with remote mode (plan 03).
      const notices =
        "notices" in body && Array.isArray(body.notices)
          ? (body.notices as { message: string }[]).map((n) => n.message)
          : [];
      setOutcome({ kind: "results", results, notices });
      setTab(String(Math.max(0, results.length - 1)));
      if (results.some((r) => r.columns.length === 0)) invalidate();
    },
    onError: (err) => {
      setOutcome({
        kind: "error",
        message: err.message,
        statementIndex: err instanceof ApiError ? err.statementIndex : undefined,
      });
      // Statements before the failing one may have written.
      invalidate();
    },
  });
  const invalidate = () => {
    for (const key of ["tables", "rows", "schema", "schema-all"]) {
      void client.invalidateQueries({ queryKey: [key] });
    }
  };
  const execute = (sql: string) => {
    if (sql.trim() === "" || run.isPending) return;
    run.mutate(sql);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-1.5">
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() => {
            execute(editor.current?.runnable() ?? "");
            editor.current?.focus();
          }}
        >
          {run.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          Run
          <KbdGroup className="ml-1">
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
        </Button>
        <span className="text-xs text-muted-foreground">
          Runs the selection, or the whole editor.
        </span>
      </div>
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="40%" minSize="15%">
          <SqlEditor
            initialValue={initial}
            schema={namespace}
            handleRef={editor}
            onRun={execute}
            onChange={(value) => {
              window.clearTimeout(saveTimer.current);
              saveTimer.current = window.setTimeout(() => writeStored(storageKey, value), 300);
            }}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel minSize="15%">
          <Results outcome={outcome} tab={tab} onTab={setTab} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function Results(props: { outcome: Outcome | null; tab: string; onTab: (tab: string) => void }) {
  const { outcome } = props;
  if (!outcome) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SquareTerminalIcon />
          </EmptyMedia>
          <EmptyTitle>No results yet</EmptyTitle>
          <EmptyDescription>Write a query above and run it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (outcome.kind === "error") {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertTitle>
            {outcome.statementIndex !== undefined
              ? `Statement ${outcome.statementIndex + 1} failed`
              : "The query failed"}
          </AlertTitle>
          <AlertDescription className="font-mono whitespace-pre-wrap">
            {outcome.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const { results, notices } = outcome;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {notices.length > 0 && (
        <div className="flex flex-col gap-2 px-3 pt-3">
          {notices.map((n) => (
            <Alert key={n}>
              <AlertDescription>{n}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}
      <Tabs
        value={props.tab}
        onValueChange={(v) => props.onTab(String(v))}
        className="min-h-0 flex-1 gap-0"
      >
        {results.length > 1 && (
          <div className="overflow-x-auto border-b px-3 py-1.5">
            <TabsList>
              {results.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: one tab per statement, in order.
                <TabsTrigger key={i} value={String(i)}>
                  Result {i + 1}
                  <span className="text-muted-foreground tabular-nums">
                    {r.columns.length > 0 ? formatCount(r.rows.length) : "✓"}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        )}
        {results.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one panel per statement, in order.
          <TabsContent key={i} value={String(i)} className="flex min-h-0 flex-col">
            {r.columns.length > 0 ? (
              <DataGrid
                label={`Result ${i + 1}`}
                columns={r.columns.map((name) => ({ name, type: "" }))}
                rows={r.rows}
                empty={
                  <p className="p-4 text-sm text-muted-foreground">
                    The statement returned no rows.
                  </p>
                }
              />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                Done. {formatCount(r.changes ?? 0)} {r.changes === 1 ? "row" : "rows"} changed.
              </p>
            )}
            <StatusBar result={r} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function StatusBar({ result }: { result: QueryResult }) {
  // Remote mode (plan 03) reports rows read and written.
  const meta = result as QueryResult & { rowsRead?: number; rowsWritten?: number };
  const parts = [
    result.columns.length > 0 &&
      `${formatCount(result.rows.length)} ${result.rows.length === 1 ? "row" : "rows"}`,
    formatDuration(result.durationMs),
    result.changes !== undefined && `${formatCount(result.changes)} changed`,
    meta.rowsRead !== undefined && `${formatCount(meta.rowsRead)} read`,
    meta.rowsWritten !== undefined && `${formatCount(meta.rowsWritten)} written`,
  ].filter(Boolean);
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground tabular-nums"
    >
      {parts.map((p) => (
        <span key={String(p)}>{p}</span>
      ))}
    </div>
  );
}
