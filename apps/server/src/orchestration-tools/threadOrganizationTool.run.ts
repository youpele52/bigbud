import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Schema } from "effect";

import type { ThreadOrchestrationToolDispatcherShape } from "./ThreadOrchestrationToolDispatcher.ts";
import type { ThreadOrganizationToolResult } from "./ThreadOrchestrationTools.organization.ts";
import { MoveThreadArguments, SnoozeThreadArguments } from "./threadOrganizationTool.shared.ts";

export const THREAD_ORGANIZATION_TOOL_NAMES = ["move_thread", "snooze_thread"] as const;
export type ThreadOrganizationToolName = (typeof THREAD_ORGANIZATION_TOOL_NAMES)[number];

export const isThreadOrganizationToolName = (name: string): name is ThreadOrganizationToolName =>
  (THREAD_ORGANIZATION_TOOL_NAMES as readonly string[]).includes(name);

/**
 * Runs `move_thread` or `snooze_thread` for in-process transports (Codex dynamic tools,
 * Copilot). The caller is always the transport's authenticated thread.
 */
export function runThreadOrganizationTool(input: {
  readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
  readonly name: ThreadOrganizationToolName;
  readonly args: unknown;
  readonly threadId: ThreadId;
  readonly invocationId: string;
}): Promise<ThreadOrganizationToolResult> {
  const { dispatcher } = input;
  if (!dispatcher.move || !dispatcher.snooze) {
    return Promise.reject(new Error("Thread organization is not ready."));
  }
  const decoded =
    input.name === "move_thread"
      ? Schema.decodeUnknownSync(MoveThreadArguments)(input.args)
      : Schema.decodeUnknownSync(SnoozeThreadArguments)(input.args);
  const shared = {
    threadId: input.threadId,
    invocationId: input.invocationId,
    ...(decoded.targetThreadId !== undefined
      ? { targetThreadId: ThreadId.makeUnsafe(decoded.targetThreadId.trim()) }
      : {}),
  };
  return Effect.runPromise(
    "state" in decoded
      ? dispatcher.move({ ...shared, state: decoded.state })
      : dispatcher.snooze({ ...shared, minutes: decoded.minutes }),
  );
}
