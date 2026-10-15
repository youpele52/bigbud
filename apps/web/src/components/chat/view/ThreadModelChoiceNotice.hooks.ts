import type { ModelSelection, ThreadId } from "@bigbud/contracts";
import type { DelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";
import { useCallback, useEffect, useMemo, useState } from "react";

import { newCommandId } from "../../../lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import { toastManager } from "../../ui/toast";
import { observeModelChoice } from "./ThreadRecoveryNotice.clock";
import { modelChoiceRemainingMs } from "./ThreadModelChoiceNotice.logic";

/** Remaining hold for a pending choice on this browser's clock; `null` once resolved. */
export function useModelChoiceCountdown(record: DelegatedModelChoiceRecord | null): number | null {
  const pendingChoiceId = record?.status === "pending" ? record.choiceId : null;
  const observedAtMs = useMemo(
    () => (pendingChoiceId === null ? null : observeModelChoice(pendingChoiceId, Date.now())),
    [pendingChoiceId],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const remainingMs = observedAtMs === null ? null : modelChoiceRemainingMs(observedAtMs, nowMs);

  useEffect(() => {
    if (remainingMs === null || remainingMs <= 0) return;
    // Tick on whole seconds so the countdown text changes exactly once per second.
    const timer = window.setTimeout(() => setNowMs(Date.now()), remainingMs % 1000 || 1000);
    return () => window.clearTimeout(timer);
  }, [remainingMs]);

  return remainingMs;
}

/** Dispatches the user's pick; the server accepts only an offered option, first resolution wins. */
export function usePickDelegatedModelChoice(threadId: ThreadId) {
  const [pickingChoiceId, setPickingChoiceId] = useState<string | null>(null);
  const pick = useCallback(
    async (choiceId: string, modelSelection: ModelSelection) => {
      const api = readNativeApi();
      if (!api) return;
      setPickingChoiceId(choiceId);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.delegation.model-choice.pick",
          commandId: newCommandId(),
          threadId,
          choiceId,
          modelSelection,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not choose the model",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setPickingChoiceId(null);
      }
    },
    [threadId],
  );
  return { pick, pickingChoiceId };
}
