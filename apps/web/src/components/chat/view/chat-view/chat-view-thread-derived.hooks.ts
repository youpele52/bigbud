import { useEffect, useMemo, useRef } from "react";

import {
  deriveActivePlanState,
  deriveActiveWorkStartedAt,
  derivePhase,
  derivePendingApprovals,
  derivePendingUserInputs,
  formatElapsed,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "../../../../logic/session";
import { useThreadPlanCatalog } from "../ChatView.modelSelection.logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
} from "../../../../logic/user-input";
import { deriveLatestContextWindowSnapshot } from "../../../../lib/contextWindow";
import { randomSpinnerVerb } from "../../../../utils/copy";
import { useLocalDispatchState } from "../ChatView.localDispatch.logic";
import {
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
} from "../../../../logic/session";
import { EMPTY_PENDING_USER_INPUT_ANSWERS } from "./shared";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";

export function useChatViewThreadDerivedState(base: ChatViewBaseState) {
  const {
    activeLatestTurn,
    activeThread,
    activeThreadId,
    activeThreadLastVisitedAt,
    existingOpenTerminalThreadIds,
    interactionMode,
    isConnecting,
    isRevertingCheckpoint,
    markThreadVisited,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    reconcileMountedTerminalThreadIds,
    serverThread,
    setMountedTerminalThreadIds,
    terminalState,
    threadId,
    nowTick,
  } = base;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds = [] as (typeof threadId)[];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );

  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThread?.activities ?? []),
    [activeThread?.activities],
  );

  useEffect(() => {
    setMountedTerminalThreadIds((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadIds,
        activeThreadId,
        activeThreadTerminalOpen: Boolean(activeThreadId && terminalState.terminalOpen),
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [
    activeThreadId,
    existingOpenTerminalThreadIds,
    reconcileMountedTerminalThreadIds,
    setMountedTerminalThreadIds,
    terminalState.terminalOpen,
  ]);

  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);

  useEffect(() => {
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(serverThread.id);
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.id,
  ]);

  const workLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(activeThread?.activities ?? [], activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, activeThread?.activities],
  );

  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(activeThread?.activities ?? [], activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, activeThread?.activities],
  );

  const pendingApprovals = useMemo(
    () => derivePendingApprovals(activeThread?.activities ?? []),
    [activeThread?.activities],
  );

  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(activeThread?.activities ?? []),
    [activeThread?.activities],
  );
  const isOpencodePendingUserInputMode = pendingUserInputs.length > 0;

  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );

  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);

  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );

  const activePlan = useMemo(
    () =>
      deriveActivePlanState(activeThread?.activities ?? [], activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, activeThread?.activities],
  );

  const showPlanFollowUpPrompt =
    !isOpencodePendingUserInputMode &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);

  // Show "Tasks" when the sidebar is displaying TodoWrite-driven step tracking
  // (no proposed plan markdown, not in plan-drafting mode). Show "Plan" when
  // there is a proposed plan or the thread is in plan interaction mode.
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";

  const activePendingApproval = pendingApprovals[0] ?? null;

  const phase = derivePhase(activeThread?.session ?? null);

  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });

  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const nowIso = new Date(nowTick).toISOString();
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );

  const workingVerbRef = useRef<string | null>(null);
  if (isWorking && workingVerbRef.current === null) {
    workingVerbRef.current = randomSpinnerVerb();
  } else if (!isWorking) {
    workingVerbRef.current = null;
  }
  const workingVerb = workingVerbRef.current ?? randomSpinnerVerb();
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState || (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const composerFooterHasWideActions = showPlanFollowUpPrompt;

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);

  return {
    threadPlanCatalog,
    activeContextWindow,
    latestTurnSettled,
    workLogEntries,
    latestTurnHasToolActivity,
    pendingApprovals,
    pendingUserInputs,
    isOpencodePendingUserInputMode,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activeProposedPlan,
    sidebarProposedPlan,
    activePlan,
    planSidebarLabel,
    showPlanFollowUpPrompt,
    activePendingApproval,
    phase,
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
    isWorking,
    nowIso,
    activeWorkStartedAt,
    workingVerb,
    isComposerApprovalState,
    hasComposerHeader,
    composerFooterHasWideActions,
    completionSummary,
  };
}

export type ChatViewThreadDerivedState = ReturnType<typeof useChatViewThreadDerivedState>;
