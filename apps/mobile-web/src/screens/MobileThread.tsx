import { type ModelSelection, type ThreadId } from "@bigbud/contracts";
import { deriveWorkLogEntries } from "@bigbud/shared/workLog";
import { useEffect, useMemo, useState } from "react";

import { deriveActiveWorkStartedAt } from "~/logic/session/session.logic";
import { MobileStartupSplash } from "../components/shell/MobileStartupSplash";
import { useMobileServerConfig } from "../hooks/useMobileServerConfig";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { useMobileThread } from "../hooks/useMobileThread";
import { useMobileWorkingState } from "../hooks/useMobileWorkingState";
import { useMobileGitStatus } from "../hooks/useMobileGitStatus";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import { makeMobileComposerDraftIdentity } from "../lib/mobileDraftThread";
import {
  isMobileComposerModelLocked,
  resolveMobileComposerModelSelection,
  resolveMobileLockedProvider,
} from "../logic/mobileModelSelection.logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  resolveThreadWorkspaceRoot,
} from "../lib/mobileModels";
import { deriveUserTurnAnchorsFromThreadMessages } from "../logic/mobileReaderPosition.logic";
import { createMobileThreadCommands } from "./MobileThread.commands";
import { markThreadVisited } from "../lib/mobileThreadVisit";
import { resolveWorkspaceExecutionTargetId } from "~/lib/providerExecutionTargets";
import { useMobileSessionState } from "../context/MobileSessionContext";
import { useMobileThreadScroll } from "./MobileThread.scroll";
import { MobileThreadView } from "./MobileThread.view";
import { createMobileUserInputHandlers } from "./MobileThread.userInput";
import { describeRecoveryReason } from "../logic/mobileRecovery.types";
import { isMobileConnectionActionsBlocked } from "../components/shell/MobileConnectionNotice.logic";
import { redactMobileText } from "../lib/mobileRedaction";
import { useMobileThreadState } from "./MobileThread.state";
import { resolveDraftWorkspaceRoot } from "./MobileThread.workspace";
import { useMobileThreadDelivery } from "./MobileThread.delivery";

