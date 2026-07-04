import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Effect, Schema, Stream } from "effect";
import {
  ProjectDirectoryWatchError,
  ProjectListDirectoryError,
  ProjectReadFilePreviewError,
  ProjectSearchFileContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ServerExportThreadContextError,
  ServerMobileRemoteError,
  ServerReadDocumentUrlError,
  ServerWriteHandoffDocumentError,
  ThreadId,
  WS_METHODS,
} from "@bigbud/contracts";

import { readPromptTextFromUrl } from "../attachments/documentUrl";
import { exportThreadContext } from "../orchestration/ThreadContextExport";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths";
import type { WsRpcContext } from "./wsRpcContext";
import { makeServerConfigUpdateStream } from "./wsStreams";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";

const HANDOFF_TMP_DIR = path.join(homedir(), ".bigbud", "skills", "handoff", "tmp");

function slugifyHandoffTitle(value: string | undefined): string {
  const base = (value ?? "handoff")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base.length > 0 ? base : "handoff";
}

export async function writeHandoffDocumentFile(input: {
  readonly title?: string | undefined;
  readonly content: string;
}): Promise<string> {
  await mkdir(HANDOFF_TMP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const suffix = crypto.randomUUID().slice(0, 8);
  const fileName = `${stamp}-${slugifyHandoffTitle(input.title)}-${suffix}.md`;
  const filePath = path.join(HANDOFF_TMP_DIR, fileName);
  await writeFile(filePath, `${input.content.trim()}\n`, "utf8");
  return filePath;
}

export function makeServerWsRpcHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverGetConfig]: (_input: unknown) =>
      observeRpcEffect(WS_METHODS.serverGetConfig, context.loadServerConfig, {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverRefreshProviders]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverRefreshProviders,
        context.providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverGetSettings]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverGetSettings,
        Effect.gen(function* () {
          const providers = yield* context.providerRegistry.getProviders;
          const rawSettings = yield* context.serverSettings.getSettings;
          return resolveTextGenByProbeStatus(rawSettings, providers);
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUpdateSettings]: (input: {
      readonly patch: Parameters<WsRpcContext["serverSettings"]["updateSettings"]>[0];
    }) =>
      observeRpcEffect(
        WS_METHODS.serverUpdateSettings,
        context.serverSettings.updateSettings(input.patch),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverReadDocumentUrl]: (input: { readonly url: string }) =>
      observeRpcEffect(
        WS_METHODS.serverReadDocumentUrl,
        Effect.tryPromise({
          try: async () => {
            const result = await readPromptTextFromUrl({ url: input.url });
            if (!result) {
              throw new Error("No readable document content was found at that URL.");
            }
            return result;
          },
          catch: (cause) =>
            new ServerReadDocumentUrlError({
              message: "Failed to read document URL",
              cause,
            }),
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverWriteHandoffDocument]: (input: {
      readonly title?: string | undefined;
      readonly content: string;
    }) =>
      observeRpcEffect(
        WS_METHODS.serverWriteHandoffDocument,
        Effect.tryPromise({
          try: async () => ({ path: await writeHandoffDocumentFile(input) }),
          catch: (cause) =>
            new ServerWriteHandoffDocumentError({
              message: "Failed to write handoff document",
              cause,
            }),
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverExportThreadContext]: (input: { readonly threadId: ThreadId }) =>
      observeRpcEffect(
        WS_METHODS.serverExportThreadContext,
        Effect.gen(function* () {
          const snapshot = yield* context.projectionSnapshotQuery.getSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new ServerExportThreadContextError({
                  message: "Failed to read thread snapshot",
                  cause,
                }),
            ),
          );
          return yield* Effect.tryPromise({
            try: async () =>
              exportThreadContext({
                threadId: input.threadId,
                snapshot,
                stateDir: context.config.stateDir,
              }),
            catch: (cause) =>
              new ServerExportThreadContextError({
                message: cause instanceof Error ? cause.message : "Failed to export thread context",
                cause,
              }),
          });
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverCreateMobileRemotePairing]: (input: {
      readonly scope: "read-only" | "approve-only" | "thread-control";
      readonly baseUrl: string;
      readonly backendBaseUrl: string;
    }) =>
      observeRpcEffect(
        WS_METHODS.serverCreateMobileRemotePairing,
        context.mobileRemoteControl.createPairing(input).pipe(
          Effect.mapError(
            (cause) =>
              new ServerMobileRemoteError({
                message: cause.message || "Failed to create mobile pairing.",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverListMobileRemoteSessions]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverListMobileRemoteSessions,
        context.mobileRemoteControl.listSessions.pipe(
          Effect.map((sessions) => ({ sessions })),
          Effect.mapError(
            (cause) =>
              new ServerMobileRemoteError({
                message: cause.message || "Failed to list mobile sessions.",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverRevokeMobileRemoteSession]: (input: { readonly sessionId: string }) =>
      observeRpcEffect(
        WS_METHODS.serverRevokeMobileRemoteSession,
        context.mobileRemoteControl.revokeSession(input.sessionId).pipe(
          Effect.mapError(
            (cause) =>
              new ServerMobileRemoteError({
                message: cause.message || "Failed to revoke mobile session.",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUpsertKeybinding]: (
      rule: Parameters<WsRpcContext["keybindings"]["upsertKeybindingRule"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverUpsertKeybinding,
        Effect.gen(function* () {
          const keybindingsConfig = yield* context.keybindings.upsertKeybindingRule(rule);
          return { keybindings: keybindingsConfig, issues: [] };
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.subscribeServerConfig]: (_input: unknown) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeServerConfig,
        makeServerConfigUpdateStream({
          loadServerConfig: context.loadServerConfig,
          keybindings: context.keybindings,
          providerRegistry: context.providerRegistry,
          discoveryRegistry: context.discoveryRegistry,
          serverSettings: context.serverSettings,
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.subscribeServerLifecycle]: (_input: unknown) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeServerLifecycle,
        Effect.gen(function* () {
          const snapshot = yield* context.lifecycleEvents.snapshot;
          const snapshotEvents = Array.from(snapshot.events).toSorted(
            (left, right) => left.sequence - right.sequence,
          );
          const liveEvents = context.lifecycleEvents.stream.pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          );
          return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
        }),
        { "rpc.aggregate": "server" },
      ),
  };
}

export function makeWorkspaceWsRpcHandlers(
  context: WsRpcContext,
  toProjectDirectoryWatchError: (cause: any) => ProjectDirectoryWatchError,
) {
  return {
    [WS_METHODS.projectsSearchEntries]: (
      input: Parameters<WsRpcContext["workspaceEntries"]["search"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchEntries,
        context.workspaceEntries.search(input).pipe(
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
      input: Parameters<WsRpcContext["workspaceFileSystem"]["searchFileContents"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsSearchFileContents,
        context.workspaceFileSystem.searchFileContents(input).pipe(
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
      input: Parameters<WsRpcContext["workspaceEntries"]["listDirectory"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsListDirectory,
        context.workspaceEntries.listDirectory(input).pipe(
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
      input: Parameters<WsRpcContext["workspaceFileSystem"]["watchDirectory"]>[0],
    ) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeProjectDirectoryChanges,
        context.workspaceFileSystem.watchDirectory(input).pipe(
          Effect.map((stream) =>
            stream.pipe(
              Stream.mapError(
                (cause) =>
                  new ProjectDirectoryWatchError({
                    message: `Failed to watch workspace directory: ${cause.detail}`,
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
      input: Parameters<WsRpcContext["workspaceFileSystem"]["readFilePreview"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsReadFilePreview,
        context.workspaceFileSystem.readFilePreview(input).pipe(
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
      input: Parameters<WsRpcContext["workspaceFileSystem"]["writeFile"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectsWriteFile,
        context.workspaceFileSystem.writeFile(input).pipe(
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
    [WS_METHODS.shellOpenPath]: (input: Parameters<WsRpcContext["open"]["openPath"]>[0]) =>
      observeRpcEffect(WS_METHODS.shellOpenPath, context.open.openPath(input), {
        "rpc.aggregate": "workspace",
      }),
  };
}
