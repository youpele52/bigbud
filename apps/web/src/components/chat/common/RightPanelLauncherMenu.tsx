import {
  CheckIcon,
  DiffIcon,
  FoldersIcon,
  GlobeIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  TerminalIcon,
} from "lucide-react";

import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { cn } from "~/lib/utils";

export type RightPanelLauncherKind = "browser" | "diff" | "files" | "terminal";

interface RightPanelLauncherMenuProps {
  activeKind: RightPanelLauncherKind | null;
  browserToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  filesToggleShortcutLabel: string | null;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  onToggleBrowser: () => void;
  onToggleDiff: () => void;
  onToggleFiles: () => void;
  onToggleTerminal: () => void;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
}

interface LauncherItemProps {
  active: boolean;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcutLabel: string | null;
  onSelect: () => void;
}

function LauncherItem({
  active,
  disabled = false,
  icon: Icon,
  label,
  shortcutLabel,
  onSelect,
}: LauncherItemProps) {
  return (
    <MenuItem disabled={disabled} onClick={onSelect}>
      <CheckIcon className={cn("size-3.5", active ? "opacity-100" : "opacity-0")} />
      <Icon className="size-3.5" />
      <span>{label}</span>
      {shortcutLabel ? <MenuShortcut>{shortcutLabel}</MenuShortcut> : null}
    </MenuItem>
  );
}

export function RightPanelLauncherMenu({
  activeKind,
  browserToggleShortcutLabel,
  diffToggleShortcutLabel,
  filesToggleShortcutLabel,
  hasActiveProject,
  isGitRepo,
  onToggleBrowser,
  onToggleDiff,
  onToggleFiles,
  onToggleTerminal,
  terminalAvailable,
  terminalShortcutLabel,
}: RightPanelLauncherMenuProps) {
  const hasOpenPanel = activeKind !== null;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="Open right panel tools"
                  aria-pressed={hasOpenPanel}
                  className={cn(hasOpenPanel ? "bg-secondary text-foreground" : undefined)}
                  size="icon-xs"
                  variant="toolbar"
                >
                  {hasOpenPanel ? (
                    <PanelRightCloseIcon className="size-3" />
                  ) : (
                    <PanelRightIcon className="size-3" />
                  )}
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">
          {hasOpenPanel ? "Switch right panel tool" : "Open right panel tools"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-48">
        <LauncherItem
          active={activeKind === "browser"}
          icon={GlobeIcon}
          label="Browser"
          onSelect={onToggleBrowser}
          shortcutLabel={browserToggleShortcutLabel}
        />
        <LauncherItem
          active={activeKind === "files"}
          disabled={!hasActiveProject}
          icon={FoldersIcon}
          label="Files"
          onSelect={onToggleFiles}
          shortcutLabel={filesToggleShortcutLabel}
        />
        <LauncherItem
          active={activeKind === "terminal"}
          disabled={!terminalAvailable}
          icon={TerminalIcon}
          label="Terminal"
          onSelect={onToggleTerminal}
          shortcutLabel={terminalShortcutLabel}
        />
        <LauncherItem
          active={activeKind === "diff"}
          disabled={!isGitRepo}
          icon={DiffIcon}
          label="Diff"
          onSelect={onToggleDiff}
          shortcutLabel={diffToggleShortcutLabel}
        />
      </MenuPopup>
    </Menu>
  );
}
