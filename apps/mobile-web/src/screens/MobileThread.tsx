import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@bigbud/contracts";
import { deriveWorkLogEntries } from "@bigbud/shared/workLog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { deriveActiveWorkStartedAt } from "~/logic/session/session.logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "~/logic/user-input";

import { MobileWorkingIndicator } from "../components/threads/thread/composer/MobileWorkingIndicator";
import { MobileStartupSplash } from "../components/shell/MobileStartupSplash";
import {
  applyMobileUserInputCustomAnswer,
  MobileComposer,
  resolveMobileUserInputAnswers,
} from "../components/threads/thread/composer/MobileComposer";
import { MobileMessages } from "../components/threads/thread/MobileMessages";
import { MobileWorkLog } from "../components/threads/thread/MobileWorkLog";
import { useMobileServerConfig } from "../hooks/useMobileServerConfig";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { useMobileThread } from "../hooks/useMobileThread";
import { useMobileWorkingState } from "../hooks/useMobileWorkingState";
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
import { markThreadVisited } from "../lib/mobileThreadVisit";
import { useMobileSessionState } from "../context/MobileSessionContext";

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

  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledThreadIdRef = useRef<ThreadId | null>(null);

  const draftThread = useMemo(() => getMobileDraftThread(threadId), [threadId]);

  const snapshotThread = useMemo(
    () => snapshotQuery.data?.threads.find((candidate) => candidate.id === threadId) ?? null,
    [snapshotQuery.data, threadId],
  );

  const thread = threadQuery.data ?? snapshotThread;

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
  const isRunning = thread?.session?.status === "running";
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

  useLayoutEffect(() => {
    if (lastScrolledThreadIdRef.current === threadId) {
      return;
    }
    if (!thread) {
      return;
    }
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    lastScrolledThreadIdRef.current = threadId;
    const timeoutId = window.setTimeout(() => {
      const container = messagesScrollRef.current;
      if (container && container.isConnected) {
        container.scrollTop = container.scrollHeight;
      }
    }, 96);
    return () => window.clearTimeout(timeoutId);
  }, [threadId, thread]);

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
    await snapshotQuery.refetch();
  }, [client, snapshotQuery, threadId]);

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
          await snapshotQuery.refetch();
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
          messageId: newMessageId(),
          role: "user",
          text: trimmedPrompt,
          attachments: [],
        },
      });
      clearMobileDraftThread(threadId);
      setPendingModelSelection(null);
      setPrompt("");
      await snapshotQuery.refetch();
      return;
    }

    if (!thread) {
      return;
    }

    await client.dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
      modelSelection: selectedModelSelection,
      message: {
        messageId: newMessageId(),
        role: "user",
        text: trimmedPrompt,
        attachments: [],
      },
    });
    setPrompt("");
    await snapshotQuery.refetch();
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
    await snapshotQuery.refetch();
  }

  function handleToggleUserInputOption(questionId: string, optionLabel: string) {
    if (!activePendingUserInput) {
      return;
    }
    const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
    if (!question) {
      return;
    }
    setUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingUserInput.requestId]: {
        ...existing[activePendingUserInput.requestId],
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          existing[activePendingUserInput.requestId]?.[questionId],
          optionLabel,
        ),
      },
    }));
    setPrompt("");
  }

  function handleChangeUserInputCustomAnswer(questionId: string, value: string) {
    if (!activePendingUserInput) {
      return;
    }
    setUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingUserInput.requestId]: {
        ...existing[activePendingUserInput.requestId],
        [questionId]: setPendingUserInputCustomAnswer(
          existing[activePendingUserInput.requestId]?.[questionId],
          value,
        ),
      },
    }));
  }

  function handleAdvanceUserInput() {
    if (!activePendingUserInput) {
      return;
    }
    const progress = derivePendingUserInputProgress(
      activePendingUserInput.questions,
      activeUserInputAnswers,
      activeUserInputQuestionIndex,
    );
    if (progress.isLastQuestion) {
      void sendPrompt();
      return;
    }
    if (progress.canAdvance) {
      setUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: activeUserInputQuestionIndex + 1,
      }));
      setPrompt("");
    }
  }

  function handlePreviousUserInputQuestion() {
    if (!activePendingUserInput) {
      return;
    }
    setUserInputQuestionIndexByRequestId((existing) => ({
      ...existing,
      [activePendingUserInput.requestId]: Math.max(activeUserInputQuestionIndex - 1, 0),
    }));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={messagesScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-44 [scrollbar-gutter:stable]"
        >
          {workLogEntries.length > 0 ? (
            <div className="pt-3">
              <MobileWorkLog entries={workLogEntries} />
            </div>
          ) : null}
          <MobileMessages cwd={workspaceRoot} messages={messages} />
        </div>
        {showWorkingIndicator ? (
          <MobileWorkingIndicator
            activeWorkStartedAt={activeWorkStartedAt}
            nowIso={nowIso}
            verb={workingVerb}
          />
        ) : null}
      </div>

      <MobileComposer
        availableProviders={providers}
        isRespondingToUserInput={isRespondingToUserInput}
        isRunning={isRunning}
        lockedProvider={lockedProvider}
        modelSelection={selectedModelSelection}
        onAdvanceUserInput={handleAdvanceUserInput}
        onChange={setPrompt}
        onChangeUserInputCustomAnswer={handleChangeUserInputCustomAnswer}
        onModelSelectionChange={handleModelSelectionChange}
        onPreviousUserInputQuestion={handlePreviousUserInputQuestion}
        onProviderUnlock={() => setProviderUnlocked(true)}
        onRespondToApproval={(requestId, decision) => void respondToApproval(requestId, decision)}
        onSend={() => void sendPrompt()}
        onStop={() => void interruptTurn()}
        onToggleUserInputOption={handleToggleUserInputOption}
        pendingApproval={activePendingApproval}
        pendingUserInput={activePendingUserInput}
        placeholder="Ask anything, @tag files/folders, or use / commands"
        projectTitle={projectTitle}
        userInputAnswers={activeUserInputAnswers}
        userInputQuestionIndex={activeUserInputQuestionIndex}
        value={prompt}
        workingVerb={workingVerb}
      />
    </div>
  );
}
