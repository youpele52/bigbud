import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_ALREADY_EXISTS,
  WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
  WorkspaceFileSystemError,
} from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths.ts";
import { projectWriteFileError } from "./wsRpcHandlers.workspace.ts";

describe("project write errors", () => {
  const input = { cwd: "/workspace", relativePath: "src/file.txt" };
  it.each([
    [
      "workspaceFileSystem.writeFileExpectedHash",
      "Workspace file changed since it was read (expected a, actual b).",
    ],
    [
      "remoteWorkspace.writeFile",
      "remote agent rejected: workspace file changed since it was read",
    ],
  ])("reports a typed %s conflict with the disk hash", (operation, detail) => {
    const result = projectWriteFileError(
      new WorkspaceFileSystemError({
        ...input,
        operation,
        detail,
        conflict: true,
        currentSha256: "b".repeat(64),
      }),
    );
    expect(result).toMatchObject({
      conflict: true,
      currentSha256: "b".repeat(64),
      message: "Workspace file changed since it was read.",
    });
  });

  it("does not infer a conflict from message text alone", () => {
    const result = projectWriteFileError(
      new WorkspaceFileSystemError({
        ...input,
        operation: "remoteWorkspace.writeFile",
        detail: "workspace file changed since it was read",
      }),
    );
    expect(result.conflict).toBeUndefined();
    expect(result.currentSha256).toBeUndefined();
  });

  it("reports a create-only write over an existing file as alreadyExists, not a conflict", () => {
    const result = projectWriteFileError(
      new WorkspaceFileSystemError({
        ...input,
        operation: WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
        detail: WORKSPACE_FILE_ALREADY_EXISTS,
        writeDisposition: "terminal",
      }),
    );
    expect(result).toMatchObject({
      alreadyExists: true,
      message: "Workspace file already exists.",
      writeDisposition: "terminal",
    });
    expect(result.conflict).toBeUndefined();
    expect(
      projectWriteFileError(
        new WorkspaceFileSystemError({
          ...input,
          operation: "workspaceFileSystem.writeFile",
          detail: "write failed",
        }),
      ).alreadyExists,
    ).toBeUndefined();
  });

  it("does not confuse a transport failure or path error with a conflict", () => {
    expect(
      projectWriteFileError(
        new WorkspaceFileSystemError({
          ...input,
          operation: "remoteWorkspace.writeFile",
          detail: "connection lost",
        }),
      ).conflict,
    ).toBeUndefined();
    expect(
      projectWriteFileError(
        new WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        }),
      ).message,
    ).toBe("Workspace file path must stay within the project root.");
  });

  it("does not invent settlement evidence for a legacy filesystem error", () => {
    expect(
      projectWriteFileError(
        new WorkspaceFileSystemError({
          ...input,
          operation: "workspaceFileSystem.writeFile",
          detail: "write failed",
        }),
      ).writeDisposition,
    ).toBeUndefined();
  });
});
