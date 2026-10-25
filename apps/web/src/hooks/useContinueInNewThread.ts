import type { CommandId, ThreadId } from "@bigbud/contracts";
import type { ThreadForkCommand } from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import {
  buildCarryToContinuedThreadCommand,
  buildContinueInNewThreadCommand,
  type ForkCarry,
  resolveContinuePendingMessageId,
} from "../components/chat/view/ThreadForkNotice.logic";
import { toastManager } from "../components/ui/toast";
import { dispatchCommandWithOutcomeRecovery } from "../lib/orchestrationCommandRecovery";
import { newCommandId, newThreadId } from "../lib/utils";
import type { Thread } from "../models/types/app.types";
import { readNativeApi } from "../rpc/nativeApi";
import { waitForContinuedThread } from "./useContinueInNewThread.logic";

type ForkSource = Pick<Thread, "id" | "turnStartRequest" | "messages" | "activities">;

/**
 * "Continue in a new thread": dispatch a server-side `thread.fork` and open the fork. "Send this
 * message to the continued thread" carries a later message into the existing fork instead (D20).
 * Retries for the same message reuse one command and fork id, so a double click or a reconnect
 * retry cannot create a second fork or send twice.
 */
export function useContinueInNewThread(thread: ForkSource) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const identities = useRef(new Map<string, { commandId: CommandId; threadId: ThreadId }>());

  const run = useCallback(
    async (
      title: string,
      key: string,
      build: (identity: { commandId: CommandId; threadId: ThreadId }) => ThreadForkCommand,
    ) => {
      const api = readNativeApi();
      if (!api || pending) return;
      const identity = identities.current.get(key) ?? {
        commandId: newCommandId(),
        threadId: newThreadId(),
      };
      identities.current.set(key, identity);
      setPending(true);
      try {
        const command = build(identity);
        await dispatchCommandWithOutcomeRecovery(api, command);
        // The server may keep an existing fork instead (no-op decision): open the real one.
        const target = await waitForContinuedThread({
          sourceThreadId: thread.id,
          requestedThreadId: command.threadId,
          command,
        });
        if (!target) throw new Error("The continued thread did not appear. Try again in a moment.");
        await navigate({ to: "/$threadId", params: { threadId: target } });
      } catch (error) {
        toastManager.add({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        setPending(false);
      }
    },
    [navigate, pending, thread.id],
  );

  const continueInNewThread = useCallback(
    () =>
      run(
        "Could not continue in a new thread",
        `${thread.id}:${resolveContinuePendingMessageId(thread) ?? "none"}`,
        (identity) =>
          buildContinueInNewThreadCommand({
            thread,
            ...identity,
            createdAt: new Date().toISOString(),
          }),
      ),
    [run, thread],
  );

  const carryToContinuedThread = useCallback(
    (forkThreadId: ThreadId, carry: ForkCarry) =>
      run(
        "Could not send the message to the continued thread",
        `${thread.id}:carry:${carry.pendingMessageId}`,
        ({ commandId }) =>
          buildCarryToContinuedThreadCommand({
            sourceThreadId: thread.id,
            forkThreadId,
            carry,
            commandId,
            createdAt: new Date().toISOString(),
          }),
      ),
    [run, thread.id],
  );

  return { continueInNewThread, carryToContinuedThread, pending };
}
