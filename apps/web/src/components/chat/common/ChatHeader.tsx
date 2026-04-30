import type {
  EditorId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@bigbud/contracts";
import { memo } from "react";
import GitActionsControl from "../../git/GitActionsControl";
import {
  DiffIcon,
  GlobeIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SearchIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
} from "../../project/ProjectScriptsControl";
import { Toggle } from "../../ui/toggle";
import { useSidebar } from "../../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { useIsThreadRunning } from "../../../stores/main";
import { truncateThreadName } from "../../sidebar/Sidebar.logic";
import { useBrowserPanelStore } from "../../../stores/browser/browser.store";
import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  sidebarToggleShortcutLabel: string | null;
  searchToggleShortcutLabel: string | null;
  browserToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  browserOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onToggleSearch: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  sidebarToggleShortcutLabel,
  searchToggleShortcutLabel,
  browserToggleShortcutLabel,
  gitCwd,
  diffOpen,
  browserOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
  onToggleBrowser,
  onToggleSearch,
}: ChatHeaderProps) {
  const isThreadRunning = useIsThreadRunning(activeThreadId);
  const {
    open: sidebarOpen,
    toggleSidebar: rawToggleSidebar,
    setOpen: setSidebarOpen,
  } = useSidebar();
  const setBrowserOpen = useBrowserPanelStore((state) => state.setOpen);

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      {/* Sidebar width spacer when closed to maintain layout balance */}
      {!sidebarOpen && (
        <div
          className={cn(
            "hidden shrink-0 md:block",
            isElectron ? "w-20" : "h-0 w-[calc(3rem+1rem)]",
          )}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden sm:gap-3">
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeProjectName && `${activeProjectName} > `}
          <span className="text-muted-foreground">
            {truncateThreadName(activeThreadTitle)}
            <span className="ml-3">
              {isThreadRunning && (
                <span
                  aria-hidden="true"
                  title="Agent is working"
                  className="inline-flex items-center gap-[3px] pr-1"
                >
                  <span
                    aria-hidden="true"
                    className="h-1 w-1 animate-pulse rounded-full bg-primary"
                  />
                  <span
                    aria-hidden="true"
                    className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:200ms]"
                  />
                  <span
                    aria-hidden="true"
                    className="h-1 w-1 animate-pulse rounded-full bg-primary [animation-delay:400ms]"
                  />
                </span>
              )}
            </span>
          </span>
        </h2>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {activeProjectScripts && activeProjectScripts.length > 0 && openInCwd && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && openInCwd && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && gitCwd && (
          <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={false}
                onPressedChange={onToggleSearch}
                aria-label="Search"
                variant="toolbar"
                size="xs"
              >
                <SearchIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            Search
            {searchToggleShortcutLabel && <> ({searchToggleShortcutLabel})</>}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={sidebarOpen}
                onPressedChange={() => {
                  if (!sidebarOpen) {
                    setBrowserOpen(false);
                  }
                  rawToggleSidebar();
                }}
                aria-label="Toggle sidebar"
                variant="toolbar"
                size="xs"
              >
                {sidebarOpen ? (
                  <PanelLeftCloseIcon className="size-3" />
                ) : (
                  <PanelLeftIcon className="size-3" />
                )}
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            {sidebarToggleShortcutLabel && <> ({sidebarToggleShortcutLabel})</>}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={browserOpen}
                onPressedChange={() => {
                  if (!browserOpen) {
                    setSidebarOpen(false);
                  }
                  onToggleBrowser();
                }}
                aria-label="Toggle browser panel"
                variant="toolbar"
                size="xs"
              >
                <GlobeIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {browserToggleShortcutLabel
              ? `Toggle browser panel (${browserToggleShortcutLabel})`
              : "Toggle browser panel"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="toolbar"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="toolbar"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
