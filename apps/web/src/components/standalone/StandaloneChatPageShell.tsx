import type { ReactNode } from "react";

import { ContentPanelHeader } from "../layout/ContentPanelHeader";
import { SidebarInset } from "../ui/sidebar";

interface StandaloneChatPageShellProps {
  readonly header: ReactNode;
  readonly children: ReactNode;
}

export function StandaloneChatPageShell({ header, children }: StandaloneChatPageShellProps) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <ContentPanelHeader className="shrink-0">{header}</ContentPanelHeader>
        <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </SidebarInset>
  );
}
