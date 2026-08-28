import { Effect, Option, Schema, Stream } from "effect";
import {
  ServerCliProxyActivationError,
  ServerExportThreadContextError,
  ServerReadDocumentUrlError,
  ServerWriteHandoffDocumentError,
} from "@bigbud/contracts/server/server.ts";
import { ServerMobileRemoteError } from "@bigbud/contracts/server/mobile.ts";
import { FAVORITE_THREAD_LIMIT } from "@bigbud/contracts/constants/settings.constant.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

import { readPromptTextFromUrl } from "../attachments/documentUrl";
import { exportThreadContext } from "../orchestration/ThreadContextExport";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";
import { writeHandoffDocumentFile } from "./wsHandoffDocument";
import { makeServerConfigUpdateStream } from "./wsStreams";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";

export function makeServerWsRpcHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverPing]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverPing,
        Effect.sync(() => ({ serverTime: new Date().toISOString() })),
        { "rpc.aggregate": "server" },
      ),
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
    [WS_METHODS.serverActivateCliProxy]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverActivateCliProxy,
        context.activateCliProxy().pipe(
          Effect.map((providers) => ({ providers })),
          Effect.mapError(
            (cause) =>
              new ServerCliProxyActivationError({
                message: cause instanceof Error ? cause.message : "Failed to activate CLIProxyAPI.",
                cause,
              }),
          ),
        ),
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
    [WS_METHODS.serverSetThreadPinned]: (input: {
      readonly threadId: ThreadId;
      readonly pinned: boolean;
    }) =>
      observeRpcEffect(
        WS_METHODS.serverSetThreadPinned,
        Effect.gen(function* () {
          yield* context.dispatchNormalizedCommand({
            type: input.pinned ? "thread.pin" : "thread.unpin",
            commandId: context.serverCommandId(input.pinned ? "thread-pin" : "thread-unpin"),
            threadId: input.threadId,
          });
          const readModel = yield* context.orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
          const count = readModel.threads.filter(
            (candidate) => candidate.deletedAt === null && (candidate.pinnedAt ?? null) !== null,
          ).length;
          return {
            threadId: input.threadId,
            pinned: input.pinned,
            pinnedAt: thread?.pinnedAt ?? null,
            count,
            limit: FAVORITE_THREAD_LIMIT,
            remaining: FAVORITE_THREAD_LIMIT - count,
          };
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to update pinned thread",
                  cause,
                }),
          ),
        ),
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
          const snapshot = yield* (
            Option.isSome(context.projectionOperationalStateQuery)
              ? context.projectionOperationalStateQuery.value
                  .getFullThreadHistory(input.threadId)
                  .pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.fail(new Error("Thread was not found.")),
                        onSome: Effect.succeed,
                      }),
                    ),
                  )
              : context.projectionSnapshotQuery.getSnapshot()
          ).pipe(
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
    [WS_METHODS.serverStartHandoffJob]: (input: {
      readonly threadId: ThreadId;
      readonly focus?: string | undefined;
    }) =>
      observeRpcEffect(WS_METHODS.serverStartHandoffJob, context.handoffJobs.startJob(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverGetHandoffJob]: (input: { readonly jobId: string }) =>
      observeRpcEffect(WS_METHODS.serverGetHandoffJob, context.handoffJobs.getJob(input.jobId), {
        "rpc.aggregate": "server",
      }),
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
