import { type RefObject } from "react";
import { FolderIcon } from "lucide-react";

interface SidebarNewProjectFlowProps {
  isElectron: boolean;
  newCwd: string;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  addProjectError: string | null;
  addProjectInputRef: RefObject<HTMLInputElement | null>;
  onCwdChange: (cwd: string) => void;
  onClearError: () => void;
  onPickFolder: () => void;
  onAdd: () => void;
  onCancel: () => void;
}

export function SidebarNewProjectFlow({
  isElectron,
  newCwd,
  isPickingFolder,
  isAddingProject,
  addProjectError,
  addProjectInputRef,
  onCwdChange,
  onClearError,
  onPickFolder,
  onAdd,
  onCancel,
}: SidebarNewProjectFlowProps) {
  const canAdd = newCwd.trim().length > 0 && !isAddingProject;

  return (
    <div className="mb-2 px-1">
      {isElectron && (
        <button
          type="button"
          className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onPickFolder}
          disabled={isPickingFolder || isAddingProject}
        >
          <FolderIcon className="size-3.5" />
          {isPickingFolder ? "Picking folder..." : "Browse for folder"}
        </button>
      )}
      <div className="flex gap-1.5">
        <input
          ref={addProjectInputRef}
          className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
            addProjectError
              ? "border-red-500/70 focus:border-red-500"
              : "border-border focus:border-ring"
          }`}
          placeholder="/path/to/project"
          value={newCwd}
          onChange={(event) => {
            onCwdChange(event.target.value);
            onClearError();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") onAdd();
            if (event.key === "Escape") onCancel();
          }}
          // biome-ignore lint/a11y/noAutofocus: intentional for new-project input
          autoFocus
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
          onClick={onAdd}
          disabled={!canAdd}
        >
          {isAddingProject ? "Adding..." : "Add"}
        </button>
      </div>
      {addProjectError && (
        <p className="mt-1 px-0.5 text-[11px] leading-tight text-destructive-foreground">
          {addProjectError}
        </p>
      )}
    </div>
  );
}
