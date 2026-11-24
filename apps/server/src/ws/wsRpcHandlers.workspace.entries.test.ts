import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

import {
  WORKSPACE_DELETE_ENTRY_OPERATION,
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
} from "../workspace-runtime/Services/WorkspaceMutations.ts";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths.ts";
import {
  makeWorkspaceEntryWsRpcHandlers,
  projectEntryMutationError,
} from "./wsRpcHandlers.workspace.entries.ts";

const input = { cwd: "/workspace", relativePath: "src" };
const error = (detail: string, writeDisposition?: "terminal" | "not-dispatched") =>
  new WorkspaceFileSystemError({
    ...input,
    operation: WORKSPACE_DELETE_ENTRY_OPERATION,
    detail,
    ...(writeDisposition ? { writeDisposition } : {}),
  });

describe("project entry mutation errors", () => {
  it("marks already-exists and not-found from the typed detail", () => {
    expect(
      projectEntryMutationError(error(WORKSPACE_ENTRY_ALREADY_EXISTS, "terminal"), "x"),
    ).toMatchObject({
      alreadyExists: true,
      message: WORKSPACE_ENTRY_ALREADY_EXISTS,
      mutationDisposition: "terminal",
    });
    expect(projectEntryMutationError(error(WORKSPACE_ENTRY_NOT_FOUND), "x").notFound).toBe(true);
    expect(projectEntryMutationError(error("disk full"), "x").alreadyExists).toBeUndefined();
  });

  it("reports a path outside the root as not dispatched", () => {
    const result = projectEntryMutationError(
      new WorkspacePathOutsideRootError({ workspaceRoot: "/workspace", relativePath: ".." }),
      "x",
    );
    expect(result).toMatchObject({
      message: "Workspace file path must stay within the project root.",
      mutationDisposition: "not-dispatched",
    });
  });

  it("refuses every operation when the context has no mutations", async () => {
    const handlers = makeWorkspaceEntryWsRpcHandlers(undefined);
    const actions = await Effect.runPromise(
      handlers[WS_METHODS.projectsEntryActions]({ cwd: "/workspace" }),
    );
    expect(actions.delete).toMatchObject({ allowed: false, reason: "unsupportedTarget" });
    const exit = await Effect.runPromiseExit(
      handlers[WS_METHODS.projectsDeleteEntry]({ ...input, expectedKind: "directory" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("not-dispatched");
    }
  });
});
