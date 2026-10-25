import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { expect, it, vi } from "vitest";
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

function canonicalLocation() {
  const thread = {
    id: ThreadId.makeUnsafe("cold-local-thread"),
    projectId: "linked-project",
    worktreePath: null as string | null,
    deletedAt: null as string | null,
    workspaceExecutionTargetId: undefined as string | undefined,
    providerRuntimeExecutionTargetId: undefined as string | undefined,
    executionTargetId: undefined as string | undefined,
  };
  const project = {
    id: "linked-project",
    workspaceRoot: "/canonical-project" as string | null,
    deletedAt: null as string | null,
    workspaceExecutionTargetId: undefined as string | undefined,
    providerRuntimeExecutionTargetId: undefined as string | undefined,
    executionTargetId: undefined as string | undefined,
  };
  return { thread, project, threads: [thread], projects: [project] };
}

it("uses Default chat folder only for intentional folderless Chats, preserving project/worktree precedence", async () => {
  const canonical = canonicalLocation();
  canonical.thread.projectId = BUILT_IN_CHATS_PROJECT_ID;
  canonical.project.id = BUILT_IN_CHATS_PROJECT_ID;
  canonical.project.workspaceRoot = null;
  const dispatch = vi.fn();
  const engine = {
    ensureThreadState: () => Effect.succeed(canonical.thread),
    getReadModel: () => Effect.succeed(canonical),
    dispatch,
  } as unknown as OrchestrationEngineShape;
  const request = { refresh: true, threadId: canonical.thread.id, directory: "/stale-location" };
  await expect(inferredV2SetupLocation(request, "/configured-chats", engine)).resolves.toBe(
    "/configured-chats",
  );
  canonical.thread.worktreePath = "/actual-worktree";
  await expect(inferredV2SetupLocation(request, "/configured-chats", engine)).resolves.toBe(
    "/actual-worktree",
  );
  canonical.thread.worktreePath = null;
  canonical.project.workspaceRoot = "/actual-project";
  await expect(inferredV2SetupLocation(request, "/configured-chats", engine)).resolves.toBe(
    "/actual-project",
  );
  canonical.projects = [];
  await expect(inferredV2SetupLocation(request, "/configured-chats", engine)).rejects.toThrow(
    "no supported local",
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not resolve a relative configured folder against the process cwd", async () => {
  await expect(inferredV2SetupLocation({ refresh: true }, "relative-folder")).resolves.toBe(
    "relative-folder",
  );
});

it.each(["project", "worktree"])(
  "hydrates a cold selected thread and its linked project before reading its canonical %s Location",
  async (kind) => {
    const canonical = canonicalLocation();
    if (kind === "worktree") canonical.thread.worktreePath = "/canonical-worktree";
    let model = {
      threads: [] as typeof canonical.threads,
      projects: [] as typeof canonical.projects,
    };
    const order: string[] = [];
    const hydrate = vi.fn(() =>
      Effect.promise(async () => {
        order.push("hydrating");
        await Promise.resolve();
        model = canonical;
        order.push("hydrated");
        return canonical.thread;
      }),
    );
    const dispatch = vi.fn();
    const engine = {
      ensureThreadState: hydrate,
      getReadModel: () =>
        Effect.sync(() => {
          order.push("read-model");
          return model;
        }),
      dispatch,
    } as unknown as OrchestrationEngineShape;
    await expect(
      inferredV2SetupLocation(
        { refresh: true, threadId: canonical.thread.id, directory: "/untrusted-request-directory" },
        "/private-default",
        engine,
      ),
    ).resolves.toBe(kind === "worktree" ? "/canonical-worktree" : "/canonical-project");
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(canonical.thread.id, "operational");
    expect(order).toEqual(["hydrating", "hydrated", "read-model"]);
    expect(dispatch).not.toHaveBeenCalled(); // Hydration is not execution, enrollment or new authorization.
  },
);

it.each([
  "missing-thread",
  "missing-project",
  "deleted-thread",
  "deleted-project",
  "remote-workspace",
  "remote-runtime",
  "legacy-remote-thread",
  "inherited-remote-workspace",
  "inherited-remote-runtime",
  "legacy-remote-project",
  "missing-canonical-path",
  "stale-cache-after-missing-hydration",
])(
  "fails closed after hydration for %s without using request/default directories",
  async (scenario) => {
    const canonical = canonicalLocation();
    if (scenario === "missing-thread") canonical.threads = [];
    if (scenario === "missing-project") canonical.projects = [];
    if (scenario === "deleted-thread") canonical.thread.deletedAt = "2026-10-17T10:00:00Z";
    if (scenario === "deleted-project") canonical.project.deletedAt = "2026-10-17T10:00:00Z";
    if (scenario === "remote-workspace") canonical.thread.workspaceExecutionTargetId = "ssh:remote";
    if (scenario === "remote-runtime")
      canonical.thread.providerRuntimeExecutionTargetId = "ssh:remote";
    if (scenario === "legacy-remote-thread") canonical.thread.executionTargetId = "ssh:remote";
    if (scenario === "inherited-remote-workspace")
      canonical.project.workspaceExecutionTargetId = "ssh:remote";
    if (scenario === "inherited-remote-runtime")
      canonical.project.providerRuntimeExecutionTargetId = "ssh:remote";
    if (scenario === "legacy-remote-project") canonical.project.executionTargetId = "ssh:remote";
    if (scenario === "missing-canonical-path") canonical.project.workspaceRoot = null;
    const hydrate = vi.fn(() =>
      Effect.succeed(
        scenario === "stale-cache-after-missing-hydration" ? undefined : canonical.threads[0],
      ),
    );
    const dispatch = vi.fn();
    const engine = {
      ensureThreadState: hydrate,
      getReadModel: () => Effect.succeed(canonical),
      dispatch,
    } as unknown as OrchestrationEngineShape;
    await expect(
      inferredV2SetupLocation(
        { refresh: true, threadId: canonical.thread.id, directory: "/untrusted-request-directory" },
        "/private-default",
        engine,
      ),
    ).rejects.toThrow("no local/private fallback");
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(canonical.thread.id, "operational");
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("does not recover a hydration failure or absent engine through arbitrary directory fallback", async () => {
  const threadId = ThreadId.makeUnsafe("failed-hydration");
  const getReadModel = vi.fn();
  const engine = {
    ensureThreadState: () => Effect.die(new Error("canonical hydration failed")),
    getReadModel,
  } as unknown as OrchestrationEngineShape;
  await expect(
    inferredV2SetupLocation(
      { refresh: true, threadId, directory: "/supplied" },
      "/default",
      engine,
    ),
  ).rejects.toThrow("canonical hydration failed");
  expect(getReadModel).not.toHaveBeenCalled();
  await expect(
    inferredV2SetupLocation({ refresh: true, threadId, directory: "/supplied" }, "/default"),
  ).rejects.toThrow("no arbitrary directory fallback");
});
