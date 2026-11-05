import { createHash } from "node:crypto";
import { Effect } from "effect";
import { decodeV2Cursor } from "./Runtime.cursor.ts";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceMcpBridge } from "../../../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts";
import { probeRemoteWorkspaceReadiness } from "../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import { resolveV2RemoteLocation } from "./Application.remoteLocation.ts";
import { prepareV2SharedCanonicalResources } from "./Application.targets.auth.ts";
import type { V2IsolatedRuntimeOptions, V2StartInput } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";

/** One durable native Location per remote thread; credentials belong only to this acquisition. */
export async function prepareV2SharedRemoteTarget(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  workspaceTarget: WorkspaceTarget,
  stateDir: string,
  port: number,
  signal: AbortSignal,
  disableTools: boolean,
): Promise<Awaited<ReturnType<NonNullable<V2IsolatedRuntimeOptions["prepareSession"]>>>> {
  if (!options.config.sharedService || !workspaceTarget.cwd)
    throw new Error("V2 remote workspace requires a shared local service and project root.");
  // Broken older app bindings persisted the native Location as cwd. It is not a remote root.
  // Compare retained identity evidence, never path-name heuristics or a guessed inverse hash.
  const cursor = input.resumeCursor === undefined ? undefined : decodeV2Cursor(input.resumeCursor);
  if (!options.sharedBindings) throw new Error("V2 shared binding repository unavailable.");
  const retained = await Effect.runPromise(options.sharedBindings.find(input.threadId));
  if (workspaceTarget.cwd === cursor?.directory || workspaceTarget.cwd === retained?.directory)
    throw new Error(
      "V2 saved workspace contains its native Location instead of the remote root. Reconnect this thread from its original workspace to resume its existing history; no remote preparation or prompt was admitted.",
    );
  const readiness = disableTools ? undefined : await probeRemoteWorkspaceReadiness(workspaceTarget);
  signal.throwIfAborted();
  const directory = await resolveV2RemoteLocation(
    stateDir,
    input.threadId,
    workspaceTarget.executionTargetId,
    workspaceTarget.cwd,
  );
  const serverName = `bbv2_remote_${createHash("sha256").update(directory).digest("hex").slice(0, 32)}`;
  let canonical: Awaited<ReturnType<typeof prepareV2SharedCanonicalResources>> | undefined;
  let bridge: Awaited<ReturnType<typeof createRemoteWorkspaceMcpBridge>> | undefined;
  let revoked = false;
  let pendingMutations: import("./Runtime.mutations.ts").V2RuntimeMutations | undefined;
  const cleanup = async () => {
    try {
      await canonical?.cleanup();
    } finally {
      await bridge?.cleanup();
    }
    revoked = true;
    pendingMutations?.retryVerification();
  };
  return {
    options: { ...options, sharedRemoteWorkspace: { directory, workspaceTarget, serverName } },
    input: {
      ...input,
      cwd: directory,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: workspaceTarget.executionTargetId,
    },
    resources: {
      cleanup,
      remoteWorkspace: { ...workspaceTarget, serverName },
      ...(!disableTools
        ? {
            activateCanonicalTools: async (session, mutations, cancellation) => {
              try {
                pendingMutations = mutations;
                cancellation.throwIfAborted();
                const client = session.lease.process.client;
                const active = await v2Request("remote session drain", (signal) =>
                  client.session.active({ signal }),
                );
                const inbox = await v2Request("remote inbox drain", (signal) =>
                  client.session.inbox.list({ sessionID: session.native.id }, { signal }),
                );
                if (active[session.native.id] || inbox.length)
                  throw new Error(
                    "V2 remote session still has native work. Let it finish or stop it in OpenCode, then reconnect workspace tools.",
                  );
                canonical = await prepareV2SharedCanonicalResources(
                  stateDir,
                  input.threadId,
                  port,
                  {
                    executionTargetId: workspaceTarget.executionTargetId,
                    cwd: workspaceTarget.cwd!,
                  },
                );
                bridge = await createRemoteWorkspaceMcpBridge(
                  workspaceTarget,
                  "bigbud-v2-remote-workspace-",
                  [
                    "Actual project files are on the remote host. Use only bigbud remote workspace tools.",
                  ],
                  {
                    ...canonical.orchestration,
                    providerSessionId: session.native.id,
                    providerInvocationStatePath: path.join(directory, "remote-invocations.json"),
                  },
                  // Readiness was checked before any native acquisition.
                  async () => readiness!,
                  { directory, retainDirectory: true },
                );
                const location = { directory };
                const verify = async (signal?: AbortSignal) => {
                  // MCP configuration cannot execute project work after its credentials are revoked.
                  // Physical completion is still tracked by the mutation fence before it verifies.
                  if (revoked) return true;
                  const catalog = await v2Request(
                    "remote MCP readiness",
                    (signal) => client.mcp.list({ location }, { signal }),
                    signal ? { signal } : {},
                  );
                  const matches = catalog.data.filter((server) => server.name === serverName);
                  return (
                    !cancellation.aborted &&
                    session.lease.process.isRunning() &&
                    catalog.location.directory === directory &&
                    catalog.data.length <= 64 &&
                    matches.length === 1 &&
                    matches[0]!.status.status === "connected"
                  );
                };
                await mutations.withNamespace(() =>
                  mutations.runOwned(
                    session.lease.process,
                    "remote MCP registration",
                    (signal) => {
                      const register = () =>
                        client.mcp.add(
                          {
                            server: serverName,
                            location,
                            config: {
                              type: "local",
                              command: [process.execPath, bridge!.serverPath],
                              cwd: directory,
                              codemode: false,
                              disabled: false,
                              protocol: "legacy",
                            },
                          },
                          { signal },
                        );
                      return session.activation?.token
                        ? session.activation.gate.dispatch(session.activation.token, register)
                        : register();
                    },
                    verify,
                    10000,
                    cancellation,
                    false,
                    () => {
                      cancellation.throwIfAborted();
                      if (session.activation?.token)
                        session.activation.gate.assertReservation(session.activation.token);
                    },
                  ),
                );
                // Startup is read-only after the update acknowledges. A slow/disconnected MCP
                // must not turn that known-complete mutation into namespace-wide uncertainty.
                await v2Request(
                  "remote MCP connection",
                  async (signal) => {
                    while (!(await verify(signal))) await delay(100, undefined, { signal });
                  },
                  { signal: cancellation, timeoutMs: 8000 },
                );
                return { ...canonical, cleanup };
              } catch (error) {
                await cleanup();
                throw error;
              }
            },
          }
        : {}),
    },
  };
}
