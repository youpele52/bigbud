import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ThreadId, type ClientOrchestrationCommand } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "v2-no-upload-" })),
  Layer.provideMerge(NodeServices.layer),
);
it("validates V2 upload bytes rather than applying a provider blanket exclusion", async () => {
  const command = {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe("reject-upload"),
    threadId: ThreadId.makeUnsafe("v2"),
    modelSelection: { provider: "opencodeV2", model: "synthetic" },
    delivery: "auto",
    createdAt: "2026-10-09T00:00:00.000Z",
    message: {
      messageId: MessageId.makeUnsafe("message"),
      text: "retained",
      attachments: [
        {
          type: "file",
          transport: "base64",
          dataUrl: "invalid",
          name: "file",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ],
    },
  } satisfies ClientOrchestrationCommand;
  const error = await Effect.runPromise(
    Effect.flip(normalizeDispatchCommand(command)).pipe(Effect.provide(TestLayer)),
  );
  expect(error.message).toContain("Invalid base64 payload");
});

it("preserves unavailable canonical path references for old V2 clients", async () => {
  const command = {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe("reject-old-path"),
    threadId: ThreadId.makeUnsafe("v2"),
    delivery: "auto",
    createdAt: "2026-10-09T00:00:00.000Z",
    message: {
      messageId: MessageId.makeUnsafe("message"),
      text: "retained",
      attachments: [
        {
          type: "path",
          name: "file",
          mimeType: "text/plain",
          path: "/never/read",
          entryKind: "file",
          sizeBytes: 0,
        },
      ],
    },
  } satisfies ClientOrchestrationCommand;
  const getReadModel = vi.fn(() =>
    Effect.succeed({
      threads: [{ id: command.threadId, modelSelection: { provider: "opencodeV2" } }],
    }),
  );
  const normalized = await Effect.runPromise(
    normalizeDispatchCommand(command).pipe(
      Effect.provide(TestLayer),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel,
      } as unknown as typeof OrchestrationEngineService.Service),
    ),
  );
  expect("message" in normalized && normalized.message.attachments?.[0]?.type).toBe("path");
  expect(getReadModel).toHaveBeenCalledOnce();
});

it("hydrates cold canonical bindings before normalizing old client uploads", async () => {
  const threadId = ThreadId.makeUnsafe("cold-v2");
  const ensureThreadState = vi.fn(() =>
    Effect.succeed({ id: threadId, modelSelection: { provider: "opencodeV2" } }),
  );
  const command = {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe("cold-upload"),
    threadId,
    delivery: "auto",
    createdAt: "2026-10-09T00:00:00.000Z",
    message: {
      messageId: MessageId.makeUnsafe("message"),
      text: "retained",
      attachments: [
        {
          type: "file",
          transport: "base64",
          name: "file",
          mimeType: "text/plain",
          sizeBytes: 1,
          dataUrl: "invalid",
        },
      ],
    },
  } satisfies ClientOrchestrationCommand;
  const error = await Effect.runPromise(
    Effect.flip(normalizeDispatchCommand(command)).pipe(
      Effect.provide(TestLayer),
      Effect.provideService(OrchestrationEngineService, {
        ensureThreadState,
      } as unknown as typeof OrchestrationEngineService.Service),
    ),
  );
  expect(error.message).toContain("Invalid base64 payload");
  expect(ensureThreadState).toHaveBeenCalledWith(threadId, "operational");
});
