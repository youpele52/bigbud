import { isElectron } from "../../../config/env";
import { BigbudLogo } from "../../sidebar/SidebarProjectItem";
import { SidebarTrigger } from "../../ui/sidebar";

export function ChatViewEmptyState() {
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
        <div className="flex flex-col items-center justify-center gap-3 opacity-70">
          <BigbudLogo className="h-8" />
        </div>
      </div>
    </div>
  );
}
