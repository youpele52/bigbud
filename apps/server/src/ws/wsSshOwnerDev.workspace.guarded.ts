import type {
  ProjectReadFilePreviewResult,
  ProjectWriteFileInput,
} from "@bigbud/contracts/workspace/project.ts";
import * as Effect from "effect/Effect";
import type { GuardedWriteResult } from "../ssh/sshOwnerPickerProof.codec.guardedWrite.ts";
import { MAX_GUARDED_WRITE_BYTES } from "../ssh/sshOwnerPickerProof.guardedWriteStage.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";

export interface SelectedGuardedWorkspaceWrite {
  /** Provided only by a qualified, exact-scope dev composition with durable intent. */
  readonly apply: (input: {
    readonly relativePath: string;
    readonly operationId: string;
    readonly baseSha256: string;
    readonly contents: Uint8Array;
  }) => Promise<GuardedWriteResult>;
}

const sha256 = (value: string | undefined) => value?.length === 64 && !/[^0-9a-f]/.test(value);
const guardedPath = (path: string) =>
  path.length <= 4_095 &&
  path
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part.length <= 255 &&
        !/[^A-Za-z0-9._-]/.test(part) &&
        part !== "." &&
        part !== ".." &&
        !part.toLowerCase().startsWith(".bigbud-"),
    );

export function guardedPreview(
  preview: ProjectReadFilePreviewResult,
  guarded: SelectedGuardedWorkspaceWrite | undefined,
): ProjectReadFilePreviewResult {
  if (
    !guarded ||
    !sha256(preview.sha256) ||
    preview.truncated ||
    preview.sizeBytes > MAX_GUARDED_WRITE_BYTES ||
    !guardedPath(preview.relativePath)
  )
    return preview;
  return { ...preview, edit: { mode: "guarded", maxBytes: MAX_GUARDED_WRITE_BYTES } };
}

export const writeGuardedDevWorkspaceFile = Effect.fn("WsSshOwnerWorkspace.guardedWrite")(
  function* (
    input: ProjectWriteFileInput,
    relativePath: string,
    guarded: SelectedGuardedWorkspaceWrite,
  ) {
    const error = (
      detail: string,
      options: Partial<
        Pick<WorkspaceFileSystemError, "conflict" | "currentSha256" | "writeDisposition">
      > = {},
    ) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath,
        operation: "workspaceFileSystem.writeFileExpectedHashRemote",
        detail,
        retryable: false,
        writeDisposition: "not-dispatched",
        ...options,
      });
    const { expectedSha256, operationId } = input;
    if (!expectedSha256 || !sha256(expectedSha256) || !operationId || !guardedPath(relativePath))
      return yield* error("A guarded save requires an exact file, version hash and operation ID.");
    if (
      input.contents.length > MAX_GUARDED_WRITE_BYTES ||
      input.contents.includes("\0") ||
      /[\uD800-\uDFFF]/u.test(input.contents)
    )
      return yield* error("The guarded save requires UTF-8 text of at most 512 KiB.");
    const contents = new TextEncoder().encode(input.contents);
    if (contents.byteLength > MAX_GUARDED_WRITE_BYTES)
      return yield* error("The guarded save requires UTF-8 text of at most 512 KiB.");
    const result = yield* Effect.tryPromise({
      try: () => guarded.apply({ relativePath, operationId, baseSha256: expectedSha256, contents }),
      catch: (cause) =>
        cause instanceof RemoteTargetDisconnectedError
          ? error("The SSH workspace is disconnected.")
          : error("The guarded save could not be confirmed.", { writeDisposition: "unknown" }),
    });
    if (result.kind === "saved") return { relativePath, resultSha256: result.resultSha256 };
    if (result.kind === "conflict")
      return yield* error("Workspace file changed since it was read.", {
        conflict: true,
        writeDisposition: "terminal",
        ...(result.currentSha256 ? { currentSha256: result.currentSha256 } : {}),
      });
    return yield* error("The guarded save did not return a successful receipt.", {
      writeDisposition: result.kind,
    });
  },
);
