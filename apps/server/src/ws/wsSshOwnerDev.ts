import * as Effect from "effect/Effect";
import path from "node:path";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  ServerUnlockSshKeyError,
  ServerUnlockSshPasswordError,
  ServerVerifyExecutionTargetError,
} from "@bigbud/contracts/server/server";
import { ServerTrustSshHostError } from "@bigbud/contracts/server/server.sshHostTrust";
import { ServerRemoteConnectionError } from "@bigbud/contracts/server/server.remoteConnection";
import {
  ServerListSshConfigHostsError,
  type ServerListSshConfigHostsResult,
} from "@bigbud/contracts/server/server.sshConfig";
import { sshConfigHostsFromOwnerAliases } from "../ssh/sshConfigDiscovery.ts";
import { listRemoteFoldersEffect } from "./wsRemoteFolders.ts";
import { DevSshOwnerRuntime } from "../ssh/sshOwnerDevRuntime.ts";
import { isDevSshOwnerSelected } from "../ssh/sshOwnerDevMode.ts";
import {
  forgetSshMonitorTarget,
  recordVerifiedSshMonitorTarget,
  sshMonitorCallerId,
} from "../ssh/sshMonitor.connections.ts";
import { makeSelectedSshMonitorHealth } from "../ssh/sshMonitor.healthOwner.ts";
import type { SshMonitorRpcOptions } from "./wsSshMonitor.handlers.ts";

