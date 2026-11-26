import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { RETENTION_DELETION_COMMAND_PREFIX } from "../../deletion/Services/ThreadDeletion.mode.ts";
import { abortThreadDeletion } from "./ProviderCommandReactorHandlers.delete.abort.ts";

function recordingEngine() {
  const commands: Array<Record<string, unknown>> = [];
  const engine = {
    dispatch: (command: Record<string, unknown>) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  } as unknown as OrchestrationEngineShape;
  return { engine, commands };
}

const threadId = ThreadId.makeUnsafe("thread-1");
const outcome = {
  type: "failed",
  threadIds: [threadId],
  detail: "Terminal cleanup failed.",
} as const;

describe("abortThreadDeletion", () => {
  it("marks undone retention deletions so clients raise no toast for them", async () => {
    const { engine, commands } = recordingEngine();
    await Effect.runPromise(
      abortThreadDeletion(engine, {
        threadId,
        mode: "single",
        origin: undefined,
        deletionEventId: "event-1",
        deletionCommandId: `${RETENTION_DELETION_COMMAND_PREFIX}run-1:${threadId}`,
        createdAt: "2026-11-21T00:00:00.000Z",
        outcome,
      }),
    );
    expect(commands[0]).toMatchObject({
      type: "thread.delete.abort",
      reason: "Terminal cleanup failed.",
      initiator: "retention",
    });
    // The thread still records why, like any failed deletion.
    expect(commands[1]).toMatchObject({ type: "thread.activity.append" });
  });

  it("leaves a person's undone deletion unmarked", async () => {
    const { engine, commands } = recordingEngine();
    await Effect.runPromise(
      abortThreadDeletion(engine, {
        threadId,
        mode: "single",
        origin: undefined,
        deletionEventId: "event-2",
        deletionCommandId: "client-command",
        createdAt: "2026-11-21T00:00:00.000Z",
        outcome,
      }),
    );
    expect(commands[0]).not.toHaveProperty("initiator");
  });
});
