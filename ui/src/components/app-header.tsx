import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type Meta, queries } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Mode, database and access (UI-1). Remote gets the accent via data-mode (T1). */
export function AppHeader({ meta, table }: { meta: Meta; table: string | null }) {
  const remote = meta.mode === 'remote';
  const db = meta.database;
  // Remote: the session's D1 usage, refreshed whenever the tooltip opens (T9).
  const usage = useQuery({ ...queries.usage(), enabled: remote });
  const read = usage.data?.usage?.rowsRead;
  const details = [
    db?.binding && `binding ${db.binding}`,
    db?.id && `id ${db.id.length > 8 ? `${db.id.slice(0, 8)}…` : db.id}`,
    read !== undefined && `${formatCount(read)} ${read === 1 ? 'row' : 'rows'} read this session`,
  ].filter(Boolean);

  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b px-3',
        remote && 'border-t-2 border-t-remote',
      )}
    >
      <SidebarTrigger />
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
      <Badge variant={remote ? 'default' : 'outline'}>{meta.mode}</Badge>
      <nav aria-label="Location" className="flex min-w-0 items-center gap-1.5 text-sm">
        {db && (
          <Tooltip
            onOpenChange={(open) => {
              if (open && remote) void usage.refetch();
            }}
          >
            <TooltipTrigger className="truncate rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              {db.name}
            </TooltipTrigger>
            {details.length > 0 && (
              <TooltipContent side="bottom">{details.join(' · ')}</TooltipContent>
            )}
          </Tooltip>
        )}
        {table && (
          <>
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{table}</span>
          </>
        )}
      </nav>
      <Badge variant={meta.readOnly ? 'secondary' : 'default'} className="ml-auto">
        {meta.readOnly ? 'READ-ONLY' : 'WRITE'}
      </Badge>
    </header>
  );
}