export function MobileThread({ threadId }: { threadId: ThreadId }) {
  const { session } = useMobileSessionState();
  const { client, connection, recovery, recoveryState, restart, snapshotQuery } =
    useMobileSnapshot(session);
  const { threadQuery, threadError } = useMobileThread(session, threadId);
  const { providers } = useMobileServerConfig(session);
  const { startNewThread } = useMobileNewThread();
  const [isRespondingToUserInput, setIsRespondingToUserInput] = useState(false);
  const [providerUnlocked, setProviderUnlocked] = useState(false);
  const composerIdentity = useMemo(
    () =>
      session
        ? makeMobileComposerDraftIdentity({
            backendBaseUrl: session.backendBaseUrl,
            sessionId: session.sessionId,
            threadId,
          })
        : null,
    [session, threadId],
  );
  const composerState = useMobileThreadState({ identity: composerIdentity, threadId });
  const composerIdentityKey = composerIdentity
    ? `${composerIdentity.backendOrigin}:${composerIdentity.sessionId}:${composerIdentity.threadId}`
    : threadId;
  const { delivery, decisionDelivery } = useMobileThreadDelivery({
    identity: composerIdentityKey,
    onStateChange: composerState.setDeliveryState,
    submitted: composerState.submitted,
  });
  const draftThread = composerState.draftThread;
  const prompt = composerState.prompt;
  const clearNewThread = composerState.clearNewThread;

  const snapshotThread = useMemo(
    () => snapshotQuery.data?.threads.find((candidate) => candidate.id === threadId) ?? null,
    [snapshotQuery.data, threadId],
  );

  const thread = threadQuery.data ?? snapshotThread;

  const composerProject = useMemo(() => {
    const snapshot = snapshotQuery.data;
    if (!snapshot) {
      return null;
    }
    const projectId = thread?.projectId ?? draftThread?.projectId;
    if (!projectId) {
      return null;
    }
    return snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
  }, [draftThread, snapshotQuery.data, thread]);

  const composerWorkspaceRoot = useMemo(() => {
    const snapshot = snapshotQuery.data;
    if (!snapshot) {
      return undefined;
    }
    if (thread) {
      return resolveThreadWorkspaceRoot(snapshot, thread);
    }
    if (draftThread) {
      return resolveDraftWorkspaceRoot(snapshot, draftThread);
    }
    return undefined;
  }, [draftThread, snapshotQuery.data, thread]);

  const gitStatusQuery = useMobileGitStatus(
    composerWorkspaceRoot ?? null,
    composerProject ? resolveWorkspaceExecutionTargetId(composerProject) : null,
  );

  const approvals = useMemo(
    () => (thread ? derivePendingApprovals(thread.activities) : []),
    [thread],
  );
  const pendingUserInputs = useMemo(
    () => (thread ? derivePendingUserInputs(thread.activities) : []),
    [thread],
  );
  const workLogEntries = useMemo(
    () => (thread ? deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId) : []),
    [thread],
  );
  const activePendingApproval = approvals[0] ?? null;
  const activePendingUserInput = !activePendingApproval ? (pendingUserInputs[0] ?? null) : null;
  const isRunning =
    thread?.session?.status === "running" &&
    (thread.session.activeTurnId === null ||
      thread.latestTurn?.turnId !== thread.session.activeTurnId ||
      thread.latestTurn.completedAt === null);
  const showWorkingIndicator =
    isRunning && activePendingApproval === null && activePendingUserInput === null;
  const { workingVerb, nowIso } = useMobileWorkingState(showWorkingIndicator);

  const activeUserInputAnswers = activePendingUserInput
    ? (composerState.userInputAnswersByRequestId[activePendingUserInput.requestId] ?? {})
    : {};
  const activeUserInputQuestionIndex = activePendingUserInput
    ? (composerState.userInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activeUserInputQuestion = activePendingUserInput?.questions[activeUserInputQuestionIndex];
  const composerValue = activePendingUserInput
    ? activeUserInputQuestion
      ? (activeUserInputAnswers[activeUserInputQuestion.id]?.customAnswer ?? "")
      : ""
    : composerState.prompt;

  useEffect(() => {
    if (thread) {
      clearNewThread();
      markThreadVisited(threadId);
    }
  }, [clearNewThread, thread, threadId]);

  useEffect(() => {
    setProviderUnlocked(false);
  }, [threadId]);

  const isLocked = isMobileComposerModelLocked(thread, draftThread);
  const lockedProvider =
    isLocked && !providerUnlocked ? resolveMobileLockedProvider(thread, draftThread) : null;

  const userTurnAnchors = useMemo(
    () => deriveUserTurnAnchorsFromThreadMessages(thread?.messages ?? []),
    [thread?.messages],
  );

  const { isFollowing, messagesScrollRef, readerPosition, scrollToLatest, scrollToMessage } =
    useMobileThreadScroll({
      messages: thread?.messages ?? [],
      threadId,
      threadLoaded: thread !== null,
      userTurnAnchorCount: userTurnAnchors.length,
    });

  if (!session) {
    return <p className="px-1 py-8 text-sm text-muted-foreground">This phone is not paired yet.</p>;
  }

  const snapshot = snapshotQuery.data;
  const isDraft = thread === null && draftThread !== null;
  const selectedThreadStatus =
    recoveryState.selectedThreadId === threadId ? recoveryState.selectedThreadStatus : "unknown";
  const selectedThreadUnavailable =
    !isDraft &&
    !thread &&
    recoveryState.freshness !== "refreshing" &&
    (selectedThreadStatus === "missing" ||
      selectedThreadStatus === "deleted" ||
      selectedThreadStatus === "present");

  if (!thread && !isDraft) {
    if (selectedThreadUnavailable) {
      return (
        <div className="grid gap-3 px-1 py-8">
          <p className="text-sm font-medium text-foreground">
            {selectedThreadStatus === "deleted" ? "Thread was deleted" : "Thread not found"}
          </p>
          <p className="text-sm text-muted-foreground">
            {selectedThreadStatus === "deleted"
              ? "This thread is no longer available on the desktop server."
              : "The selected thread is not available in this session."}
          </p>
        </div>
      );
    }
    if (
      (recoveryState.freshness === "unavailable" || recoveryState.freshness === "stale") &&
      recoveryState.reason !== null
    ) {
      return (
        <div className="grid gap-3 px-1 py-8">
          <p className="text-sm font-medium text-foreground">Unable to recover thread</p>
          <p className="text-sm text-muted-foreground">
            {describeRecoveryReason(recoveryState.reason)}
          </p>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-3 text-sm"
            onClick={() => restart()}
            type="button"
          >
            Retry
          </button>
        </div>
      );
    }
    if (recoveryState.freshness === "refreshing" || threadQuery.isPending) {
      return <MobileStartupSplash className="min-h-[calc(100dvh-5rem)]" />;
    }
    if (threadError) {
      return (
        <div className="grid gap-3 px-1 py-8">
          <p className="text-sm font-medium text-foreground">Unable to load thread</p>
          <p className="text-sm text-muted-foreground">{redactMobileText(threadError)}</p>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-3 text-sm"
            onClick={() => void threadQuery.refetch()}
            type="button"
          >
            Retry
          </button>
        </div>
      );
    }
    return <p className="px-1 py-8 text-sm text-muted-foreground">Thread not found.</p>;
  }

  if (!snapshot && !thread && !isDraft) {
    return <MobileStartupSplash className="min-h-[calc(100dvh-5rem)]" />;
  }

  const projectId = thread?.projectId ?? draftThread!.projectId;
  const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
  const projectTitle = project?.title ?? "Unknown project";
  const workspaceRoot = thread
    ? snapshot
      ? resolveThreadWorkspaceRoot(snapshot, thread)
      : (thread.worktreePath ?? undefined)
    : draftThread
      ? snapshot
        ? resolveDraftWorkspaceRoot(snapshot, draftThread)
        : (draftThread.worktreePath ?? undefined)
      : undefined;
  const messages = thread?.messages ?? [];
  const activeWorkStartedAt = thread
    ? deriveActiveWorkStartedAt(
        thread.latestTurn,
        thread.session
          ? {
              orchestrationStatus: thread.session.status,
              activeTurnId: thread.session.activeTurnId ?? undefined,
            }
          : null,
        null,
      )
    : null;
  const selectedModelSelection = resolveMobileComposerModelSelection(
    {
      thread,
      draft: draftThread,
      project: project ?? null,
      providers,
      isRunning,
    },
    composerState.pendingModelSelection,
  );

  const handleModelSelectionChange = (next: ModelSelection) => {
    if (lockedProvider !== null && next.provider !== lockedProvider && project) {
      startNewThread(project.id, next);
      return;
    }
    composerState.setPendingModelSelection(next);
  };

  const commands = createMobileThreadCommands({
    actionsAvailable: recoveryState.actionsAvailable,
    activePendingUserInput,
    activeUserInputAnswers,
    activeUserInputQuestionIndex,
    client,
    draftThread,
    isDraft,
    project,
    prompt,
    recovery,
    refetchSnapshot: snapshotQuery.refetch,
    refetchThread: threadQuery.refetch,
    selectedModelSelection,
    clearNewThread: composerState.clearNewThread,
    clearSubmittedIfRevision: composerState.clearSubmittedIfRevision,
    delivery,
    decisionDelivery,
    revision: composerState.revision,
    setIsRespondingToUserInput,
    setPendingModelSelection: composerState.setPendingModelSelection,
    setUserInputAnswersByRequestId: composerState.setUserInputAnswersByRequestId,
    setUserInputQuestionIndexByRequestId: composerState.setUserInputQuestionIndexByRequestId,
    thread,
    threadId,
  });

  const userInputHandlers = createMobileUserInputHandlers({
    activeAnswers: activeUserInputAnswers,
    activePendingUserInput,
    activeQuestionIndex: activeUserInputQuestionIndex,
    sendPrompt: commands.sendPrompt,
    setAnswersByRequestId: composerState.setUserInputAnswersByRequestId,
    setQuestionIndexByRequestId: composerState.setUserInputQuestionIndexByRequestId,
  });

  const handleComposerChange = (value: string) => {
    if (activePendingUserInput && activeUserInputQuestion) {
      userInputHandlers.changeCustomAnswer(activeUserInputQuestion.id, value);
      return;
    }
    composerState.setPrompt(value);
  };

  return (
    <div className="relative h-full">
      <MobileThreadView
        activeWorkStartedAt={activeWorkStartedAt}
        isFollowing={isFollowing}
        messages={messages}
        messagesScrollRef={messagesScrollRef}
        nowIso={nowIso}
        onRetryRecovery={() => restart()}
        onScrollToLatest={scrollToLatest}
        readerOutlineProps={{
          anchors: userTurnAnchors,
          currentAnchorMessageId: readerPosition.currentAnchorMessageId,
          onJumpToMessage: scrollToMessage,
        }}
        showWorkingIndicator={showWorkingIndicator}
        recoveryState={recoveryState}
        connection={connection}
        workingVerb={workingVerb}
        workLogEntries={workLogEntries}
        workspaceRoot={workspaceRoot}
        composerProps={{
          availableProviders: providers,
          isRespondingToUserInput: isRespondingToUserInput,
          isRunning,
          lockedProvider,
          modelSelection: selectedModelSelection,
          onAdvanceUserInput: userInputHandlers.advance,
          onChange: handleComposerChange,
          onCheckDelivery: () => void commands.checkDelivery(),
          onModelSelectionChange: handleModelSelectionChange,
          onPreviousUserInputQuestion: userInputHandlers.previous,
          onProviderUnlock: () => setProviderUnlocked(true),
          onRespondToApproval: (requestId, decision) =>
            void commands.respondToApproval(requestId, decision),
          onSend: () => void commands.sendPrompt(),
          onStop: () => void commands.interruptTurn(),
          onToggleUserInputOption: userInputHandlers.toggleOption,
          pendingApproval: activePendingApproval,
          pendingUserInput: activePendingUserInput,
          stateDependentActionsDisabled:
            isMobileConnectionActionsBlocked(connection, recoveryState) ||
            !recoveryState.actionsAvailable,
          deliveryState: delivery.getState().status,
          storageWarning: composerState.storageWarning,
          placeholder: "What are we working on?",
          projectTitle,
          isGitRepo: gitStatusQuery.data?.isRepo ?? false,
          activeThreadBranch: thread?.branch ?? draftThread?.branch ?? null,
          activeWorktreePath: thread?.worktreePath ?? draftThread?.worktreePath ?? null,
          currentGitBranch: gitStatusQuery.data?.branch ?? null,
          userInputAnswers: activeUserInputAnswers,
          userInputQuestionIndex: activeUserInputQuestionIndex,
          value: composerValue,
          workingVerb,
        }}
      />
    </div>
  );
}