export const makeWsSshOwnerDevHandlers = Effect.fn("makeWsSshOwnerDevHandlers")(function* (
  monitorInstanceId?: string,
) {
  if (!isDevSshOwnerSelected()) return undefined;
  const runtime = yield* Effect.serviceOption(DevSshOwnerRuntime);
  if (runtime._tag === "None" || !runtime.value.session)
    return yield* Effect.die(new Error("Missing Rust SSH owner development service"));
  const session = runtime.value.session;
  const { alias, targetId, fixture, picker, sql, terminal } = session;
  const workspace =
    session.kind === "unix" || session.kind === "retained-unix"
      ? session.kind === "unix" && "guardedWorkspace" in session && session.guardedWorkspace
        ? session.guardedWorkspace
        : { targetId, workspaceRoot: session.fixture.folder, withOwner: session.picker.withOwner }
      : undefined;
  // Reachability is qualified only for the generated, non-retained direct fixture.
  const monitorHealth =
    session.kind === "unix" && !("configuredHost" in session && session.configuredHost)
      ? makeSelectedSshMonitorHealth(targetId, session.fixture.folder, session.picker.withOwner)
      : undefined;
  const hosts = {
    machineName: "Rust SSH owner (development)",
    hosts: [
      {
        alias,
        sourcePath: fixture.root,
        line: 0,
        hostName: fixture.loopback,
      },
    ],
    sources: [],
    developmentOwnerTargetId: targetId,
    ...(terminal ? {} : { developmentOwnerTerminalUnsupported: true }),
    ...(workspace ? {} : { developmentOwnerBrowseOnly: true }),
    ...(session.kind === "linux-jump" && !session.firstUse
      ? { developmentOwnerPrePinnedJump: true }
      : {}),
  } satisfies ServerListSshConfigHostsResult;
  // The selected normal-dev path lists from the owner's own config scope. The
  // static host is only a bootstrap/fallback when no alias config is bound.
  const selectedHosts = () => {
    const guarded = "guardedWorkspace" in session && session.guardedWorkspace;
    if (session.kind !== "unix" || guarded) return Effect.succeed(hosts);
    return Effect.tryPromise({
      try: async () => {
        const aliases = await picker.listAliases();
        return {
          ...sshConfigHostsFromOwnerAliases(
            aliases,
            path.join(fixture.root, "owner-alias.conf"),
            hosts.machineName,
          ),
          developmentOwnerTargetId: targetId,
          ...(terminal ? {} : { developmentOwnerTerminalUnsupported: true }),
          ...(workspace ? {} : { developmentOwnerBrowseOnly: true }),
        } satisfies ServerListSshConfigHostsResult;
      },
      catch: (cause) =>
        new ServerListSshConfigHostsError({
          message:
            cause instanceof Error && cause.message.trim()
              ? `Failed to list owner aliases: ${cause.message.trim()}`
              : "Failed to list owner aliases.",
          cause,
        }),
    });
  };
  const run =
    <I, A, E>(
      action: (input: I) => Promise<A>,
      kind: new (fields: { message: string; cause: unknown }) => E,
    ) =>
    (input: I) =>
      Effect.tryPromise({
        try: () => action(input),
        catch: (cause) =>
          new kind({
            message: cause instanceof Error ? cause.message : "Rust SSH owner request failed.",
            cause,
          }),
      });
  const verify = run(async (input: Parameters<typeof picker.verifyExecutionTarget>[0]) => {
    if (session.kind === "linux-jump")
      throw new ServerVerifyExecutionTargetError({
        message: "This development jump target supports folder browsing only.",
      });
    const result = await picker.verifyExecutionTarget(input);
    if (!workspace)
      throw new ServerVerifyExecutionTargetError({
        message:
          "The Windows Rust SSH owner development fixture supports browsing, not saved workspaces.",
      });
    if (result.cwd !== workspace.workspaceRoot) {
      throw new ServerVerifyExecutionTargetError({
        message: "Choose the disposable picker’s folders; literal workspace root.",
      });
    }
    return result;
  }, ServerVerifyExecutionTargetError);
  const disconnect = run(async (input: Parameters<typeof picker.disconnectExecutionTarget>[0]) => {
    const result = await picker.disconnectExecutionTarget(input);
    if (monitorHealth && result.executionTargetId === monitorHealth.targetId && result.disconnected)
      forgetSshMonitorTarget(monitorHealth.targetId);
    return result;
  }, ServerRemoteConnectionError);
  const handlers = {
    [WS_METHODS.serverListSshConfigHosts]: () => selectedHosts(),
    [WS_METHODS.serverListRemoteFolders]: (input: Parameters<typeof picker.listRemoteFolders>[0]) =>
      listRemoteFoldersEffect(input, picker.listRemoteFolders),
    [WS_METHODS.serverTrustSshHost]: run(picker.trustSshHost, ServerTrustSshHostError),
    // A selected owner never lets legacy credential operations handle this profile.
    [WS_METHODS.serverUnlockSshKey]: run(picker.unlockSshKey, ServerUnlockSshKeyError),
    [WS_METHODS.serverUnlockSshPassword]: run(
      picker.unlockSshPassword,
      ServerUnlockSshPasswordError,
    ),
    [WS_METHODS.serverVerifyExecutionTarget]: (
      input: Parameters<typeof verify>[0],
      options?: SshMonitorRpcOptions,
    ) =>
      verify(input).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (monitorHealth && result.executionTargetId === monitorHealth.targetId) {
              recordVerifiedSshMonitorTarget(
                result.executionTargetId,
                sshMonitorCallerId(monitorInstanceId, options?.clientId),
              );
            }
          }),
        ),
      ),
    [WS_METHODS.serverConnectExecutionTarget]: run(
      picker.connectExecutionTarget,
      ServerRemoteConnectionError,
    ),
    [WS_METHODS.serverDisconnectExecutionTarget]: (
      input: Parameters<typeof picker.disconnectExecutionTarget>[0],
    ) =>
      Effect.tryPromise(async () => terminal?.closeForDisconnect(input.executionTargetId)).pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Rust SSH terminal close was unconfirmed; its durable route stays reserved.",
          ),
        ),
        Effect.andThen(disconnect(input)),
      ),
    [WS_METHODS.serverListDisconnectedExecutionTargets]: () =>
      sql<{ target_id: string }>`
      SELECT target_id FROM remote_execution_target_disconnects WHERE target_id = ${targetId}
    `.pipe(
        Effect.map((rows) => ({ executionTargetIds: rows.map((row) => row.target_id) })),
        Effect.mapError(
          (cause) =>
            new ServerRemoteConnectionError({
              message: "Could not read Rust owner connection state.",
              cause,
            }),
        ),
      ),
  };
  return {
    handlers,
    workspace,
    monitorHealth,
  };
});
