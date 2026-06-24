import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "~/logic/user-input";

import {
  applyMobileUserInputCustomAnswer,
  MobileComposer,
  resolveMobileUserInputAnswers,
} from "../components/MobileComposer";
import { MobileMessages } from "../components/MobileMessages";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import {
  clearMobileDraftThread,
  getMobileDraftThread,
  type MobileDraftThread,
} from "../mobileDraftThread";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  resolveThreadWorkspaceRoot,
} from "../mobileModels";
import { buildMobileCreateThreadBootstrap } from "../mobileNewThread.logic";
import { markThreadVisited } from "../mobileThreadVisit";
import { useMobileSessionState } from "../MobileSessionContext";

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
  const [prompt, setPrompt] = useState("");
  const [userInputAnswersByRequestId, setUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [userInputQuestionIndexByRequestId, setUserInputQuestionIndexByRequestId] = useState<
    Record<string, number>
  >({});
  const [isRespondingToUserInput, setIsRespondingToUserInput] = useState(false);

  const draftThread = useMemo(() => getMobileDraftThread(threadId), [threadId]);

  const thread = useMemo(
    () => snapshotQuery.data?.threads.find((candidate) => candidate.id === threadId) ?? null,
    [snapshotQuery.data, threadId],
  );

  const approvals = useMemo(
    () => (thread ? derivePendingApprovals(thread.activities) : []),
    [thread],
  );
  const pendingUserInputs = useMemo(
    () => (thread ? derivePendingUserInputs(thread.activities) : []),
    [thread],
  );
  const activePendingApproval = approvals[0] ?? null;
  const activePendingUserInput = !activePendingApproval ? (pendingUserInputs[0] ?? null) : null;

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
    return <p className="px-1 py-8 text-sm text-muted-foreground">Thread not found.</p>;
  }

  if (!snapshot) {
    return <p className="px-1 py-8 text-sm text-muted-foreground">Loading thread…</p>;
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
  const isRunning = thread?.session?.status === "running";

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
        bootstrap: buildMobileCreateThreadBootstrap({
          project,
          promptText: trimmedPrompt,
          createdAt: draftThread.createdAt,
          branch: draftThread.branch,
          worktreePath: draftThread.worktreePath,
          runtimeMode: draftThread.runtimeMode,
          interactionMode: draftThread.interactionMode,
        }),
        message: {
          messageId: newMessageId(),
          role: "user",
          text: trimmedPrompt,
          attachments: [],
        },
      });
      clearMobileDraftThread(threadId);
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
    <div className="-mx-4 flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-44">
        <MobileMessages cwd={workspaceRoot} messages={messages} />
      </div>

      <MobileComposer
        isRespondingToUserInput={isRespondingToUserInput}
        isRunning={isRunning}
        onAdvanceUserInput={handleAdvanceUserInput}
        onChange={setPrompt}
        onChangeUserInputCustomAnswer={handleChangeUserInputCustomAnswer}
        onPreviousUserInputQuestion={handlePreviousUserInputQuestion}
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
      />
    </div>
  );
}
