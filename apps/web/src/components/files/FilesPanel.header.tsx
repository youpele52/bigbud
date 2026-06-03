interface FilesPanelHeaderProps {
  workspaceRoot: string | null;
}

export function FilesPanelHeader({ workspaceRoot }: FilesPanelHeaderProps) {
  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Files</p>
        <p
          className="truncate text-[11px] text-muted-foreground/65"
          title={workspaceRoot ?? undefined}
        >
          {workspaceRoot ?? "No workspace"}
        </p>
      </div>
    </div>
  );
}
