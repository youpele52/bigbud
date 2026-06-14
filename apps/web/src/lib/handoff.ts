import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@bigbud/contracts";

import { readNativeApi } from "../rpc/nativeApi";
import { selectIsThreadRunning, selectThreadById, useStore } from "../stores/main";
import { newCommandId, newMessageId } from "./utils";

const HANDOFF_USER_PROMPT = "/skills handoff";
const DEFAULT_HANDOFF_TIMEOUT_MS = 120_000;
const HANDOFF_POLL_INTERVAL_MS = 100;

export class HandoffError extends Error {
  override readonly name = "HandoffError";
}

interface DispatchHandoffTurnInput {
  threadId: ThreadId;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

/**
 * Dispatches a turn in the given thread that invokes the curated handoff skill.
 * Throws if the native API is unavailable or the dispatch fails.
 */
export async function dispatchHandoffSkillTurn(input: DispatchHandoffTurnInput): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    throw new HandoffError("Native API is not available.");
  }

  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: HANDOFF_USER_PROMPT,
      attachments: [],
    },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: new Date().toISOString(),
  });
}

interface WaitForHandoffSummaryOptions {
  timeoutMs?: number;
}

/**
 * Waits for the handoff turn dispatched by {@link dispatchHandoffSkillTurn} to
 * complete and returns the assistant message produced for that turn.
 *
 * The function identifies the handoff turn by looking for the user message that
 * invoked the skill, then waits for the matching assistant message to finish
 * streaming.
 */
export function waitForHandoffSummary(
  threadId: ThreadId,
  options?: WaitForHandoffSummaryOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let targetTurnId: string | null = null;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (onComplete: () => void) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (intervalHandle) clearInterval(intervalHandle);
      onComplete();
    };

    const check = () => {
      const state = useStore.getState();
      const thread = selectThreadById(threadId)(state);
      if (!thread) {
        cleanup(() =>
          reject(new HandoffError("Source thread disappeared while generating handoff.")),
        );
        return;
      }

      const isRunning = selectIsThreadRunning(threadId)(state);
      const currentTurnId = thread.latestTurn?.turnId ?? null;

      if (targetTurnId === null) {
        const hasHandoffUserMessage = thread.messages.some(
          (message) => message.role === "user" && message.text.trim() === HANDOFF_USER_PROMPT,
        );
        if (hasHandoffUserMessage && currentTurnId !== null && isRunning) {
          targetTurnId = currentTurnId;
        }
        return;
      }

      if (!isRunning) {
        const assistantMessage = thread.messages.find(
          (message) =>
            message.role === "assistant" && message.turnId === targetTurnId && !message.streaming,
        );
        if (assistantMessage?.text) {
          cleanup(() => resolve(assistantMessage.text));
        }
      }

      if (Date.now() - startTime > timeoutMs) {
        cleanup(() => reject(new HandoffError("Handoff generation timed out.")));
      }
    };

    intervalHandle = setInterval(check, HANDOFF_POLL_INTERVAL_MS);
    timeoutHandle = setTimeout(() => {
      cleanup(() => reject(new HandoffError("Handoff generation timed out.")));
    }, timeoutMs);
  });
}

interface GenerateHandoffSummaryInput {
  threadId: ThreadId;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

/**
 * Convenience helper that runs the handoff skill on the source thread and
 * returns the generated summary text.
 */
export async function generateHandoffSummary(
  input: GenerateHandoffSummaryInput,
  options?: WaitForHandoffSummaryOptions,
): Promise<string> {
  await dispatchHandoffSkillTurn(input);
  return waitForHandoffSummary(input.threadId, options);
}
