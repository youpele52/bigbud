import fs from "node:fs";
import path from "node:path";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  asMessageId,
  createHarness,
  makeTrackedTempDir,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor branch names", () => {
  registerProviderCommandReactorTestCleanup();
  it("generates a worktree branch name for the first turn", async () => {
    const baseDir = makeTrackedTempDir("bigbud-title-branch-");
    const harness = await createHarness({ baseDir });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-branch-generation");
    const worktreePath = path.join(baseDir, "worktree");
    fs.mkdirSync(worktreePath);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-branch-create"),
        threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "New thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-branch"),
        threadId,
        branch: "bigbud/1234abcd",
        worktreePath,
      }),
    );
    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-branch-model"),
        threadId,
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
  });
});
