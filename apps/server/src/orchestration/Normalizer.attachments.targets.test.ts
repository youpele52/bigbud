import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";

it("hydrates only canonical local workspace references, never same-named remote paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-targets-"));
  const source = path.join(root, "private.txt");
  await writeFile(source, "local host secret");
  const layer = Layer.empty.pipe(
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "attachment-targets-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const command = {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe("target-reference"),
    threadId: ThreadId.makeUnsafe("target-thread"),
    delivery: "auto",
    createdAt: "2026-10-09T00:00:00.000Z",
    message: {
      messageId: MessageId.makeUnsafe("target-message"),
      text: "read",
      attachments: [
        {
          type: "path",
          name: "private.txt",
          path: source,
          entryKind: "file",
          mimeType: "text/plain",
          sizeBytes: 0,
        },
      ],
    },
  } satisfies ClientOrchestrationCommand;
  const projectId = ProjectId.makeUnsafe("project");
  const bootstrap = {
    createThread: {
      projectId,
      title: "new",
      modelSelection: { provider: "opencodeV2", model: "synthetic" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: command.createdAt,
    },
  } as const;
  async function normalize(input: ClientOrchestrationCommand, thread?: object, project?: object) {
    return Effect.runPromise(
      normalizeDispatchCommand(input).pipe(
        Effect.provide(layer),
        Effect.provideService(OrchestrationEngineService, {
          ensureThreadState: () => Effect.succeed(thread),
          getReadModel: () => Effect.succeed({ projects: project ? [project] : [] }),
        } as unknown as typeof OrchestrationEngineService.Service),
      ),
    );
  }
  function kind(result: Awaited<ReturnType<typeof normalize>>) {
    if (!("message" in result)) throw new Error("Unexpected command");
    return result.message.attachments?.[0]?.type;
  }
  try {
    for (const provider of ["opencodeV2", "codex", "copilot", "claude"] as const) {
      expect(
        kind(
          await normalize(command, {
            modelSelection: { provider },
            providerRuntimeExecutionTargetId: "local",
            workspaceExecutionTargetId: "ssh:remote",
          }),
        ),
      ).toBe("path");
    }
    expect(
      kind(
        await normalize(command, {
          modelSelection: { provider: "opencodeV2" },
          executionTargetId: "ssh:remote",
        }),
      ),
    ).toBe("path");
    expect(kind(await normalize(command))).toBe("path");
    expect(
      kind(
        await normalize(command, {
          modelSelection: { provider: "opencodeV2" },
          workspaceExecutionTargetId: "local",
        }),
      ),
    ).toBe("file");
    expect(
      kind(
        await normalize({ ...command, bootstrap }, undefined, {
          id: projectId,
          workspaceExecutionTargetId: "ssh:remote",
        }),
      ),
    ).toBe("path");
    expect(
      kind(
        await normalize({ ...command, bootstrap }, undefined, {
          id: projectId,
          workspaceExecutionTargetId: "local",
        }),
      ),
    ).toBe("file");
    // Canonical state wins over conflicting bootstrap data on an existing thread.
    expect(
      kind(
        await normalize(
          {
            ...command,
            bootstrap: {
              createThread: { ...bootstrap.createThread, workspaceExecutionTargetId: "local" },
            },
          },
          { modelSelection: { provider: "opencodeV2" }, workspaceExecutionTargetId: "ssh:remote" },
        ),
      ),
    ).toBe("path");
    // Desktop uploads are explicit host-file ingress, unlike workspace references.
    expect(
      kind(
        await normalize(
          {
            ...command,
            message: {
              ...command.message,
              attachments: [
                {
                  type: "file",
                  transport: "path",
                  filePath: source,
                  name: "private.txt",
                  mimeType: "text/plain",
                  sizeBytes: 17,
                },
              ],
            },
          },
          { modelSelection: { provider: "opencodeV2" }, workspaceExecutionTargetId: "ssh:remote" },
        ),
      ),
    ).toBe("file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
