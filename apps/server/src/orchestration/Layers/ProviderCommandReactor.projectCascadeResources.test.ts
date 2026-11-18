import fs from "node:fs";
import path from "node:path";

import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor project cascade resources", () => {
  registerProviderCommandReactorTestCleanup();

  it("cleans the cascaded threads' provider logs like a direct thread delete", async () => {
    const harness = await createHarness();
    const projectId = asProjectId("project-1");
    const childThreadId = ThreadId.makeUnsafe("project-cascade-resources-child");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-cascade-resources-child"),
        threadId: childThreadId,
        projectId,
        title: "Cascade child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        parentThread: { threadId: ThreadId.makeUnsafe("thread-1"), projectId, title: "New thread" },
        createdAt: new Date().toISOString(),
      }),
    );
    const providerLogDirectory = path.join(harness.stateDir, "logs", "provider");
    fs.mkdirSync(providerLogDirectory, { recursive: true });
    const logs = ["thread-1", childThreadId].map((threadId) =>
      path.join(providerLogDirectory, `${threadId}.log`),
    );
    for (const log of logs) fs.writeFileSync(log, "cascade provider log");
    const unrelatedLog = path.join(providerLogDirectory, "unrelated-thread.log");
    fs.writeFileSync(unrelatedLog, "keep");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("cmd-project-cascade-resources-delete"),
        projectId,
      }),
    );

    await waitFor(async () => {
      const model = await Effect.runPromise(harness.engine.getReadModel());
      return model.projects.find((project) => project.id === projectId)?.deletedAt != null;
    });
    await waitFor(() => logs.every((log) => !fs.existsSync(log)));
    expect(fs.readFileSync(unrelatedLog, "utf8")).toBe("keep");
  });
});
