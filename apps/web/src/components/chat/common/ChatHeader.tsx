import type {
  EditorId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@bigbud/contracts";
import { memo } from "react";
import GitActionsControl from "../../git/GitActionsControl";
import { PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
} from "../../project/ProjectScriptsControl";
import { Toggle } from "../../ui/toggle";
import { useSidebar } from "../../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { RightPanelToggleButton } from "./RightPanelLauncherMenu";
import { useIsThreadCompacting, useIsThreadRunning } from "../../../stores/main";
import { truncateThreadName } from "../../sidebar/Sidebar.logic";
import { ContentPanelHeaderBar } from "../../layout/ContentPanelHeaderBar";
import { ThreadActivityDots, threadActivityLabel } from "./threadActivityIndicator";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  executionTargetId?: string | undefined;
  sidebarToggleShortcutLabel: string | null;
  rightPanelToggleShortcutLabel: string | null;
  rightPanelOpen: boolean;
  planCardLabel: string;
  planCardOpen: boolean;
  onOpenOrchestra: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onTogglePlanCard: () => void;
  onToggleRightPanel: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  executionTargetId,
  sidebarToggleShortcutLabel,
  rightPanelToggleShortcutLabel,
  rightPanelOpen,
  planCardLabel,
  planCardOpen,
  onOpenOrchestra,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onTogglePlanCard,
  onToggleRightPanel,
}: ChatHeaderProps) {
  const isThreadRunning = useIsThreadRunning(activeThreadId);
  const isThreadCompacting = useIsThreadCompacting(activeThreadId);
  const { open: sidebarOpen, toggleSidebar } = useSidebar();
  const activityTone = isThreadCompacting ? "compacting" : isThreadRunning ? "running" : null;

  return (
    <ContentPanelHeaderBar
      title={
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeProjectName && `${activeProjectName} > `}
          <span className="text-muted-foreground">
            {truncateThreadName(activeThreadTitle)}
            <span className="ml-3">
              {activityTone && (
                <span
                  aria-hidden="true"
                  title={threadActivityLabel(activityTone)}
                  className="inline-flex items-center gap-[3px] pr-1"
                >
                  <ThreadActivityDots tone={activityTone} dotClassName="h-1 w-1" />
                </span>
              )}
            </span>
          </span>
        </h2>
      }
      actions={
        <>
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
          {openInCwd && (
            <GitActionsControl
              gitCwd={openInCwd}
              executionTargetId={executionTargetId}
              activeThreadId={activeThreadId}
              onOpenOrchestra={onOpenOrchestra}
              planCardLabel={planCardLabel}
              planCardOpen={planCardOpen}
              onTogglePlanCard={onTogglePlanCard}
            />
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={sidebarOpen}
                  onPressedChange={toggleSidebar}
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
          <RightPanelToggleButton
            rightPanelOpen={rightPanelOpen}
            rightPanelToggleShortcutLabel={rightPanelToggleShortcutLabel}
            onToggle={onToggleRightPanel}
          />
        </>
      }
    />
  );
});
