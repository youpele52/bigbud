import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { OrchestrationProject } from "@bigbud/contracts/orchestration/orchestration.project.ts";
import { mapProject, mapThread } from "./mappers.store";

const at = "2026-10-29T10:00:00.000Z";
const selection = {
  provider: "kilocode",
  model: " Legacy Model ",
  options: { original: true },
  subProviderID: "openrouter",
};

describe("KiloCode history hydration", () => {
  it("preserves history identity and reports the unavailable session without rebinding it", () => {
    const source = Schema.decodeUnknownSync(OrchestrationThread)({
      id: "thread-1",
      projectId: "project-1",
      title: "Legacy chat",
      modelSelection: selection,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      messages: [],
      activities: [],
      checkpoints: [],
      session: {
        threadId: "thread-1",
        providerName: "kilocode",
        status: "stopped",
        activeTurnId: null,
        lastError: null,
        updatedAt: at,
      },
    });
    const hydrated = mapThread(source);
    expect(hydrated.modelSelection).toEqual(source.modelSelection);
    expect(hydrated.session?.provider).toBe("unknown");
    expect(hydrated.error).toContain("cannot route turns");
  });

  it("retains the old project preference for display instead of substituting a current provider", () => {
    const source = Schema.decodeUnknownSync(OrchestrationProject)({
      id: "project-1",
      title: "Legacy project",
      workspaceRoot: null,
      defaultModelSelection: selection,
      scripts: [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    });
    expect(mapProject(source).defaultModelSelection).toEqual(source.defaultModelSelection);
  });
});
