import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import type { CodexAdapterShape } from "../../Services/Codex/Adapter.ts";
import { toRequestError } from "./Adapter.session.shared.ts";

export function makeCodexTurnControl(manager: CodexAppServerManager): Pick<
  CodexAdapterShape,
  "interruptTurn"
> & {
  readonly steerTurn: NonNullable<CodexAdapterShape["steerTurn"]>;
  readonly stopThreadSubagents: NonNullable<CodexAdapterShape["stopThreadSubagents"]>;
} {
  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: () => manager.interruptTurn(threadId, turnId),
      catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
    });

  const steerTurn: NonNullable<CodexAdapterShape["steerTurn"]> = (threadId, input, turnId) =>
    turnId === undefined
      ? Effect.fail(toRequestError(threadId, "turn/steer", new Error("Expected turn is required.")))
      : Effect.tryPromise({
          try: () =>
            manager.steerTurn({
              threadId,
              input,
              expectedTurnId: turnId,
              clientUserMessageId: randomUUID(),
            }),
          catch: (cause) => toRequestError(threadId, "turn/steer", cause),
        });

  // A parent `turn/interrupt` does not stop child agent threads (live probe, codex-cli 0.163.0),
  // so thread Stop interrupts every running child thread, foreground or background.
  const stopThreadSubagents: NonNullable<CodexAdapterShape["stopThreadSubagents"]> = (
    threadId,
    subagents,
  ) =>
    Effect.tryPromise({
      try: () =>
        manager.interruptChildTurns(
          threadId,
          subagents.map((subagent) => subagent.nativeId),
        ),
      catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
    });

  return { interruptTurn, steerTurn, stopThreadSubagents };
}
