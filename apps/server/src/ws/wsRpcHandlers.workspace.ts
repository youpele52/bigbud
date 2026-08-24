import { Effect, Schema, Stream } from "effect";
import {
  ProjectDirectoryWatchError,
  ProjectListDirectoryError,
  ProjectReadFilePreviewError,
  ProjectSearchFileContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
} from "@bigbud/contracts/workspace/project.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths";
import type { WsRpcContext } from "./wsRpcContext";

export function makeWorkspaceWsRpcHandlers(
  context: WsRpcContext,
  toProjectDirectoryWatchError: (cause: any) => ProjectDirectoryWatchError,
) {
  return {
    [WS_METHODS.projectsSearchEntries]: (
      input: Parameters<WsRpcContext["workspaceRuntime"]["search"]["searchEntries"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchEntries,
        context.workspaceRuntime.search.searchEntries(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                message: `Failed to search workspace entries: ${cause.detail}`,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsSearchFileContents]: (
      input: Parameters<WsRpcContext["workspaceRuntime"]["search"]["searchFileContents"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchFileContents,
        context.workspaceRuntime.search.searchFileContents(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : `Failed to search workspace file contents: ${cause.detail}`;
            return new ProjectSearchFileContentsError({ message, cause });
          }),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsListDirectory]: (
      input: Parameters<WsRpcContext["workspaceRuntime"]["files"]["listDirectory"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsListDirectory,
        context.workspaceRuntime.files.listDirectory(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectListDirectoryError({
                message: `Failed to list workspace directory: ${cause.detail}`,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.subscribeProjectDirectoryChanges]: (
      input: Parameters<WsRpcContext["workspaceRuntime"]["watch"]["watchDirectory"]>[0],
    ) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeProjectDirectoryChanges,
        context.workspaceRuntime.watch.watchDirectory(input).pipe(
          Effect.map((stream) =>
            stream.pipe(
              Stream.mapError(
                (cause) =>
                  new ProjectDirectoryWatchError({
                    message: `Failed to watch workspace directory: ${
                      Schema.is(WorkspaceFileSystemError)(cause)
                        ? cause.detail
                        : "Workspace directory path is outside the project root."
                    }`,
                    retryable: Schema.is(WorkspaceFileSystemError)(cause)
                      ? cause.retryable !== false
                      : false,
                    cause,
                  }),
              ),
            ),
          ),
          Effect.mapError(toProjectDirectoryWatchError),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsReadFilePreview]: (
      input: Parameters<WsRpcContext["workspaceRuntime"]["files"]["readFilePreview"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsReadFilePreview,
        context.workspaceRuntime.files.readFilePreview(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : `Failed to read workspace file preview: ${cause.detail}`;
            return new ProjectReadFilePreviewError({ message, cause });
          }),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsWriteFile]: (
      input: Parameters<WsRpcContext["workspaceRuntime"]["files"]["writeFile"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsWriteFile,
        context.workspaceRuntime.files.writeFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : "Failed to write workspace file";
            return new ProjectWriteFileError({ message, cause });
          }),
        ),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.shellOpenInEditor]: (input: Parameters<WsRpcContext["open"]["openInEditor"]>[0]) =>
      observeRpcEffect(WS_METHODS.shellOpenInEditor, context.open.openInEditor(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.shellOpenInTerminal]: (
      input: Parameters<WsRpcContext["open"]["openInTerminal"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.shellOpenInTerminal, context.open.openInTerminal(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.shellOpenPath]: (input: Parameters<WsRpcContext["open"]["openPath"]>[0]) =>
      observeRpcEffect(WS_METHODS.shellOpenPath, context.open.openPath(input), {
        "rpc.aggregate": "workspace",
      }),
  };
}
