import { useQuery } from "@tanstack/react-query";
import { TableIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { SqlView } from "@/components/sql-view";
import { StructureView } from "@/components/structure-view";
import { TableData } from "@/components/table-data";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Meta, queries } from "@/lib/api";
import { readStored, writeStored } from "@/lib/storage";
import { type Tab, useUrlState } from "@/lib/url-state";

export function Studio({ meta }: { meta: Meta }) {
  const [url, setUrl] = useUrlState();
  const tables = useQuery(queries.tables());

  // Open the first table (or view), so there's data on screen right away.
  const visible = tables.data?.tables.filter((t) => !t.hidden) ?? [];
  const first = (visible.find((t) => t.type !== "view") ?? visible[0])?.name;
  useEffect(() => {
    if (url.table === null && first) setUrl({ table: first }, { replace: true });
  }, [url.table, first, setUrl]);

  const table = url.table;
  const known = tables.data?.tables.find((t) => t.name === table);
  const tab: Tab = table ? url.tab : "sql";

  return (
    <SidebarProvider className="h-svh">
      <AppSidebar
        tables={tables}
        remote={meta.mode === "remote"}
        active={table}
        onOpen={(name) => setUrl({ table: name, page: 0, sort: [], filters: [] })}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <AppHeader meta={meta} table={table} />
        <Notices notices={meta.notices} />
        <Tabs
          value={tab}
          onValueChange={(value) => setUrl({ tab: value as Tab })}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="border-b px-4 py-2">
            <TabsList>
              <TabsTrigger value="data" disabled={!table}>
                Data
              </TabsTrigger>
              <TabsTrigger value="structure" disabled={!table}>
                Structure
              </TabsTrigger>
              <TabsTrigger value="sql">SQL</TabsTrigger>
            </TabsList>
          </div>
          {table && tables.isSuccess && !known ? (
            <NoTable name={table} />
          ) : (
            <>
              <TabsContent value="data" className="flex min-h-0 flex-col">
                {table && <TableData key={table} table={table} readOnly={meta.readOnly} />}
              </TabsContent>
              <TabsContent value="structure" className="min-h-0 overflow-auto">
                {table && (
                  <StructureView table={table} onOpenTable={(name) => setUrl({ table: name })} />
                )}
              </TabsContent>
            </>
          )}
          <TabsContent value="sql" keepMounted className="flex min-h-0 flex-col">
            <SqlView databaseId={meta.database?.id ?? meta.database?.name ?? "db"} />
          </TabsContent>
        </Tabs>
      </SidebarInset>
    </SidebarProvider>
  );
}

function NoTable({ name }: { name: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TableIcon />
        </EmptyMedia>
        <EmptyTitle>No table named “{name}”</EmptyTitle>
        <EmptyDescription>
          It may have been dropped or renamed. Pick one from the sidebar.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Standing notices from the server (e.g. the `wrangler dev` write warning, 01-T10). */
function Notices({ notices }: { notices: Meta["notices"] }) {
  const [dismissed, setDismissed] = useState<string[]>(() => readStored("dismissed-notices", []));
  const visible = notices.filter((n) => !dismissed.includes(n.id));
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      {visible.map((notice) => (
        <Alert key={notice.id}>
          <AlertDescription>{notice.message}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => {
                const next = [...dismissed, notice.id];
                setDismissed(next);
                writeStored("dismissed-notices", next);
              }}
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      ))}
    </div>
  );
}
