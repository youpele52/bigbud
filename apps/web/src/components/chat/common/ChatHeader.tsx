import type {
  EditorId,
  TerminalApplicationId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@bigbud/contracts";
import { SidebarLeft01Icon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import GitActionsControl from "../../git/GitActionsControl";
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
  isProjectThread?: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  availableTerminals?: ReadonlyArray<TerminalApplicationId>;
  executionTargetId?: string | undefined;
  sidebarToggleShortcutLabel: string | null;
  rightPanelToggleShortcutLabel: string | null;
  rightPanelOpen: boolean;
  planCardLabel: string;
  planCardOpen: boolean;
  onOpenOrchestra: () => void;
  onOpenSideChat?: (() => void) | undefined;
  sideChatDisabled?: boolean | undefined;
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
  isProjectThread,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  availableTerminals,
  executionTargetId,
  sidebarToggleShortcutLabel,
  rightPanelToggleShortcutLabel,
  rightPanelOpen,
  planCardLabel,
  planCardOpen,
  onOpenOrchestra,
  onOpenSideChat,
  sideChatDisabled,
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
  const resolvedIsProjectThread = isProjectThread ?? Boolean(activeProjectName);

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
          {resolvedIsProjectThread &&
            activeProjectScripts &&
            activeProjectScripts.length > 0 &&
            openInCwd && (
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
          {resolvedIsProjectThread && openInCwd && (
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              availableTerminals={availableTerminals ?? []}
              openInCwd={openInCwd}
            />
          )}
          <GitActionsControl
            gitCwd={openInCwd}
            isProjectThread={resolvedIsProjectThread}
            executionTargetId={executionTargetId}
            activeThreadId={activeThreadId}
            onOpenOrchestra={onOpenOrchestra}
            onOpenSideChat={onOpenSideChat}
            sideChatDisabled={sideChatDisabled}
            planCardLabel={planCardLabel}
            planCardOpen={planCardOpen}
            onTogglePlanCard={onTogglePlanCard}
          />
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
                    <HugeiconsIcon
                      aria-hidden="true"
                      className="size-3.5"
                      icon={SidebarLeft01Icon}
                      size={14}
                      strokeWidth={1.5}
                    />
                  ) : (
                    <HugeiconsIcon
                      aria-hidden="true"
                      className="size-3.5"
                      icon={SidebarLeftIcon}
                      size={14}
                      strokeWidth={1.5}
                    />
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
