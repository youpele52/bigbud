import { DiffIcon, FoldersIcon, GitBranchIcon, GlobeIcon, TerminalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Kbd, KbdGroup } from "../ui/kbd";

export type LauncherToolKind = "browser" | "diff" | "files" | "git" | "terminal";

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
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card p-6 text-center transition-colors",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Icon className="size-6 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="text-xs text-muted-foreground">{description}</div>
      {shortcutLabel && (
        <KbdGroup className="mt-1">
          <Kbd>{shortcutLabel}</Kbd>
        </KbdGroup>
      )}
    </button>
  );
}

interface RightPanelLauncherProps {
  browserShortcutLabel: string | null;
  diffShortcutLabel: string | null;
  filesShortcutLabel: string | null;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  onToggleBrowser: () => void;
  onToggleDiff: () => void;
  onToggleFiles: () => void;
  onToggleGit: () => void;
  onToggleTerminal: () => void;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
}

export function RightPanelLauncher({
  browserShortcutLabel,
  diffShortcutLabel,
  filesShortcutLabel,
  hasActiveProject,
  isGitRepo,
  onToggleBrowser,
  onToggleDiff,
  onToggleFiles,
  onToggleGit,
  onToggleTerminal,
  terminalAvailable,
  terminalShortcutLabel,
}: RightPanelLauncherProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="grid w-full max-w-md grid-cols-2 gap-3">
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
          description="Start an interactive shell"
          disabled={!terminalAvailable}
          icon={TerminalIcon}
          kind="terminal"
          label="Terminal"
          onSelect={onToggleTerminal}
          shortcutLabel={terminalShortcutLabel}
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
        {isGitRepo ? (
          <LauncherCard
            description="Inspect repo changes"
            icon={GitBranchIcon}
            kind="git"
            label="Git"
            onSelect={onToggleGit}
            shortcutLabel={null}
          />
        ) : null}
      </div>
    </div>
  );
}
