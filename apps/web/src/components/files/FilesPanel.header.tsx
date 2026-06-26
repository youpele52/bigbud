import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";

interface FilesPanelHeaderProps {
  workspaceRoot: string | null;
  activeFilePath?: string | null;
}

export function FilesPanelHeader({ workspaceRoot, activeFilePath }: FilesPanelHeaderProps) {
  const secondaryText = activeFilePath ?? workspaceRoot ?? "No workspace";

  return (
    <div className={cn("border-b border-border px-3 py-2.5", isElectron && "drag-region")}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Files</p>
        <p className="truncate text-[11px] text-muted-foreground/65" title={secondaryText}>
          {secondaryText}
        </p>
      </div>
    </div>
  );
}
