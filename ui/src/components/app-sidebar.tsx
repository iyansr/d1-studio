import type { UseQueryResult } from "@tanstack/react-query";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { api } from "@/lib/api";

type Tables = UseQueryResult<Awaited<ReturnType<typeof api.tables>>>;

export function AppSidebar(props: {
  tables: Tables;
  active: string | null;
  onOpen: (name: string) => void;
}) {
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarMenu>
          {props.tables.data?.tables
            .filter((t) => !t.hidden)
            .map((t) => (
              <SidebarMenuItem key={t.name}>
                <SidebarMenuButton
                  isActive={t.name === props.active}
                  onClick={() => props.onOpen(t.name)}
                >
                  <span>{t.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}
