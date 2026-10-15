import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts";
import { expect, it } from "vitest";
import { inferredV2SetupLocation } from "./ThreadToolsSetup.location.ts";
import type { OrchestrationEngineShape } from "../../../orchestration/Services/OrchestrationEngine.ts";

it("infers the actual worktree/project/default, never a supplied legacy directory for installation or a plugin config override", async () => {
  const threadId = ThreadId.makeUnsafe("inferred-thread");
  const thread = {
    id: threadId,
    projectId: "project",
    worktreePath: "/actual-worktree",
    workspaceExecutionTargetId: "local",
    providerRuntimeExecutionTargetId: "local",
  };
  const engine = {
    getReadModel: () =>
      Effect.succeed({
        threads: [thread],
        projects: [{ id: "project", workspaceRoot: "/actual-project" }],
      }),
  } as unknown as OrchestrationEngineShape;
  expect(
    await inferredV2SetupLocation(
      { refresh: true, threadId, directory: "/not-chat-cwd" },
      "/default",
      engine,
    ),
  ).toBe("/actual-worktree");
  thread.worktreePath = "";
  expect(await inferredV2SetupLocation({ refresh: true, threadId }, "/default", engine)).toBe(
    "/actual-project",
  );
  expect(
    await inferredV2SetupLocation(
      { refresh: true, directory: "/legacy-selected-location" },
      "/default",
      engine,
    ),
  ).toBe("/default");
  expect(
    await inferredV2SetupLocation(
      { refresh: false, threadId, directory: "/retained-history-location" },
      "/default",
    ),
  ).toBe("/retained-history-location");
  thread.workspaceExecutionTargetId = "ssh:remote";
  await expect(
    inferredV2SetupLocation({ refresh: true, threadId }, "/default", engine),
  ).rejects.toThrow("no supported local");
});
