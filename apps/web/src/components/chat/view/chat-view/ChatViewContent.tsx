import { isBuiltInChatsProject } from "@bigbud/contracts";
import { useEffect, useState } from "react";

import { ContentPanelHeader } from "../../../layout/ContentPanelHeader";
import { ChatHeader } from "../../common/ChatHeader";
import { ExpandedImageOverlay } from "../../common/ExpandedImageOverlay";
import { openSideChat } from "../../side-chat/sideChat.actions";
import { PersistentThreadTerminalDrawer } from "../ChatView.terminalDrawer";
import { useRightPanelTabsStore } from "../../../../stores/rightPanel/rightPanelTabs.store";
import { resolveWorkspaceExecutionTargetId } from "../../../../lib/providerExecutionTargets";
import { useDefaultChatCwd } from "../../../../rpc/serverState";

import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import { type ChatViewTimelineState } from "./chat-view-timeline.hooks";
import { ChatViewOrchestraDialog } from "./ChatViewOrchestraDialog";
import { ChatViewChatBody } from "./ChatViewChatBody";
import type { useTerminalLayout } from "./terminalLayout.hooks";

interface ChatViewContentProps {
  base: ChatViewBaseState;
  thread: ChatViewThreadDerivedState;
  composer: ChatViewComposerDerivedState;
  timeline: ChatViewTimelineState;
  runtime: ChatViewRuntimeState;
  interactions: ChatViewInteractionsState;
  terminalLayout: ReturnType<typeof useTerminalLayout>;
}

export function ChatViewContent({
  base,
  thread,
  composer,
  timeline,
  runtime,
  interactions,
  terminalLayout,
}: ChatViewContentProps) {
  const rightPanelOpen = useRightPanelTabsStore((state) => state.rightPanelOpen);
  const [orchestraOpen, setOrchestraOpen] = useState(false);

  const projectWorkspaceExecutionTargetId = base.activeProject
    ? resolveWorkspaceExecutionTargetId(base.activeProject)
    : undefined;
  const defaultChatCwd = useDefaultChatCwd();
  const isChatThread = Boolean(base.activeProject && isBuiltInChatsProject(base.activeProject.id));

  // Prefer the active worktree path so proposed-plan saves land in the right
  // directory when a thread is running in a worktree rather than project root.
  const workspaceRoot =
    base.activeThread?.worktreePath ??
    base.activeProject?.cwd ??
    (isChatThread ? defaultChatCwd : undefined) ??
    undefined;

  // Auto-open the floating plan card when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  const { planCardOpen, planCardDismissedForTurnRef, setPlanCardOpen, activeLatestTurn } = base;
  useEffect(() => {
    if (!thread.activePlan) return;
    if (planCardOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && thread.activePlan.turnId !== latestTurnId) return;
    const turnKey = thread.activePlan.turnId ?? thread.cardProposedPlan?.turnId ?? "__dismissed__";
    if (planCardDismissedForTurnRef.current === turnKey) return;
    setPlanCardOpen(true);
  }, [
    thread.activePlan,
    activeLatestTurn?.turnId,
    planCardOpen,
    thread.cardProposedPlan?.turnId,
    planCardDismissedForTurnRef,
    setPlanCardOpen,
  ]);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background"
      data-chat-view-root
    >
      <ContentPanelHeader>
        <ChatHeader
          activeThreadId={base.activeThread!.id}
          activeThreadTitle={base.activeThread!.title}
          activeProjectName={base.activeProject?.name}
          isProjectThread={Boolean(base.activeProject) && !isChatThread}
          openInCwd={workspaceRoot ?? null}
          activeProjectScripts={base.activeProject?.scripts}
          preferredScriptId={interactions.preferredScriptId}
          keybindings={composer.keybindings}
          availableEditors={composer.availableEditors}
          availableTerminals={composer.availableTerminals}
          executionTargetId={projectWorkspaceExecutionTargetId}
          sidebarToggleShortcutLabel={composer.sidebarToggleShortcutLabel}
          rightPanelToggleShortcutLabel={composer.rightPanelToggleShortcutLabel}
          rightPanelOpen={rightPanelOpen}
          planCardLabel={thread.planCardLabel}
          planCardOpen={base.planCardOpen}
          terminalOpen={base.terminalState.terminalOpen}
          terminalLayoutNextActionLabel={terminalLayout.nextActionLabel}
          onOpenOrchestra={() => setOrchestraOpen(true)}
          onOpenSideChat={() => {
            void openSideChat(base.activeThread!);
          }}
          sideChatDisabled={!base.isServerThread}
          onRunProjectScript={(script) => {
            void runtime.terminalActions.runProjectScript(script);
          }}
          onAddProjectScript={runtime.projectScripts.saveProjectScript}
          onUpdateProjectScript={runtime.projectScripts.updateProjectScript}
          onDeleteProjectScript={runtime.projectScripts.deleteProjectScript}
          onTogglePlanCard={runtime.togglePlanCard}
          onOpenTerminal={terminalLayout.openTerminal}
          onCycleTerminalLayout={terminalLayout.cycleLayout}
          onToggleRightPanel={runtime.onToggleRightPanel}
        />
      </ContentPanelHeader>

      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-chat-body-region
        hidden={!terminalLayout.chatVisible}
        inert={!terminalLayout.chatVisible || undefined}
      >
        <ChatViewChatBody
          base={base}
          composer={composer}
          interactions={interactions}
          projectWorkspaceExecutionTargetId={projectWorkspaceExecutionTargetId}
          runtime={runtime}
          thread={thread}
          timeline={timeline}
          workspaceRoot={workspaceRoot}
          onOpenOrchestra={() => setOrchestraOpen(true)}
        />
      </div>

      {base.mountedTerminalThreadIds.map((mountedThreadId) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadId}
          threadId={mountedThreadId}
          visible={mountedThreadId === base.activeThreadId && base.terminalState.terminalOpen}
          presentation={
            mountedThreadId === base.activeThreadId ? terminalLayout.terminalPresentation : "hidden"
          }
          launchContext={
            mountedThreadId === base.activeThreadId
              ? (base.activeTerminalLaunchContext ?? null)
              : null
          }
          focusRequestId={mountedThreadId === base.activeThreadId ? base.terminalFocusRequestId : 0}
          splitShortcutLabel={composer.splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={composer.newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={composer.closeTerminalShortcutLabel ?? undefined}
          keybindings={composer.keybindings}
          onAddTerminalContext={runtime.addTerminalContextToDraft}
        />
      ))}

      {base.expandedImage ? (
        <ExpandedImageOverlay
          expandedImage={base.expandedImage}
          onClose={interactions.closeExpandedImage}
          onNavigate={interactions.navigateExpandedImage}
        />
      ) : null}

      <ChatViewOrchestraDialog
        base={base}
        composer={composer}
        open={orchestraOpen}
        onOpenChange={setOrchestraOpen}
      />
    </div>
  );
}
