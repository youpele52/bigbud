import { Effect, Schema, Stream } from "effect";
import {
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationReplayEventsError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  WS_METHODS,
} from "@bigbud/contracts";
import { clamp } from "effect/Number";

import { WorkspacePathOutsideRootError } from "../workspace/Services/WorkspacePaths";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";
import {
  makeOrderedOrchestrationDomainEventStream,
  makeServerConfigUpdateStream,
  makeThinkingActivityDeltaStream,
} from "./wsStreams";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";

export function makeWsRpcOrchestrationServerHandlers(context: WsRpcContext) {
  return {
    [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input: unknown) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getSnapshot,
        context.projectionSnapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (
      command: Parameters<WsRpcContext["normalizeDispatchCommand"]>[0],
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        Effect.gen(function* () {
          const normalizedCommand = yield* context.normalizeDispatchCommand(command);
          if (normalizedCommand.type === "thread.shell.run") {
            return yield* context.dispatchShellCommand(normalizedCommand);
          }
          const result = yield* context.dispatchNormalizedCommand(normalizedCommand);
          if (normalizedCommand.type === "thread.archive") {
            yield* context.terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to close thread terminals after archive", {
                  threadId: normalizedCommand.threadId,
                  error: error.message,
                }),
              ),
            );
          }
          return result;
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getTurnDiff]: (
      input: Parameters<WsRpcContext["checkpointDiffQuery"]["getTurnDiff"]>[0],
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        context.checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (
      input: Parameters<WsRpcContext["checkpointDiffQuery"]["getFullThreadDiff"]>[0],
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        context.checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.replayEvents]: (input: { readonly fromSequenceExclusive: number }) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.replayEvents,
        Stream.runCollect(
          context.orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          ),
        ).pipe(
          Effect.map((events) => Array.from(events)),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input: unknown) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeOrchestrationDomainEvents,
        makeOrderedOrchestrationDomainEventStream({
          orchestrationEngine: context.orchestrationEngine,
        }),
        { "rpc.aggregate": "orchestration" },
      ),
    [WS_METHODS.subscribeThinkingActivityDeltas]: (_input: unknown) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeThinkingActivityDeltas,
        makeThinkingActivityDeltaStream({
          providerService: context.providerService,
          serverSettings: context.serverSettings,
        }),
        { "rpc.aggregate": "orchestration" },
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
    [WS_METHODS.serverGetSettings]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverGetSettings,
        Effect.gen(function* () {
          const providers = yield* context.providerRegistry.getProviders;
          const rawSettings = yield* context.serverSettings.getSettings;
          return resolveTextGenByProbeStatus(rawSettings, providers);
        }),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverUpdateSettings]: (input: {
      readonly patch: Parameters<WsRpcContext["serverSettings"]["updateSettings"]>[0];
    }) =>
      observeRpcEffect(
        WS_METHODS.serverUpdateSettings,
        context.serverSettings.updateSettings(input.patch),
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
