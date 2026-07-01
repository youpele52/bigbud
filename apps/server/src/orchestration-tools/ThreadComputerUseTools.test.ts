import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ComputerUseShape } from "../computer-use/Services/ComputerUse.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { computerUseViaOrchestration } from "./ThreadComputerUseTools.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

function makeReadModel(runtimeMode: "approval-required" | "full-access"): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-06-30T00:00:00.000Z",
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Computer use thread",
        modelSelection: { provider: "codex", model: "gpt-5" },
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        watchingThreads: [],
      },
    ],
  };
}

function makeOrchestrationEngine(input: {
  readonly readModel: OrchestrationReadModel;
  readonly dispatched: OrchestrationCommand[];
}): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.succeed(input.readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) => {
      input.dispatched.push(command);
      return Effect.succeed({ sequence: input.dispatched.length });
    },
    streamDomainEvents: Stream.empty,
  };
}

describe("computerUseViaOrchestration", () => {
  it("allows read-only capture actions outside full-access mode", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const computerUse: ComputerUseShape = {
      execute: () =>
        Effect.succeed({
          surface: "browser",
          action: "capture",
          summary: "Captured the current page at https://example.com.",
          page: { url: "https://example.com", title: "Example" },
        }),
      dispose: Effect.void,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

        return yield* computerUseViaOrchestration({
          attachmentsDir,
          computerUse,
          computerUseEnabled: true,
          fileSystem,
          orchestrationEngine: makeOrchestrationEngine({
            readModel: makeReadModel("approval-required"),
            dispatched,
          }),
          path,
          serverMode: "desktop",
          threadId: THREAD_ID,
          action: { action: "capture" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.summary).toContain("Captured");
    expect(dispatched.filter((command) => command.type === "thread.activity.append")).toHaveLength(
      2,
    );
  });

  it("blocks mutating actions unless the thread is in full-access mode", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({
        surface: "browser" as const,
        action: "click" as const,
        summary: "clicked",
        page: { url: "https://example.com", title: "Example" },
      }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

          return yield* computerUseViaOrchestration({
            attachmentsDir,
            computerUse: { execute, dispose: Effect.void },
            computerUseEnabled: true,
            fileSystem,
            orchestrationEngine: makeOrchestrationEngine({
              readModel: makeReadModel("approval-required"),
              dispatched,
            }),
            path,
            serverMode: "desktop",
            threadId: THREAD_ID,
            action: { action: "click", x: 1, y: 2 },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow("full-access");

    expect(execute).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("persists screenshot attachments and records attachmentUrl in tool activity", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const screenshotBase64 = Buffer.from("png-bytes").toString("base64");
    const computerUse: ComputerUseShape = {
      execute: () =>
        Effect.succeed({
          surface: "browser",
          action: "capture",
          summary: "Captured screenshot.",
          page: { url: "https://example.com", title: "Example" },
          screenshot: {
            mimeType: "image/png",
            dataBase64: screenshotBase64,
          },
        }),
      dispose: Effect.void,
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

        return yield* computerUseViaOrchestration({
          attachmentsDir,
          computerUse,
          computerUseEnabled: true,
          fileSystem,
          orchestrationEngine: makeOrchestrationEngine({
            readModel: makeReadModel("full-access"),
            dispatched,
          }),
          path,
          serverMode: "desktop",
          threadId: THREAD_ID,
          action: { action: "capture" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.screenshot?.attachmentUrl).toMatch(/^\/attachments\//);
    expect(result.screenshot?.attachmentId).toBeTruthy();

    const completedActivity = dispatched
      .filter((command) => command.type === "thread.activity.append")
      .map((command) => (command.type === "thread.activity.append" ? command.activity : null))
      .find((activity) => activity?.kind === "tool.completed");

    expect(completedActivity?.payload).toMatchObject({
      title: "computer_use",
      data: expect.objectContaining({
        attachmentUrl: result.screenshot?.attachmentUrl,
      }),
    });
  });

  it("blocks dangerous key combos even in full-access mode", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({ surface: "desktop" as const, action: "key" as const, summary: "" }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

          return yield* computerUseViaOrchestration({
            attachmentsDir,
            computerUse: { execute, dispose: Effect.void },
            computerUseEnabled: true,
            fileSystem,
            orchestrationEngine: makeOrchestrationEngine({
              readModel: makeReadModel("full-access"),
              dispatched,
            }),
            path,
            serverMode: "desktop",
            threadId: THREAD_ID,
            action: { action: "key", key: "cmd+q" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow("blocked");

    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks desktop actions when computer use is disabled in settings", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({ surface: "desktop" as const, action: "list_apps" as const, summary: "" }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

          return yield* computerUseViaOrchestration({
            attachmentsDir,
            computerUse: { execute, dispose: Effect.void },
            computerUseEnabled: false,
            fileSystem,
            orchestrationEngine: makeOrchestrationEngine({
              readModel: makeReadModel("full-access"),
              dispatched,
            }),
            path,
            serverMode: "desktop",
            threadId: THREAD_ID,
            action: { action: "list_apps" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow(/disabled in Bigbud settings/);

    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks desktop actions in web server mode", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({ surface: "desktop" as const, action: "doctor" as const, summary: "" }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

          return yield* computerUseViaOrchestration({
            attachmentsDir,
            computerUse: { execute, dispose: Effect.void },
            computerUseEnabled: true,
            fileSystem,
            orchestrationEngine: makeOrchestrationEngine({
              readModel: makeReadModel("full-access"),
              dispatched,
            }),
            path,
            serverMode: "web",
            threadId: THREAD_ID,
            action: { action: "doctor" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow(/desktop mode/);

    expect(execute).not.toHaveBeenCalled();
  });

  it("still allows browser capture when desktop computer use is disabled", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({
        surface: "browser" as const,
        action: "capture" as const,
        summary: "Captured browser.",
        page: { url: "https://example.com", title: "Example" },
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

        return yield* computerUseViaOrchestration({
          attachmentsDir,
          computerUse: { execute, dispose: Effect.void },
          computerUseEnabled: false,
          fileSystem,
          orchestrationEngine: makeOrchestrationEngine({
            readModel: makeReadModel("approval-required"),
            dispatched,
          }),
          path,
          serverMode: "desktop",
          threadId: THREAD_ID,
          action: { action: "capture", surface: "browser" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.summary).toContain("Captured browser.");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks typing sensitive text even in full-access mode", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({ surface: "browser" as const, action: "type" as const, summary: "" }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

          return yield* computerUseViaOrchestration({
            attachmentsDir,
            computerUse: { execute, dispose: Effect.void },
            computerUseEnabled: true,
            fileSystem,
            orchestrationEngine: makeOrchestrationEngine({
              readModel: makeReadModel("full-access"),
              dispatched,
            }),
            path,
            serverMode: "desktop",
            threadId: THREAD_ID,
            action: { action: "type", text: "my password is hunter2" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow("blocked");

    expect(execute).not.toHaveBeenCalled();
  });
});
