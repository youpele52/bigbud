import { createFileRoute } from "@tanstack/react-router";

import { BigbudLogo } from "../components/sidebar/SidebarProjectItem";
import { isElectron } from "../config/env";
import { SidebarTrigger } from "../components/ui/sidebar";
import { useStore } from "../stores/main";

function ChatIndexRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5" />
      )}

      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center justify-center gap-4">
          <BigbudLogo
            className={
              !bootstrapComplete
                ? "h-6 animate-pulse-slow text-muted-foreground/50"
                : "h-8 opacity-70"
            }
          />
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
