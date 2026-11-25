import { useEffect, useRef, useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationQueuedPrompt } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { OrchestrationCommandOutcomeError } from "~/lib/orchestrationCommandRecovery";
import { readNativeApi } from "~/rpc/nativeApi";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { readRequestedBackendProfile } from "~/rpc/backendScope.state";
import { useComposerDraftStore } from "~/stores/composer";
import {
  buildHeldDraftRecovery,
  dispatchHeldDraftCommand,
  prepareHeldDraft,
} from "./ChatView.heldDraft.logic";
import {
  heldDraftTransaction,
  type HeldDraft,
  type HeldRecovery,
} from "./ChatView.heldDraft.storage";

function isComposerEmpty(threadId: ThreadId) {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  return (
    !draft ||
    (!draft.prompt.trim() &&
      !draft.shellMode &&
      !draft.replyTarget &&
      !draft.images.length &&
      !draft.files.length &&
      !draft.annotations.length &&
      !draft.terminalContexts.length &&
      !draft.persistedAttachments.length &&
      !draft.persistedFileAttachments.length)
  );
}

async function reconcileHeldDraft(key: string): Promise<HeldDraft | undefined> {
  const draft = await heldDraftTransaction(key);
  const command = draft?.recovery ?? (draft?.claimed === false ? draft.claim : undefined);
  const api = readNativeApi();
  if (!command || !api?.orchestration.getCommandOutcome) return draft;
  const outcome = await api.orchestration
    .getCommandOutcome({ commandId: command.commandId })
    .catch(() => undefined);
  if (!outcome || outcome.status === "unknown") return draft;
  return heldDraftTransaction(key, (current) => {
    if (current?.recovery?.commandId === command.commandId) {
      if (outcome.status === "accepted") return undefined;
      const { recovery: _, ...recovered } = current;
      return recovered;
    }
    if (current?.claim.commandId !== command.commandId || current.claimed) return current;
    return outcome.status === "accepted" ? { ...current, claimed: true } : undefined;
  });
}

export function useHeldDraft(threadId: ThreadId) {
  const key = JSON.stringify([readRequestedBackendProfile(), threadId]);
  const [draft, setDraft] = useState<HeldDraft>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);
  const { connectedAt } = useWsConnectionStatus();
  const composerEmpty = useComposerDraftStore(() => isComposerEmpty(threadId));

  useEffect(() => {
    let active = true;
    // On reopen/reconnect, look up persisted attempts without dispatching anything.
    void reconcileHeldDraft(key).then(
      (value) => {
        if (!active || inFlight.current) return;
        setDraft(value);
        setLoaded(true);
      },
      () => {
        if (active) setError("Recovered draft storage is unavailable in this window.");
      },
    );
    return () => {
      active = false;
    };
  }, [connectedAt, key]);

  function run(action: () => Promise<void>) {
    if (!loaded || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    void action()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not update the recovered draft.");
      })
      .finally(() => {
        setBusy(false);
        inFlight.current = false;
      });
  }

  async function settleClaim(attempt: HeldDraft) {
    try {
      await dispatchHeldDraftCommand(attempt.claim);
    } catch (cause) {
      if (cause instanceof OrchestrationCommandOutcomeError && cause.status === "rejected") {
        setDraft(
          await heldDraftTransaction(key, (current) =>
            current?.claim.commandId === attempt.claim.commandId && !current.claimed
              ? undefined
              : current,
          ),
        );
      }
      throw cause;
    }
    setDraft(
      await heldDraftTransaction(key, (current) =>
        current?.claim.commandId === attempt.claim.commandId
          ? { ...current, claimed: true }
          : current,
      ),
    );
  }

  return {
    draft,
    error,
    busy,
    canRecover: loaded && !busy && !draft && composerEmpty,
    recover(prompt: OrchestrationQueuedPrompt) {
      run(async () => {
        if (!isComposerEmpty(threadId)) return;
        const prepared = prepareHeldDraft(threadId, prompt);
        const staged = await heldDraftTransaction(key, (current) => current ?? prepared);
        setDraft(staged);
        if (staged?.claim.commandId === prepared.claim.commandId) await settleClaim(staged);
      });
    },
    retryClaim() {
      run(async () => {
        const current = await heldDraftTransaction(key);
        if (current && current.claim.commandId === draft?.claim.commandId && !current.claimed)
          await settleClaim(current);
        else setDraft(current);
      });
    },
    settle(action: HeldRecovery["action"]) {
      run(async () => {
        const staged = await heldDraftTransaction(key, (current) =>
          current?.claim.commandId === draft?.claim.commandId &&
          current?.claimed &&
          !current.recovery
            ? { ...current, recovery: buildHeldDraftRecovery(current, action) }
            : current,
        );
        setDraft(staged);
        const command = staged?.recovery;
        if (
          !command ||
          command.action !== action ||
          staged.claim.commandId !== draft?.claim.commandId
        )
          return;
        try {
          await dispatchHeldDraftCommand(command);
        } catch (cause) {
          if (cause instanceof OrchestrationCommandOutcomeError && cause.status === "rejected") {
            setDraft(
              await heldDraftTransaction(key, (current) => {
                if (current?.recovery?.commandId !== command.commandId) return current;
                const { recovery: _, ...recovered } = current;
                return recovered;
              }),
            );
          }
          throw cause;
        }
        setDraft(
          await heldDraftTransaction(key, (current) =>
            current?.recovery?.commandId === command.commandId ? undefined : current,
          ),
        );
      });
    },
  };
}
