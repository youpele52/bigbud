import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@bigbud/contracts";
import { deriveWorkLogEntries } from "@bigbud/shared/workLog";
import { useCallback, useEffect, useMemo, useState } from "react";

import { deriveActiveWorkStartedAt } from "~/logic/session/session.logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "~/logic/user-input";

import { MobileStartupSplash } from "../components/shell/MobileStartupSplash";
import {
  applyMobileUserInputCustomAnswer,
  resolveMobileUserInputAnswers,
} from "../components/threads/thread/composer/MobileComposer";
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
import { buildMobileCreateThreadBootstrap } from "../logic/mobileNewThread.logic";
import { deriveUserTurnAnchorsFromThreadMessages } from "../logic/mobileReaderPosition.logic";
import { markThreadVisited } from "../lib/mobileThreadVisit";
import { resolveWorkspaceExecutionTargetId } from "~/lib/providerExecutionTargets";
import { useMobileSessionState } from "../context/MobileSessionContext";
import { useMobileThreadScroll } from "./MobileThread.scroll";
import { MobileThreadView } from "./MobileThread.view";
import { createMobileUserInputHandlers } from "./MobileThread.userInput";

function newId() {
  return crypto.randomUUID();
}

function newCommandId() {
  return CommandId.makeUnsafe(newId());
}

function newMessageId() {
  return MessageId.makeUnsafe(newId());
}

function resolveDraftWorkspaceRoot(
  snapshot: NonNullable<ReturnType<typeof useMobileSnapshot>["snapshotQuery"]["data"]>,
  draft: MobileDraftThread,
): string | undefined {
  const project = snapshot.projects.find((candidate) => candidate.id === draft.projectId);
  return draft.worktreePath ?? project?.workspaceRoot ?? undefined;
}

export function MobileThread({ threadId }: { threadId: ThreadId }) {
  const { session } = useMobileSessionState();
  const { client, snapshotQuery } = useMobileSnapshot(session);
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

  const interruptTurn = useCallback(async () => {
    if (!client) {
      return;
    }
    await client.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
    await Promise.all([snapshotQuery.refetch(), threadQuery.refetch()]);
  }, [client, snapshotQuery, threadId, threadQuery]);

  if (!session) {
    return <p className="px-1 py-8 text-sm text-muted-foreground">This phone is not paired yet.</p>;
  }

  const snapshot = snapshotQuery.data;
  const isDraft = thread === null && draftThread !== null;

  if (!thread && !isDraft) {
    if (threadQuery.isLoading) {
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

  if (!snapshot) {
    return <MobileStartupSplash className="min-h-[calc(100dvh-5rem)]" />;
  }

  const projectId = thread?.projectId ?? draftThread!.projectId;
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  const projectTitle = project?.title ?? "Unknown project";
  const workspaceRoot = thread
    ? resolveThreadWorkspaceRoot(snapshot, thread)
    : draftThread
      ? resolveDraftWorkspaceRoot(snapshot, draftThread)
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

  const handleModelSelectionChange = useCallback(
    (next: ModelSelection) => {
      if (lockedProvider !== null && next.provider !== lockedProvider && project) {
        startNewThread(project.id, next);
        return;
      }
      setPendingModelSelection(next);
    },
    [lockedProvider, project, startNewThread],
  );

  async function sendPrompt() {
    if (!client) {
      return;
    }

    if (activePendingUserInput) {
      const progress = derivePendingUserInputProgress(
        activePendingUserInput.questions,
        activeUserInputAnswers,
        activeUserInputQuestionIndex,
      );
      const draftAnswers = { ...activeUserInputAnswers };
      if (progress.activeQuestion && prompt.trim().length > 0) {
        draftAnswers[progress.activeQuestion.id] = applyMobileUserInputCustomAnswer(
          draftAnswers[progress.activeQuestion.id],
          prompt,
        );
      }

      if (progress.isLastQuestion) {
        const answers = resolveMobileUserInputAnswers(activePendingUserInput, draftAnswers);
        if (!answers) {
          return;
        }
        setIsRespondingToUserInput(true);
        try {
          await client.dispatchCommand({
            type: "thread.user-input.respond",
            commandId: newCommandId(),
            threadId,
            requestId: activePendingUserInput.requestId,
            answers,
            createdAt: new Date().toISOString(),
          });
          setPrompt("");
          setUserInputAnswersByRequestId((existing) => {
            const next = { ...existing };
            delete next[activePendingUserInput.requestId];
            return next;
          });
          setUserInputQuestionIndexByRequestId((existing) => {
            const next = { ...existing };
            delete next[activePendingUserInput.requestId];
            return next;
          });
          await Promise.all([snapshotQuery.refetch(), threadQuery.refetch()]);
        } finally {
          setIsRespondingToUserInput(false);
        }
      } else if (progress.canAdvance) {
        setUserInputQuestionIndexByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: activeUserInputQuestionIndex + 1,
        }));
        setPrompt("");
      }
      return;
    }

    if (prompt.trim().length === 0) {
      return;
    }

    const trimmedPrompt = prompt.trim();
    const createdAt = new Date().toISOString();
    const messageId = newMessageId();

    if (isDraft && draftThread && project) {
      await client.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        runtimeMode: draftThread.runtimeMode,
        interactionMode: draftThread.interactionMode,
        createdAt,
        modelSelection: selectedModelSelection,
        bootstrap: buildMobileCreateThreadBootstrap({
          project,
          promptText: trimmedPrompt,
          createdAt: draftThread.createdAt,
          branch: draftThread.branch,
          worktreePath: draftThread.worktreePath,
          runtimeMode: draftThread.runtimeMode,
          interactionMode: draftThread.interactionMode,
          modelSelection: selectedModelSelection,
        }),
        message: {
          messageId,
          role: "user",
          text: trimmedPrompt,
          attachments: [],
        },
      });
      clearMobileDraftThread(threadId);
      setPendingModelSelection(null);
      setPrompt("");
      await Promise.all([snapshotQuery.refetch(), threadQuery.refetch()]);
      return;
    }

    if (!thread) {
      return;
    }

    await client.dispatchCommand({
      type: "thread.message.submit",
      commandId: newCommandId(),
      threadId,
      createdAt,
      delivery: "auto",
      message: {
        messageId,
        text: trimmedPrompt,
      },
    });
    setPrompt("");
    await Promise.all([snapshotQuery.refetch(), threadQuery.refetch()]);
  }

  async function respondToApproval(
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    if (!client) {
      return;
    }
    await client.dispatchCommand({
      type: "thread.approval.respond",
      commandId: newCommandId(),
      threadId,
      requestId,
      decision,
      createdAt: new Date().toISOString(),
    });
    await Promise.all([snapshotQuery.refetch(), threadQuery.refetch()]);
  }

  const userInputHandlers = createMobileUserInputHandlers({
    activeAnswers: activeUserInputAnswers,
    activePendingUserInput,
    activeQuestionIndex: activeUserInputQuestionIndex,
    sendPrompt,
    setAnswersByRequestId: setUserInputAnswersByRequestId,
    setPrompt,
    setQuestionIndexByRequestId: setUserInputQuestionIndexByRequestId,
  });

  return (
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
        onRespondToApproval: (requestId, decision) => void respondToApproval(requestId, decision),
        onSend: () => void sendPrompt(),
        onStop: () => void interruptTurn(),
        onToggleUserInputOption: userInputHandlers.toggleOption,
        pendingApproval: activePendingApproval,
        pendingUserInput: activePendingUserInput,
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
  );
}
