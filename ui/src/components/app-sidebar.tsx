import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseIcon, EyeIcon, RefreshCwIcon, SearchIcon, TableIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, queries, type TableEntry } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { readStored, writeStored } from "@/lib/storage";

type Tables = UseQueryResult<Awaited<ReturnType<typeof api.tables>>>;

/** Tables and views with row counts, a name filter and the system-table toggle (UI-2). */
export function AppSidebar(props: {
  tables: Tables;
  /** Remote: counts load lazily, after the list (D9). */
  remote: boolean;
  active: string | null;
  onOpen: (name: string) => void;
}) {
  const { tables, remote, active, onOpen } = props;
  const client = useQueryClient();
  const counts = useQuery({ ...queries.tableCounts(), enabled: remote && tables.isSuccess });
  const recount = useMutation({
    mutationFn: () => api.tableCounts(true),
    onSuccess: (data) => client.setQueryData(queries.tableCounts().queryKey, data),
  });
  const countsPending = remote && (counts.isPending || recount.isPending);
  const countOf = (t: TableEntry) => (remote ? counts.data?.counts[t.name] : t.rows);
  const [filter, setFilter] = useState("");
  const [showSystem, setShowSystem] = useState(() => readStored("show-system-tables", false));
  const [focused, setFocused] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const switchId = useId();

  // `/` focuses the filter, unless the user is typing somewhere.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const query = filter.trim().toLowerCase();
  const visible = (tables.data?.tables ?? []).filter(
    (t) => (showSystem || !t.hidden) && t.name.toLowerCase().includes(query),
  );
  const groups: [string, TableEntry[]][] = [
    ["Tables", visible.filter((t) => t.type !== "view")],
    ["Views", visible.filter((t) => t.type === "view")],
  ];
  // Roving tabindex: one item is tabbable; arrows move between them.
  const names = groups.flatMap(([, items]) => items.map((t) => t.name));
  const tabbable = [focused, active].find((n) => n !== null && names.includes(n)) ?? names[0];

  const items = () => [
    ...(listRef.current?.querySelectorAll<HTMLElement>("[data-table-item]") ?? []),
  ];
  const onListKeyDown = (event: KeyboardEvent) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = {
      ArrowDown: Math.min(i + 1, all.length - 1),
      ArrowUp: Math.max(i - 1, 0),
      Home: 0,
      End: all.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    all[next]?.focus();
  };
  const onFilterKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items()[0]?.focus();
    } else if (event.key === "Enter" && names[0]) {
      onOpen(names[0]);
    } else if (event.key === "Escape") {
      setFilter("");
    }
  };

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-2 text-sm font-semibold">
          <DatabaseIcon aria-hidden className="size-4" />
          d1-studio
        </div>
        <InputGroup className="h-8 bg-background">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter tables"
            aria-label="Filter tables"
          />
          <InputGroupAddon align="inline-end">
            <Kbd>/</Kbd>
          </InputGroupAddon>
        </InputGroup>
      </SidebarHeader>
      <SidebarContent ref={listRef} onKeyDown={onListKeyDown}>
        {tables.isPending ? (
          <SidebarGroup>
            <SidebarMenu>
              {["a", "b", "c", "d", "e"].map((k) => (
                <SidebarMenuItem key={k}>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : tables.isError ? (
          <SidebarGroup>
            <ErrorAlert
              title="Couldn't list tables"
              error={tables.error}
              onRetry={() => void tables.refetch()}
            />
          </SidebarGroup>
        ) : names.length === 0 ? (
          <Empty className="p-4">
            <EmptyHeader>
              <EmptyTitle>{query ? "No matches" : "No tables yet"}</EmptyTitle>
              <EmptyDescription>
                {query
                  ? `No table or view matches “${filter.trim()}”.`
                  : "Create one in the SQL tab, or run your migrations."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          groups.map(
            ([label, entries]) =>
              entries.length > 0 && (
                <SidebarGroup key={label}>
                  <SidebarGroupLabel>{label}</SidebarGroupLabel>
                  {remote && label === "Tables" && (
                    <RecountButton
                      pending={countsPending}
                      rowsRead={(recount.data ?? counts.data)?.rowsRead}
                      error={recount.error ?? counts.error}
                      onClick={() => recount.mutate()}
                    />
                  )}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {entries.map((t) => (
                        <SidebarMenuItem key={t.name}>
                          <SidebarMenuButton
                            data-table-item
                            isActive={t.name === active}
                            aria-current={t.name === active ? "page" : undefined}
                            tabIndex={t.name === tabbable ? 0 : -1}
                            title={t.name}
                            onFocus={() => setFocused(t.name)}
                            onClick={() => onOpen(t.name)}
                          >
                            {t.type === "view" ? <EyeIcon /> : <TableIcon />}
                            <span>{t.name}</span>
                          </SidebarMenuButton>
                          <RowCount count={countOf(t)} pending={countsPending && !t.hidden} />
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ),
          )
        )}
      </SidebarContent>
      <SidebarFooter>
        <Field orientation="horizontal" className="px-2 py-1">
          <Switch
            id={switchId}
            checked={showSystem}
            onCheckedChange={(checked) => {
              setShowSystem(checked);
              writeStored("show-system-tables", checked);
            }}
          />
          <FieldLabel htmlFor={switchId}>Show system tables</FieldLabel>
        </Field>
      </SidebarFooter>
    </Sidebar>
  );
}

function RowCount({ count, pending }: { count: number | null | undefined; pending: boolean }) {
  if (pending) {
    return (
      <SidebarMenuBadge>
        <Skeleton className="h-3 w-6" />
      </SidebarMenuBadge>
    );
  }
  return typeof count === "number" ? (
    <SidebarMenuBadge>{formatCount(count)}</SidebarMenuBadge>
  ) : null;
}

/** ↻ for remote counts. The tooltip shows what the last count cost (D1 bills per row read). */
function RecountButton(props: {
  pending: boolean;
  rowsRead: number | undefined;
  error: Error | null;
  onClick: () => void;
}) {
  const cost = props.error
    ? `Counting failed: ${props.error.message}`
    : props.rowsRead === undefined
      ? "Counting rows…"
      : `The last count read ${formatCount(props.rowsRead)} ${props.rowsRead === 1 ? "row" : "rows"}.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<SidebarGroupAction />}
        aria-label="Recount rows"
        disabled={props.pending}
        onClick={props.onClick}
      >
        <RefreshCwIcon className={props.pending ? "animate-spin" : undefined} />
      </TooltipTrigger>
      <TooltipContent side="right">{cost}</TooltipContent>
    </Tooltip>
  );
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}
