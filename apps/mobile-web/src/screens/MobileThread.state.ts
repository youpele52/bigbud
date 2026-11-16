import { mobileComposerDraftKey } from "../lib/mobileComposerDraft.identity";
import type { ModelSelection, ThreadId } from "@bigbud/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { PendingUserInputDraftAnswer } from "@bigbud/shared/pendingUserInput";

import {
  advanceMobileComposerDraft,
  createMobileComposerDraft,
  clearSubmittedMobileComposerDraftIfRevision,
  readMobileComposerDraft,
  writeMobileComposerDraftWithLease,
  type MobileCommandDeliveryStatus,
  type MobileComposerDraft,
  type MobileComposerDraftIdentity,
  type MobileDraftThread,
} from "../lib/mobileComposerDraft";
import type { MobileCommandDeliveryState } from "../lib/mobileCommandDelivery.logic";
import { useMobileDraftLease } from "./MobileThread.state.lease";

type AnswersByRequestId = Record<string, Record<string, PendingUserInputDraftAnswer>>;
type QuestionIndexByRequestId = Record<string, number>;

export interface MobileThreadState {
  readonly prompt: string;
  readonly setPrompt: Dispatch<SetStateAction<string>>;
  readonly userInputAnswersByRequestId: AnswersByRequestId;
  readonly setUserInputAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequestId>>;
  readonly userInputQuestionIndexByRequestId: QuestionIndexByRequestId;
  readonly setUserInputQuestionIndexByRequestId: Dispatch<SetStateAction<QuestionIndexByRequestId>>;
  readonly pendingModelSelection: ModelSelection | null;
  readonly setPendingModelSelection: Dispatch<SetStateAction<ModelSelection | null>>;
  readonly draftThread: MobileDraftThread | null;
  readonly submitted: MobileComposerDraft["submitted"];
  readonly revision: number;
  readonly storageWarning: string | null;
  readonly setDeliveryState: (state: MobileCommandDeliveryState) => void;
  readonly decisionSubmitted: MobileComposerDraft["submitted"];
  readonly setDecisionDeliveryState: (state: MobileCommandDeliveryState) => void;
  readonly clearSubmittedIfRevision: (submittedRevision: number) => void;
  readonly clearNewThread: () => void;
}

function describeStorageIssue(issue: "unavailable" | "malformed" | "quota"): string {
  if (issue === "quota")
    return "Draft saving is full. Keep this tab open until your message is sent.";
  if (issue === "malformed")
    return "The saved draft could not be read. Your current edits remain in memory.";
  return "Draft saving is unavailable. Keep this tab open to preserve your current edits.";
}

function asSubmittedState(state: MobileCommandDeliveryState): MobileComposerDraft["submitted"] {
  if (!state.operation || state.status === "idle") return null;
  return {
    command: state.operation.command,
    submittedRevision: state.operation.submittedRevision,
    submittedAt: state.operation.submittedAt,
    deadlineAt: state.operation.deadlineAt,
    ...(state.operation.receiptSource ? { receiptSource: state.operation.receiptSource } : {}),
    status: state.status as Exclude<MobileCommandDeliveryStatus, "idle">,
    ...(state.rejectionReason ? { rejectionReason: state.rejectionReason } : {}),
  };
}

/**
 * The stored form of an approval, answer or interrupt. Only an unsettled one is
 * kept: once accepted or rejected there is nothing left to reconcile.
 */
export function toPersistedDecision(
  state: MobileCommandDeliveryState,
): MobileComposerDraft["submitted"] {
  const unsettled =
    state.status === "pending" || state.status === "reconciling" || state.status === "uncertain";
  return unsettled ? asSubmittedState(state) : null;
}

