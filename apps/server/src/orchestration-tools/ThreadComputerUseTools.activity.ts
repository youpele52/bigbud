import { ATTACHMENTS_ROUTE_PREFIX } from "../attachments/attachmentPaths.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachments/attachmentStore.ts";
import type { ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { CommandId, EventId } from "@bigbud/contracts";
import { Effect, type FileSystem, type Path } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

export const appendComputerUseActivity = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly operationId: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly kind: "tool.started" | "tool.completed";
  readonly summary: string;
  readonly detail: string;
  readonly data: Record<string, unknown>;
}) =>
  input.orchestrationEngine
    .dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(
        `computer-use:${input.operationId}:${input.kind === "tool.started" ? "started" : "terminal"}`,
      ),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "tool",
        kind: input.kind,
        summary: input.summary,
        payload: {
          itemType: "mcp_tool_call",
          title: "computer_use",
          detail: input.detail,
          data: { operationId: input.operationId, ...input.data },
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    })
    .pipe(Effect.asVoid);

export const persistComputerUseScreenshot = (input: {
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly threadId: ThreadId;
  readonly result: ComputerUseResult;
}) =>
  Effect.gen(function* () {
    if (!input.result.screenshot) return input.result;
    const bytes = Uint8Array.from(Buffer.from(input.result.screenshot.dataBase64, "base64"));
    const attachmentId = createAttachmentId(input.threadId);
    if (!attachmentId) {
      return {
        ...input.result,
        attachmentPersistence: {
          status: "degraded" as const,
          message: "Screenshot captured, but an attachment ID could not be created.",
        },
      };
    }
    const attachment = {
      type: "image" as const,
      id: attachmentId,
      name: "computer-use.png",
      mimeType: input.result.screenshot.mimeType,
      sizeBytes: bytes.byteLength,
    };
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return {
        ...input.result,
        attachmentPersistence: {
          status: "degraded" as const,
          message: "Screenshot captured, but its attachment path was rejected.",
        },
      };
    }
    const writeResult = yield* input.fileSystem
      .makeDirectory(input.path.dirname(attachmentPath), { recursive: true })
      .pipe(
        Effect.andThen(input.fileSystem.writeFile(attachmentPath, bytes)),
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );
    if (!writeResult.ok) {
      return {
        ...input.result,
        attachmentPersistence: {
          status: "degraded" as const,
          message: `Screenshot captured, but attachment persistence failed: ${String(writeResult.error)}`,
        },
      };
    }
    return {
      ...input.result,
      screenshot: {
        ...input.result.screenshot,
        attachmentId,
        attachmentUrl: `${ATTACHMENTS_ROUTE_PREFIX}/${encodeURIComponent(attachmentId)}`,
      },
      attachmentPersistence: { status: "completed" as const },
    } satisfies ComputerUseResult;
  });
