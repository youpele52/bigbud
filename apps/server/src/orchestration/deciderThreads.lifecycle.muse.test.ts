import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { PROJECT, readModel } from "./deciderThreads.fork.test.helpers.ts";

const NOW = "2026-10-29T10:00:00.000Z";

async function createThread(input: {
  readonly provider: "muse" | "codex";
  readonly runtimeMode: "full-access" | "approval-required" | "auto-accept-edits";
}) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-create-muse"),
        threadId: ThreadId.makeUnsafe("thread-muse"),
        projectId: PROJECT,
        title: "Muse thread",
        modelSelection: { provider: input.provider, model: "muse-wonder-1.0" },
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      } as never,
      readModel: readModel(),
    }),
  );
  const events = Array.isArray(result) ? result : [result];
  return events.find((event) => event.type === "thread.created");
}

describe("thread.create Muse inherited mode", () => {
  it("downgrades the global-default full-access mode for a new Muse thread", async () => {
    const created = await createThread({ provider: "muse", runtimeMode: "full-access" });
    expect(created?.payload).toMatchObject({ runtimeMode: "auto-accept-edits" });
  });

  it("keeps a user-chosen stricter mode and other providers unchanged", async () => {
    const stricter = await createThread({ provider: "muse", runtimeMode: "approval-required" });
    expect(stricter?.payload).toMatchObject({ runtimeMode: "approval-required" });
    const codex = await createThread({ provider: "codex", runtimeMode: "full-access" });
    expect(codex?.payload).toMatchObject({ runtimeMode: "full-access" });
  });
});
