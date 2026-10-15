import type { CommandId, ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import { buildContinueInNewThreadCommand } from "../components/chat/view/ThreadForkNotice.logic";
import { toastManager } from "../components/ui/toast";
import { dispatchCommandWithOutcomeRecovery } from "../lib/orchestrationCommandRecovery";
import { newCommandId, newThreadId } from "../lib/utils";
import type { Thread } from "../models/types/app.types";
import { readNativeApi } from "../rpc/nativeApi";

type ForkSource = Pick<Thread, "id" | "turnStartRequest" | "activities">;

/**
 * "Continue in a new thread": dispatch a server-side `thread.fork` (same provider) and open the
 * fork. Retries for the same pending request reuse one command and fork id, so a double click or
 * a reconnect retry cannot create a second fork.
 */
export function useContinueInNewThread(thread: ForkSource) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const identities = useRef(new Map<string, { commandId: CommandId; threadId: ThreadId }>());

  const continueInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (!api || pending) return;
    const key = `${thread.id}:${thread.turnStartRequest?.messageId ?? "none"}`;
    const identity = identities.current.get(key) ?? {
      commandId: newCommandId(),
      threadId: newThreadId(),
    };
    identities.current.set(key, identity);
    setPending(true);
    try {
      await dispatchCommandWithOutcomeRecovery(
        api,
        buildContinueInNewThreadCommand({
          thread,
          ...identity,
          createdAt: new Date().toISOString(),
        }),
      );
      await navigate({ to: "/$threadId", params: { threadId: identity.threadId } });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not continue in a new thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setPending(false);
    }
  }, [navigate, pending, thread]);

  return { continueInNewThread, pending };
}
