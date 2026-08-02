import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

describe("OrchestrationEngine thread pins", () => {
  it("accepts repeated pin and unpin commands without appending duplicate events", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.makeUnsafe("thread-pin-idempotent");
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-pin-create"),
        projectId: asProjectId("project-pin"),
        title: "Pin Project",
        workspaceRoot: "/tmp/project-pin",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-pin-create"),
        threadId,
        projectId: asProjectId("project-pin"),
        title: "Pinned thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const pinResult = await system.run(
      engine.dispatch({
        type: "thread.pin",
        commandId: CommandId.makeUnsafe("cmd-thread-pin"),
        threadId,
      }),
    );
    const repeatedPinResult = await system.run(
      engine.dispatch({
        type: "thread.pin",
        commandId: CommandId.makeUnsafe("cmd-thread-pin-repeat"),
        threadId,
      }),
    );
    expect(repeatedPinResult.sequence).toBe(pinResult.sequence);

    const unpinResult = await system.run(
      engine.dispatch({
        type: "thread.unpin",
        commandId: CommandId.makeUnsafe("cmd-thread-unpin"),
        threadId,
      }),
    );
    const repeatedUnpinResult = await system.run(
      engine.dispatch({
        type: "thread.unpin",
        commandId: CommandId.makeUnsafe("cmd-thread-unpin-repeat"),
        threadId,
      }),
    );
    expect(repeatedUnpinResult.sequence).toBe(unpinResult.sequence);

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.pinned",
      "thread.unpinned",
    ]);
    await system.dispose();
  });
});
