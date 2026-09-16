import { ProjectId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { ServerConfigShape } from "../startup/config.ts";
import { reviewAndUpdateMemory } from "./LearningReview.ts";
import { MemoryConflictError, type MemoryStoreShape } from "./Services/MemoryStore.ts";

const projectId = ProjectId.makeUnsafe("project-review");
const threadId = ThreadId.makeUnsafe("thread-review");
const unchanged = { userMemory: null, globalMemory: null, projectMemory: null, skillPatch: null };

function fixture(response: unknown = unchanged) {
  const documents = { user: "Existing preference.\n", global: "", project: "Existing decision.\n" };
  const read = vi.fn<MemoryStoreShape["read"]>((input) =>
    Effect.succeed({
      ...input,
      content: documents[input.scope],
      updatedAt: "2026-09-13T00:00:00.000Z",
    }),
  );
  const write = vi.fn<MemoryStoreShape["write"]>((input) =>
    Effect.sync(() => {
      documents[input.scope] = input.content;
      return { ...input, updatedAt: "2026-09-13T00:00:00.000Z" };
    }),
  );
  const runBackgroundReview = vi.fn<ProviderServiceShape["runBackgroundReview"]>(() =>
    Effect.succeed(typeof response === "string" ? response : JSON.stringify(response)),
  );
  const thread = {
    id: threadId,
    projectId,
    messages: [],
    worktreePath: null,
  } as unknown as OrchestrationThread;
  const input = {
    jobId: "learning:test",
    providerService: { runBackgroundReview } as unknown as ProviderServiceShape,
    memoryStore: { read, write },
    config: { cwd: "/fallback" } as ServerConfigShape,
    thread,
    projects: [{ id: projectId, workspaceRoot: "/project" }],
    turnId: "turn-review",
    modelSelection: { provider: "codex" as const, model: "review-model" },
    sourceUserMessage: "Please remember this durable preference.",
    memoryReviewEnabled: true,
  };
  return { input, documents, read, write, runBackgroundReview };
}

describe("reviewAndUpdateMemory persistence", () => {
  it("writes validated replacements with the original compare-and-swap content and correct ownership", async () => {
    const f = fixture({
      ...unchanged,
      userMemory: "Updated preference.",
      projectMemory: "Updated decision.",
    });
    const result = await Effect.runPromise(reviewAndUpdateMemory(f.input));
    expect(result.changed).toEqual(["user", "project"]);
    expect(f.write.mock.calls.map(([input]) => input)).toEqual([
      {
        scope: "user",
        projectId: null,
        content: "Updated preference.\n",
        expectedContent: "Existing preference.\n",
      },
      {
        scope: "project",
        projectId,
        content: "Updated decision.\n",
        expectedContent: "Existing decision.\n",
      },
    ]);
    expect(f.runBackgroundReview).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerThreadId: threadId,
        jobId: "learning:test",
        cwd: "/project",
        modelSelection: f.input.modelSelection,
      }),
    );
  });

  it("accepts explicit unchanged results without rewriting documents", async () => {
    const f = fixture();
    expect(await Effect.runPromise(reviewAndUpdateMemory(f.input))).toEqual({
      changed: [],
      skillPatch: null,
    });
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each([
    "not JSON",
    "{broken json}",
    { userMemory: null, globalMemory: null, projectMemory: null },
    { ...unchanged, skillPatch: 42 },
    { ...unchanged, skillPatch: {} },
    { ...unchanged, skillPatch: { oldText: "old", newText: "new" } },
    {},
    { ...unchanged, userMemory: 42 },
    { ...unchanged, projectMemory: "" },
    { ...unchanged, projectMemory: "```markdown\nunsafe fence\n```" },
    { ...unchanged, projectMemory: "x".repeat(8_001) },
    { ...unchanged, projectMemory: "api_key=example-secret" },
  ])("rejects invalid output without changing any scope: %#", async (response) => {
    const f = fixture(response);
    const result = await Effect.runPromise(reviewAndUpdateMemory(f.input).pipe(Effect.result));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LearningReviewOutputError" },
    });
    expect(f.write).not.toHaveBeenCalled();
  });

  it("validates later scopes before writing an earlier valid scope", async () => {
    const f = fixture({
      ...unchanged,
      userMemory: "Valid new preference.",
      projectMemory: "password=forbidden",
    });
    const result = await Effect.runPromise(reviewAndUpdateMemory(f.input).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    expect(f.write).not.toHaveBeenCalled();
    expect(f.documents.user).toBe("Existing preference.\n");
  });

  it("propagates compare-and-swap conflicts instead of reporting a successful update", async () => {
    const f = fixture({ ...unchanged, userMemory: "New preference." });
    f.write.mockImplementation(() =>
      Effect.fail(new MemoryConflictError({ scope: "user", projectId: null })),
    );
    const result = await Effect.runPromise(reviewAndUpdateMemory(f.input).pipe(Effect.result));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "MemoryConflictError" } });
    expect(f.documents.user).toBe("Existing preference.\n");
  });

  it("does not write when the provider review fails", async () => {
    const f = fixture();
    const error = new ProviderAdapterRequestError({
      provider: "codex",
      method: "review",
      detail: "provider failed",
    });
    f.runBackgroundReview.mockImplementation(() => Effect.fail(error));
    const result = await Effect.runPromise(reviewAndUpdateMemory(f.input).pipe(Effect.result));
    expect(result).toMatchObject({ _tag: "Failure", failure: error });
    expect(f.write).not.toHaveBeenCalled();
  });

  it("returns a skill-only patch for the existing approval flow without writing memory", async () => {
    const patch = {
      oldText: "Original detail",
      newText: "Improved detail",
      reason: "Confirmed correction",
    };
    const f = fixture({ ...unchanged, skillPatch: patch });
    const result = await Effect.runPromise(
      reviewAndUpdateMemory({
        ...f.input,
        memoryReviewEnabled: false,
        skillContext: {
          path: "/skills/example/SKILL.md",
          content: "Original detail",
          sameProviderExamples: [],
        },
      }),
    );
    expect(result).toEqual({ changed: [], skillPatch: patch });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
});
