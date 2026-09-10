import { type ModelSelection, type ThreadId } from "@bigbud/contracts";
import { deriveWorkLogEntries } from "@bigbud/shared/workLog";
import { useEffect, useMemo, useState } from "react";

import { deriveActiveWorkStartedAt } from "~/logic/session/session.logic";
import type { PendingUserInputDraftAnswer } from "~/logic/user-input";

import { MobileStartupSplash } from "../components/shell/MobileStartupSplash";
import { MobileRecoveryStatus } from "../components/shell/MobileRecoveryStatus";
import { useMobileServerConfig } from "../hooks/useMobileServerConfig";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { useMobileThread } from "../hooks/useMobileThread";
import { useMobileWorkingState } from "../hooks/useMobileWorkingState";
import { useMobileGitStatus } from "../hooks/useMobileGitStatus";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import {
  clearMobileDraftThread,
  getMobileDraftThread,
  type MobileDraftThread,
} from "../lib/mobileDraftThread";
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

function resolveDraftWorkspaceRoot(
  snapshot: NonNullable<ReturnType<typeof useMobileSnapshot>["snapshotQuery"]["data"]>,
  draft: MobileDraftThread,
): string | undefined {
  const project = snapshot.projects.find((candidate) => candidate.id === draft.projectId);
  return draft.worktreePath ?? project?.workspaceRoot ?? undefined;
}

export function MobileThread({ threadId }: { threadId: ThreadId }) {
  const { session } = useMobileSessionState();
  const { client, recovery, recoveryState, snapshotQuery } = useMobileSnapshot(session);
  const { threadQuery, threadError } = useMobileThread(session, threadId);
  const { providers } = useMobileServerConfig(session);
  const { startNewThread } = useMobileNewThread();
  const [prompt, setPrompt] = useState("");
  const [userInputAnswersByRequestId, setUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [userInputQuestionIndexByRequestId, setUserInputQuestionIndexByRequestId] = useState<
    Record<string, number>
  >({});
  const [isRespondingToUserInput, setIsRespondingToUserInput] = useState(false);
  const [pendingModelSelection, setPendingModelSelection] = useState<ModelSelection | null>(null);
  const [providerUnlocked, setProviderUnlocked] = useState(false);
  const draftThread = useMemo(() => getMobileDraftThread(threadId), [threadId]);

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
    ? (userInputAnswersByRequestId[activePendingUserInput.requestId] ?? {})
    : {};
  const activeUserInputQuestionIndex = activePendingUserInput
    ? (userInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;

  useEffect(() => {
    if (thread) {
      clearMobileDraftThread(threadId);
      markThreadVisited(threadId);
    }
  }, [thread, threadId]);

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

  const { messagesScrollRef, readerPosition, scrollToMessage } = useMobileThreadScroll({
    isRunning,
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
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm"
            onClick={() =>
              void (recovery ? recovery.selectThread(threadId) : threadQuery.refetch())
            }
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
          <p className="text-sm text-muted-foreground">{threadError}</p>
          <button
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm"
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
    pendingModelSelection,
  );

  const handleModelSelectionChange = (next: ModelSelection) => {
    if (lockedProvider !== null && next.provider !== lockedProvider && project) {
      startNewThread(project.id, next);
      return;
    }
    setPendingModelSelection(next);
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
    setIsRespondingToUserInput,
    setPendingModelSelection,
    setPrompt,
    setUserInputAnswersByRequestId,
    setUserInputQuestionIndexByRequestId,
    thread,
    threadId,
  });

  const userInputHandlers = createMobileUserInputHandlers({
    activeAnswers: activeUserInputAnswers,
    activePendingUserInput,
    activeQuestionIndex: activeUserInputQuestionIndex,
    sendPrompt: commands.sendPrompt,
    setAnswersByRequestId: setUserInputAnswersByRequestId,
    setPrompt,
    setQuestionIndexByRequestId: setUserInputQuestionIndexByRequestId,
  });

  return (
    <div className="relative h-full">
      {recoveryState.freshness === "stale" || recoveryState.freshness === "legacy" ? (
        <div className="pointer-events-auto absolute inset-x-2 top-2 z-30">
          <MobileRecoveryStatus
            onRetry={() =>
              void (recovery ? recovery.selectThread(threadId) : snapshotQuery.refetch())
            }
            state={recoveryState}
          />
        </div>
      ) : null}
      <MobileThreadView
        activeWorkStartedAt={activeWorkStartedAt}
        messages={messages}
        messagesScrollRef={messagesScrollRef}
        nowIso={nowIso}
        readerOutlineProps={{
          anchors: userTurnAnchors,
          currentAnchorMessageId: readerPosition.currentAnchorMessageId,
          onJumpToMessage: scrollToMessage,
        }}
        showWorkingIndicator={showWorkingIndicator}
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
          onChange: setPrompt,
          onChangeUserInputCustomAnswer: userInputHandlers.changeCustomAnswer,
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
          stateDependentActionsDisabled: !recoveryState.actionsAvailable,
          placeholder: "Ask anything, @tag files/folders, or use / commands",
          projectTitle,
          isGitRepo: gitStatusQuery.data?.isRepo ?? false,
          activeThreadBranch: thread?.branch ?? draftThread?.branch ?? null,
          activeWorktreePath: thread?.worktreePath ?? draftThread?.worktreePath ?? null,
          currentGitBranch: gitStatusQuery.data?.branch ?? null,
          userInputAnswers: activeUserInputAnswers,
          userInputQuestionIndex: activeUserInputQuestionIndex,
          value: prompt,
          workingVerb,
        }}
      />
    </div>
  );
}
