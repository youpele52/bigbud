import { Effect, FileSystem, Path } from "effect";
import {
  isLocalExecutionTargetId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@bigbud/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachments/attachmentStore";
import { ServerConfig } from "../startup/config";
import { parseBase64DataUrl } from "../attachments/imageMime";
import { resolveProviderSessionExecutionTargets } from "../provider/providerSessionExecutionTargets.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (
      workspaceRoot: string,
      executionTargetId: string | null | undefined,
    ) => {
      const trimmedWorkspaceRoot = workspaceRoot.trim();
      if (!isLocalExecutionTargetId(executionTargetId)) {
        return Effect.succeed(trimmedWorkspaceRoot);
      }

      return workspacePaths.normalizeWorkspaceRoot(trimmedWorkspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );
    };

    if (command.type === "project.create") {
      const executionTargets = resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: command.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: command.workspaceExecutionTargetId,
        executionTargetId: command.executionTargetId,
      });
      return {
        ...command,
        workspaceRoot:
          command.workspaceRoot === null
            ? null
            : yield* normalizeProjectWorkspaceRoot(
                command.workspaceRoot,
                executionTargets.workspaceExecutionTargetId,
              ),
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      const executionTargets = resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: command.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: command.workspaceExecutionTargetId,
        executionTargetId: command.executionTargetId,
      });
      return {
        ...command,
        workspaceRoot:
          command.workspaceRoot === null
            ? null
            : yield* normalizeProjectWorkspaceRoot(
                command.workspaceRoot,
                executionTargets.workspaceExecutionTargetId,
              ),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start" && command.type !== "thread.shell.run") {
      return command as OrchestrationCommand;
    }

    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          // ── Image (base64 data-url) ──────────────────────────────────────────
          if (attachment.type === "image") {
            const parsed = parseBase64DataUrl(attachment.dataUrl);
            if (!parsed || !parsed.mimeType.startsWith("image/")) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Invalid image attachment payload for '${attachment.name}'.`,
              });
            }

            const bytes = Buffer.from(parsed.base64, "base64");
            if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Image attachment '${attachment.name}' is empty or too large.`,
              });
            }

            const attachmentId = createAttachmentId(command.threadId);
            if (!attachmentId) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Failed to create a safe attachment id.",
              });
            }

            const persistedAttachment = {
              type: "image" as const,
              id: attachmentId,
              name: attachment.name,
              mimeType: parsed.mimeType.toLowerCase(),
              sizeBytes: bytes.byteLength,
            };

            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: persistedAttachment,
            });
            if (!attachmentPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Failed to resolve persisted path for '${attachment.name}'.`,
              });
            }

            yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to create attachment directory for '${attachment.name}'.`,
                  }),
              ),
            );
            yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to persist attachment '${attachment.name}'.`,
                  }),
              ),
            );

            return persistedAttachment;
          }

          // ── File (path transport) ────────────────────────────────────────────
          if (attachment.transport === "path") {
            const sourceFilePath = attachment.filePath;

            // Basic path safety check — must be absolute, no traversal
            if (!path.isAbsolute(sourceFilePath)) {
              return yield* new OrchestrationDispatchCommandError({
                message: `File attachment '${attachment.name}' path must be absolute.`,
              });
            }

            const bytes = yield* fileSystem.readFile(sourceFilePath).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to read file attachment '${attachment.name}' at '${sourceFilePath}'.`,
                  }),
              ),
            );

            if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
              return yield* new OrchestrationDispatchCommandError({
                message: `File attachment '${attachment.name}' is empty or too large.`,
              });
            }

            const attachmentId = createAttachmentId(command.threadId);
            if (!attachmentId) {
              return yield* new OrchestrationDispatchCommandError({
                message: "Failed to create a safe attachment id.",
              });
            }

            const persistedAttachment = {
              type: "file" as const,
              id: attachmentId,
              name: attachment.name,
              mimeType: attachment.mimeType.toLowerCase(),
              sizeBytes: bytes.byteLength,
              // Desktop path transport: sourcePath = original user file path
              sourcePath: sourceFilePath,
            };

            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: persistedAttachment,
            });
            if (!attachmentPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Failed to resolve persisted path for '${attachment.name}'.`,
              });
            }

            yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to create attachment directory for '${attachment.name}'.`,
                  }),
              ),
            );
            yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to persist file attachment '${attachment.name}'.`,
                  }),
              ),
            );

            return persistedAttachment;
          }

          // ── File (base64 transport) ──────────────────────────────────────────
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid base64 payload for file attachment '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `File attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(command.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachmentBase = {
            type: "file" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: attachment.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachmentBase,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist file attachment '${attachment.name}'.`,
                }),
            ),
          );

          // Web base64 transport: sourcePath = server-side copy (no original path available)
          return { ...persistedAttachmentBase, sourcePath: attachmentPath };
        }),
      { concurrency: 1 },
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
