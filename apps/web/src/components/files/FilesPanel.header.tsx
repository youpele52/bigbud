import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";

export function FilesPanelHeader() {
  return (
    <div className={cn("border-b border-border px-3 py-2.5", isElectron && "drag-region")}>
      <p className="text-sm font-medium text-foreground">Files</p>
    </div>
  );
}
