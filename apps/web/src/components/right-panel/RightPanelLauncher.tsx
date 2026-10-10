import {
  Columns3Icon,
  DiffIcon,
  GitBranchIcon,
  GlobeIcon,
  NotebookTextIcon,
  TerminalIcon,
  ActivityIcon,
} from "lucide-react";

import { RightPanelFilesIcon } from "./RightPanel.filesIcon";
import { LauncherCard } from "./RightPanelLauncher.card";

export type LauncherToolKind =
  | "browser"
  | "diff"
  | "files"
  | "git"
  | "kanban"
  | "notes"
  | "system"
  | "terminal";

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
  onToggleSystem: () => void;
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
  onToggleSystem,
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
          icon={RightPanelFilesIcon}
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
        <LauncherCard
          description="See this computer's resources"
          icon={ActivityIcon}
          kind="system"
          label="System"
          onSelect={onToggleSystem}
          shortcutLabel={null}
        />
      </div>
    </div>
  );
}
