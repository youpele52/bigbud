import {
  Columns3Icon,
  DiffIcon,
  FoldersIcon,
  GitBranchIcon,
  GlobeIcon,
  NotebookTextIcon,
  TerminalIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type LauncherToolKind =
  | "browser"
  | "diff"
  | "files"
  | "git"
  | "kanban"
  | "notes"
  | "terminal";

interface LauncherCardProps {
  description: string;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  kind: LauncherToolKind;
  label: string;
  onSelect: () => void;
  shortcutLabel: string | null;
}

function LauncherCard({
  description,
  disabled = false,
  icon: Icon,
  label,
  onSelect,
  shortcutLabel,
}: LauncherCardProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            onClick={onSelect}
            className={cn(
              "group flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl p-3 text-center transition-colors",
              disabled
                ? "cursor-not-allowed opacity-40"
                : "hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        <span className="flex size-16 items-center justify-center rounded-[1.25rem] border border-border/70 bg-secondary/60 shadow-sm transition-transform group-hover:scale-105 group-focus-visible:scale-105">
          <Icon className="size-7 text-foreground" />
        </span>
        <span className="text-xs font-medium text-foreground">{label}</span>
      </TooltipTrigger>
      <TooltipPopup className="px-3 py-2" side="top">
        <div className="flex items-center gap-3 whitespace-nowrap">
          <span>{description}</span>
          {shortcutLabel ? (
            <KbdGroup>
              <Kbd>{shortcutLabel}</Kbd>
            </KbdGroup>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

interface RightPanelLauncherProps {
  browserShortcutLabel: string | null;
  diffShortcutLabel: string | null;
  filesShortcutLabel: string | null;
  gitShortcutLabel: string | null;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  kanbanShortcutLabel?: string | null;
  notesShortcutLabel?: string | null;
  onToggleBrowser: () => void;
  onToggleDiff: () => void;
  onToggleFiles: () => void;
  onToggleGit: () => void;
  onToggleKanban: () => void;
  onToggleNotes: () => void;
  onToggleTerminal: () => void;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
}

export function RightPanelLauncher({
  browserShortcutLabel,
  diffShortcutLabel,
  filesShortcutLabel,
  gitShortcutLabel,
  hasActiveProject,
  isGitRepo,
  kanbanShortcutLabel,
  notesShortcutLabel,
  onToggleBrowser,
  onToggleDiff,
  onToggleFiles,
  onToggleGit,
  onToggleKanban,
  onToggleNotes,
  onToggleTerminal,
  terminalAvailable,
  terminalShortcutLabel,
}: RightPanelLauncherProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="grid w-full max-w-md grid-cols-3 gap-x-4 gap-y-6">
        <LauncherCard
          description="Open a website"
          icon={GlobeIcon}
          kind="browser"
          label="Browser"
          onSelect={onToggleBrowser}
          shortcutLabel={browserShortcutLabel}
        />
        <LauncherCard
          description="Browse project files"
          disabled={!hasActiveProject}
          icon={FoldersIcon}
          kind="files"
          label="Files"
          onSelect={onToggleFiles}
          shortcutLabel={filesShortcutLabel}
        />
        <LauncherCard
          description="Write markdown notes"
          icon={NotebookTextIcon}
          kind="notes"
          label="Notes"
          onSelect={onToggleNotes}
          shortcutLabel={notesShortcutLabel ?? null}
        />
        <LauncherCard
          description="Track work across columns"
          icon={Columns3Icon}
          kind="kanban"
          label="Kanban"
          onSelect={onToggleKanban}
          shortcutLabel={kanbanShortcutLabel ?? null}
        />
        <LauncherCard
          description="Start an interactive shell"
          disabled={!terminalAvailable}
          icon={TerminalIcon}
          kind="terminal"
          label="Terminal"
          onSelect={onToggleTerminal}
          shortcutLabel={terminalShortcutLabel}
        />
        <LauncherCard
          description="Inspect repo changes"
          disabled={!isGitRepo}
          icon={GitBranchIcon}
          kind="git"
          label="Git"
          onSelect={onToggleGit}
          shortcutLabel={gitShortcutLabel}
        />
        <LauncherCard
          description="View code changes"
          disabled={!isGitRepo}
          icon={DiffIcon}
          kind="diff"
          label="Diff"
          onSelect={onToggleDiff}
          shortcutLabel={diffShortcutLabel}
        />
      </div>
    </div>
  );
}
