import { randomUUID } from "node:crypto";

import { Effect, type FileSystem, type Path, Scope, Stream } from "effect";

import { TextGenerationError, type ChatAttachment } from "@bigbud/contracts";

import { resolveAttachmentPath } from "../../attachments/attachmentStore.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import { normalizeCliError } from "../Utils.ts";

export type CodexTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateThreadElevatorSummary"
  | "generateThreadHandoff";

export const readStreamAsString = <E>(
  operation: CodexTextGenerationOperation,
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, TextGenerationError> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
    Effect.mapError((cause) =>
      normalizeCliError("codex", operation, cause, "Failed to collect process output"),
    ),
  );

export const writeTempFile = (
  fileSystem: FileSystem.FileSystem,
  operation: CodexTextGenerationOperation,
  prefix: string,
  content: string,
): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
  fileSystem
    .makeTempFileScoped({
      prefix: `bigbud-${prefix}-${process.pid}-${randomUUID()}.tmp`,
    })
    .pipe(
      Effect.tap((filePath) => fileSystem.writeFileString(filePath, content)),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to write temp file",
            cause,
          }),
      ),
    );

export const safeUnlink = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<void, never> => fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

export const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
  path: Path.Path,
  serverConfig: ServerConfigShape,
  fileSystem: FileSystem.FileSystem,
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): Effect.fn.Return<{ readonly imagePaths: ReadonlyArray<string> }, TextGenerationError> {
  if (!attachments || attachments.length === 0) {
    return { imagePaths: [] };
  }

  const imagePaths: string[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "image") {
      continue;
    }

    const resolvedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
      continue;
    }
    const fileInfo = yield* fileSystem
      .stat(resolvedPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      continue;
    }
    imagePaths.push(resolvedPath);
  }
  return { imagePaths };
});