export function useMobileThreadState(input: {
  readonly identity: MobileComposerDraftIdentity | null;
  readonly threadId: ThreadId;
  readonly fallbackDraft?: MobileDraftThread | null;
}): MobileThreadState {
  const identityKey = input.identity ? mobileComposerDraftKey(input.identity) : input.threadId;
  const readDraftLease = useMobileDraftLease(input.identity);
  const requiresLease = input.identity !== null;
  const initial = useMemo(() => {
    if (input.identity) {
      const stored = readMobileComposerDraft(input.identity);
      if (stored.draft) return stored.draft;
      return createMobileComposerDraft({
        threadId: input.threadId,
        ...(input.fallbackDraft ? { newThread: input.fallbackDraft } : {}),
      });
    }
    return createMobileComposerDraft({
      threadId: input.threadId,
      ...(input.fallbackDraft ? { newThread: input.fallbackDraft } : {}),
    });
  }, [input.fallbackDraft, input.identity, input.threadId]);
  const [composition, setComposition] = useState<MobileComposerDraft>(initial);
  const compositionRef = useRef(composition);
  const [storageWarning, setStorageWarning] = useState<string | null>(() => {
    if (!input.identity) return null;
    const stored = readMobileComposerDraft(input.identity);
    return stored.issue ? describeStorageIssue(stored.issue) : null;
  });

  useEffect(() => {
    const next = input.identity
      ? readMobileComposerDraft(input.identity)
      : { draft: null, issue: undefined };
    const nextComposition =
      next.draft ??
      createMobileComposerDraft({
        threadId: input.threadId,
        ...(input.fallbackDraft ? { newThread: input.fallbackDraft } : {}),
      });
    compositionRef.current = nextComposition;
    setComposition(nextComposition);
    setStorageWarning(next.issue ? describeStorageIssue(next.issue) : null);
  }, [identityKey, input.fallbackDraft, input.identity, input.threadId]);

  const persist = useCallback(
    (next: MobileComposerDraft) => {
      const draftLease = readDraftLease();
      if (!draftLease) return;
      const result = writeMobileComposerDraftWithLease(draftLease, next);
      setStorageWarning(result.ok ? null : describeStorageIssue(result.issue ?? "unavailable"));
    },
    [readDraftLease],
  );

  const update = useCallback(
    (change: (current: MobileComposerDraft) => MobileComposerDraft) => {
      if (requiresLease && !readDraftLease()) return;
      const next = change(compositionRef.current);
      compositionRef.current = next;
      setComposition(next);
      persist(next);
    },
    [persist, readDraftLease, requiresLease],
  );

  const replace = useCallback(
    (change: (current: MobileComposerDraft) => MobileComposerDraft) => {
      if (requiresLease && !readDraftLease()) return;
      const next = change(compositionRef.current);
      compositionRef.current = next;
      setComposition(next);
      persist(next);
    },
    [persist, readDraftLease, requiresLease],
  );

  const setPrompt: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      update((current) => {
        const nextPrompt = typeof value === "function" ? value(current.prompt) : value;
        return advanceMobileComposerDraft(current, { prompt: nextPrompt });
      });
    },
    [update],
  );

  const setPendingModelSelection: Dispatch<SetStateAction<ModelSelection | null>> = useCallback(
    (value) => {
      update((current) => {
        const nextModel = typeof value === "function" ? value(current.modelSelection) : value;
        return advanceMobileComposerDraft(current, { modelSelection: nextModel });
      });
    },
    [update],
  );

  const setUserInputAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequestId>> = useCallback(
    (value) => {
      update((current) => {
        const nextAnswers =
          typeof value === "function" ? value(current.userInputAnswersByRequestId) : value;
        return advanceMobileComposerDraft(current, {
          userInputAnswersByRequestId: nextAnswers,
        });
      });
    },
    [update],
  );

  const setUserInputQuestionIndexByRequestId: Dispatch<SetStateAction<QuestionIndexByRequestId>> =
    useCallback(
      (value) => {
        update((current) => {
          const nextIndexes =
            typeof value === "function" ? value(current.userInputQuestionIndexByRequestId) : value;
          return advanceMobileComposerDraft(current, {
            userInputQuestionIndexByRequestId: nextIndexes,
          });
        });
      },
      [update],
    );

  const setDeliveryState = useCallback(
    (state: MobileCommandDeliveryState) => {
      replace((current) => ({
        ...current,
        submitted: asSubmittedState(state),
        updatedAt: new Date().toISOString(),
      }));
    },
    [replace],
  );

  const setDecisionDeliveryState = useCallback(
    (state: MobileCommandDeliveryState) => {
      replace((current) => ({
        ...current,
        decisionSubmitted: toPersistedDecision(state),
        updatedAt: new Date().toISOString(),
      }));
    },
    [replace],
  );

  const clearSubmittedIfRevision = useCallback(
    (submittedRevision: number) => {
      update((current) => clearSubmittedMobileComposerDraftIfRevision(current, submittedRevision));
    },
    [update],
  );

  const clearNewThread = useCallback(() => {
    update((current) => ({ ...current, newThread: null, updatedAt: new Date().toISOString() }));
  }, [update]);

  return {
    clearNewThread,
    clearSubmittedIfRevision,
    decisionSubmitted: composition.decisionSubmitted ?? null,
    draftThread: composition.newThread,
    pendingModelSelection: composition.modelSelection,
    prompt: composition.prompt,
    revision: composition.revision,
    setDecisionDeliveryState,
    setDeliveryState,
    setPendingModelSelection,
    setPrompt,
    setUserInputAnswersByRequestId,
    setUserInputQuestionIndexByRequestId,
    storageWarning,
    submitted: composition.submitted,
    userInputAnswersByRequestId: composition.userInputAnswersByRequestId,
    userInputQuestionIndexByRequestId: composition.userInputQuestionIndexByRequestId,
  };
}
