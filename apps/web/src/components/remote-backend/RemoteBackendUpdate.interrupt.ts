import type { RemoteRuntimeUpdateOperation } from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import { useCallback, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import type { RemoteRuntimeUpdateRpcMethods } from "../../rpc/wsRpcClient.remoteBackendUpdate";
import {
  classifyConsentError,
  CLOSED_REVIEW,
  consentInputFromReview,
  reviewAfterStale,
  reviewFromStatus,
  type InterruptReview,
} from "./RemoteBackendUpdate.consent";
import { showUpdateToast } from "./RemoteBackendUpdate.hooks";
import { describeActionError } from "./RemoteBackendUpdate.logic";

export interface InterruptFlow {
  readonly review: InterruptReview;
  readonly error: string | null;
  /** Records the wish to interrupt (never consent) and loads the affected work to review. */
  readonly open: (operation: RemoteRuntimeUpdateOperation) => Promise<void>;
  /** The only path that sends consent; bound to a user click on the reviewed list. */
  readonly confirm: () => Promise<void>;
  readonly close: () => void;
}

export function useInterruptFlow(
  client: RemoteRuntimeUpdateRpcMethods | null,
  onSettled: () => void,
): InterruptFlow {
  const [review, setReviewState] = useState<InterruptReview>(CLOSED_REVIEW);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<InterruptReview>(CLOSED_REVIEW);
  const setReview = useCallback((next: InterruptReview) => {
    current.current = next;
    setReviewState(next);
  }, []);

  const load = useCallback(
    async (operationId: string, changed: boolean) => {
      if (!client) return;
      try {
        const status = await client.getRemoteRuntimeUpdateStatus({ operationId });
        if (current.current.phase === "closed") return;
        setReview(changed ? reviewAfterStale(status) : reviewFromStatus(status, false));
      } catch (cause) {
        if (current.current.phase === "closed") return;
        setReview({ phase: "unavailable", message: describeActionError(cause) });
      }
    },
    [client, setReview],
  );

  const open = useCallback(
    async (operation: RemoteRuntimeUpdateOperation) => {
      if (!client) return;
      setError(null);
      setReview({ phase: "loading" });
      if (!operation.interruptRequested) {
        try {
          // Joins the same operation and records the request to interrupt; not consent (D9).
          await client.requestRemoteRuntimeUpdate({
            requestId: randomUUID(),
            version: operation.version,
            source: operation.source,
            interrupt: true,
          });
        } catch (cause) {
          if (current.current.phase !== "closed")
            setReview({ phase: "unavailable", message: describeActionError(cause) });
          return;
        }
      }
      await load(operation.operationId, false);
    },
    [client, load, setReview],
  );

  const confirm = useCallback(async () => {
    const shown = current.current;
    const input = consentInputFromReview(shown);
    if (!client || !input || shown.phase !== "review") return;
    setError(null);
    setReview({ ...shown, submitting: true });
    try {
      await client.consentRemoteRuntimeUpdateInterruption(input);
      setReview(CLOSED_REVIEW);
      showUpdateToast({
        type: "info",
        title: "Interruption confirmed",
        description: "The listed work will be stopped when the update installs.",
      });
      onSettled();
    } catch (cause) {
      const outcome = classifyConsentError(cause);
      if (outcome.kind === "reconfirm") {
        // The list changed: show the new one and wait for another explicit confirmation.
        setReview({ phase: "loading" });
        showUpdateToast({
          type: "warning",
          title: "Affected work changed",
          description: "Review the updated list and confirm again.",
        });
        await load(input.operationId, true);
        return;
      }
      if (outcome.kind === "settled") {
        setReview({ phase: "unavailable", message: outcome.message });
        onSettled();
        return;
      }
      setReview({ ...shown, submitting: false });
      setError(outcome.message);
    }
  }, [client, load, onSettled, setReview]);

  const close = useCallback(() => {
    setError(null);
    setReview(CLOSED_REVIEW);
  }, [setReview]);

  return { review, error, open, confirm, close };
}
