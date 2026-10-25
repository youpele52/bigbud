import { createHash } from "node:crypto";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { ThreadOrchestrationHttpConfig } from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { createRemoteWorkspaceMcpBridge } from "../../../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts";
import type { RemoteWorkspaceReadinessProbe } from "../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";

/** Reuse the authenticated remote workspace bridge, with no local builtin/tool fallback. */
export async function prepareV2RemoteWorkspace(input: {
  readonly runtime: OpencodeV2Runtime;
  readonly timeoutMs?: number;
  readonly workspaceTarget: WorkspaceTarget;
  readonly httpConfig: ThreadOrchestrationHttpConfig;
  readonly profileRoot: string;
  readonly visibilityInvocationConformance: boolean;
  readonly readinessProbe?: RemoteWorkspaceReadinessProbe;
}) {
  if (
    !input.visibilityInvocationConformance ||
    input.workspaceTarget.executionTargetId === "local" ||
    input.httpConfig.host !== "127.0.0.1" ||
    !input.httpConfig.providerSessionId
  )
    throw new Error("V2 remote tool isolation conformance is unavailable.");
  const bridge = await createRemoteWorkspaceMcpBridge(
    input.workspaceTarget,
    "bigbud-v2-remote-workspace-",
    ["Synthetic V2 workspace. Actual project files are remote; local tools are unavailable."],
    input.httpConfig,
    input.readinessProbe,
  );
  const serverName = `bbv2_remote_${createHash("sha256")
    .update(JSON.stringify([input.httpConfig.threadId, input.httpConfig.providerSessionId]))
    .digest("hex")}`;
  const timeoutMs = input.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    await bridge.cleanup();
    throw new Error("V2 remote install deadline bound rejected.");
  }
  let owner: V2RuntimeSession | undefined;
  let revoked = false;
  const deny = [{ action: "*", resource: "*", effect: "deny" as const }];
  const permissions = [
    ...deny,
    { action: `${serverName}_*`, resource: "*", effect: "allow" as const },
  ];
  const verified = async (
    session: V2RuntimeSession,
    enabled: boolean | "any" | undefined,
    expected: { action: string; resource: string; effect: "deny" | "allow" }[],
  ) => {
    if (session.stopped || !session.lease.process.isRunning()) return false;
    const revocation = revoked;
    const client = session.lease.process.client;
    const [catalog, native] = await Promise.all([
      v2Request(
        "remote mcp.verify",
        (signal) => client.mcp.list({ location: { directory: bridge.cwd } }, { signal }),
        { timeoutMs },
      ),
      v2Request(
        "remote permissions.verify",
        (signal) => client.session.get({ sessionID: session.native.id }, { signal }),
        { timeoutMs },
      ),
    ]);
    const matches = catalog.data.filter((item) => item.name === serverName);
    return (
      revocation === revoked &&
      !session.stopped &&
      session.lease.process.isRunning() &&
      input.runtime.sessions.get(session.threadId) === session &&
      catalog.data.length <= 64 &&
      catalog.location.directory === bridge.cwd &&
      native.id === session.native.id &&
      native.location.directory === bridge.cwd &&
      JSON.stringify(native.permissions) === JSON.stringify(expected) &&
      (enabled === "any"
        ? matches.length <= 1
        : enabled === undefined
          ? matches.length === 0
          : matches.length === 1 &&
            matches[0]!.status.status === (enabled ? "connected" : "disabled"))
    );
  };
  const cleanup = async () => {
    revoked = true;
    if (owner)
      owner.executionBlocked = "V2 remote bridge cleanup must be verified before execution.";
    await bridge.cleanup(); // Revoke the authenticated bridge even when native teardown is uncertain.
    if (!owner) return;
    const session = owner;
    await input.runtime.withSession(session.threadId, () =>
      input.runtime.mutations.withNamespace(async () => {
        if (input.runtime.get(session.threadId) !== session)
          throw new Error("V2 remote cleanup owner changed.");
        const client = session.lease.process.client;
        await input.runtime.mutations.runOwned(
          session.lease.process,
          "remote permissions.revoke",
          (signal) =>
            client.session.update({ sessionID: session.native.id, permissions: deny }, { signal }),
          () => verified(session, "any", deny),
          timeoutMs,
          undefined,
          true,
        );
        await input.runtime.mutations.runOwned(
          session.lease.process,
          "remote mcp.remove",
          (signal) =>
            client.mcp.remove(
              { server: serverName, location: { directory: bridge.cwd } },
              { signal },
            ),
          () => verified(session, undefined, deny),
          timeoutMs,
          undefined,
          true,
        );
        if (!(await verified(session, undefined, deny)))
          throw new Error("V2 remote cleanup state unverified.");
        owner = undefined;
        session.executionBlocked = undefined;
      }),
    );
  };
  return {
    cwd: bridge.cwd,
    cleanup,
    authorization: {
      providerRuntimeTargetId: "local",
      workspaceTargetId: input.workspaceTarget.executionTargetId,
      profileRoot: input.profileRoot,
      syntheticDirectory: bridge.cwd,
    },
    install: async (session: V2RuntimeSession) => {
      return input.runtime.withSession(session.threadId, () =>
        input.runtime.mutations.withNamespace(async () => {
          if (
            revoked ||
            owner ||
            input.runtime.get(session.threadId) !== session ||
            session.threadId !== input.httpConfig.threadId ||
            session.native.id !== input.httpConfig.providerSessionId ||
            session.native.location.directory !== bridge.cwd ||
            session.session.workspaceExecutionTargetId !==
              input.workspaceTarget.executionTargetId ||
            session.row
          )
            throw new Error("V2 remote bridge session ownership rejected.");
          session.lease.claimExclusive();
          owner = session;
          const client = session.lease.process.client;
          const location = { directory: bridge.cwd };
          // This exact generated experimental operation is still a preview approval gate.
          try {
            await input.runtime.mutations.runOwned(
              session.lease.process,
              "remote mcp.add",
              (signal) =>
                client.mcp.add(
                  {
                    server: serverName,
                    location,
                    config: {
                      type: "local",
                      command: [process.execPath, bridge.serverPath],
                      codemode: false,
                      disabled: false,
                    },
                  },
                  { signal },
                ),
              () => verified(session, revoked ? undefined : true, deny),
              timeoutMs,
              undefined,
              true,
            );
            await input.runtime.mutations.runOwned(
              session.lease.process,
              "remote session.update",
              (signal) =>
                client.session.update(
                  {
                    sessionID: session.native.id,
                    permissions,
                  },
                  { signal },
                ),
              () => verified(session, revoked ? undefined : true, revoked ? deny : permissions),
              timeoutMs,
              undefined,
              true,
            );
            return serverName;
          } catch (error) {
            revoked = true;
            session.executionBlocked =
              "V2 partial remote installation requires verified cleanup; no prompt admitted.";
            await bridge.cleanup();
            throw error;
          }
        }),
      );
    },
  };
}
