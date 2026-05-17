import * as OS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type ClientOrchestrationCommand } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../startup/config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

function runNormalize(command: ClientOrchestrationCommand) {
  return Effect.runPromise(normalizeDispatchCommand(command).pipe(Effect.provide(TestLayer)));
}

describe("normalizeDispatchCommand", () => {
  it("normalizes local project workspace roots through WorkspacePaths", async () => {
    const normalized = await runNormalize({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create-local"),
      projectId: ProjectId.makeUnsafe("project-local"),
      title: "Local Project",
      workspaceRoot: "~",
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(normalized.type).toBe("project.create");
    if (normalized.type !== "project.create") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.workspaceRoot).toBe(OS.homedir());
  });

  it("preserves remote project workspace roots without local filesystem normalization", async () => {
    const normalized = await runNormalize({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create-remote"),
      projectId: ProjectId.makeUnsafe("project-remote"),
      title: "Remote Project",
      executionTargetId: "ssh:devbox",
      workspaceRoot: "~/workspace/bigbud  ",
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(normalized.type).toBe("project.create");
    if (normalized.type !== "project.create") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.workspaceRoot).toBe("~/workspace/bigbud");
  });

  it("preserves explicit remote workspace updates", async () => {
    const normalized = await runNormalize({
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-project-update-remote"),
      projectId: ProjectId.makeUnsafe("project-remote"),
      executionTargetId: "ssh:devbox",
      workspaceRoot: "~/workspace/renamed  ",
    });

    expect(normalized.type).toBe("project.meta.update");
    if (normalized.type !== "project.meta.update") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.workspaceRoot).toBe("~/workspace/renamed");
  });
});
