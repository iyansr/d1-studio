import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { Meta } from "@/lib/api";

export function AppHeader({ meta, table }: { meta: Meta; table: string | null }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-4" />
      <span className="truncate text-sm font-medium">{meta.database?.name}</span>
      {table && <span className="truncate text-sm text-muted-foreground">{table}</span>}
    </header>
  );
}
