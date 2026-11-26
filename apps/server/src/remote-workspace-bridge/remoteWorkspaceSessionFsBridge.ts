import fs from "node:fs/promises";
import path from "node:path";

import type { SessionFsConfig, SessionFsProvider } from "@github/copilot-sdk";

import { runToolCommand, resolveToolTransportTarget } from "../tool-transport/toolTransport.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceBridge } from "./remoteWorkspaceBridge.ts";
import {
  createRemoteSessionFsProvider,
  type RemoteSessionFsShellOptions,
} from "./remoteWorkspaceSessionFsBridge.handler.ts";
import {
  assertRemoteWorkspaceBridgeOperationSupported,
  makeSelectedOwnerReadinessProbe,
  probeRemoteWorkspaceReadiness,
  type RemoteWorkspaceReadinessProbe,
} from "./remoteWorkspaceReadiness.ts";
import {
  createSelectedSessionFsProvider,
  type SessionFsOwnerCapability,
} from "./remoteWorkspaceSessionFsBridge.ownerProvider.ts";
import { isSshOwnerDevFixtureSelected } from "../ssh/sshOwnerSelection.ts";
import { usesProductionAcpBridge } from "./remoteWorkspaceAcpBridge.production.ts";
import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import { withProductionWorkspaceOwner } from "../ws/wsSshOwnerProduction.workspace.ts";
export {
  createErrnoError,
  REMOTE_WORKSPACE_SESSION_STATE_PATH,
  remoteWorkspaceSessionFsInvocationId,
  resolveSessionFsPath,
  resolveSessionStateFsPath,
  type ResolvedSessionFsPath,
} from "./remoteWorkspaceSessionFsBridge.paths.ts";
import {
  REMOTE_WORKSPACE_SESSION_STATE_PATH,
  type ResolvedSessionFsPath,
} from "./remoteWorkspaceSessionFsBridge.paths.ts";
const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

export interface RemoteWorkspaceSessionFsBridge {
  readonly cwd: string;
  readonly initialCwd: string;
  readonly sessionFsConfig: SessionFsConfig;
  createSessionFsHandler(sessionId?: string): SessionFsProvider;
  cleanup(): Promise<void>;
}

export async function createRemoteWorkspaceSessionFsBridge(
  workspaceTarget: WorkspaceTarget,
  prefix: string,
  readmeLines: ReadonlyArray<string>,
  readinessProbe: RemoteWorkspaceReadinessProbe = probeRemoteWorkspaceReadiness,
  selectedOwner?: SessionFsOwnerCapability,
): Promise<RemoteWorkspaceSessionFsBridge> {
  // W2 T-files: production activation binds the live owner's exact target and the
  // session's own root (the same workspace verbs as the ACP bridge); no legacy path.
  const production: SessionFsOwnerCapability | undefined =
    workspaceTarget.location === "remote" && usesProductionAcpBridge(workspaceTarget)
      ? {
          targetId: workspaceTarget.executionTargetId,
          // An absent root is refused by the owner's root rule, never defaulted.
          workspaceRoot: workspaceTarget.cwd ?? "",
          withOwner: (id, use, signal) =>
            withProductionWorkspaceOwner(readSshOwnerProductionOwner, id, use, signal),
        }
      : undefined;
  const sessionFsOwner: SessionFsOwnerCapability | undefined = production ?? selectedOwner;
  const selected =
    (isSshOwnerDevFixtureSelected() || production !== undefined) &&
    workspaceTarget.location === "remote";
  // A provider-supplied readiness probe cannot grant authority to the legacy session FS.
  assertRemoteWorkspaceBridgeOperationSupported(
    workspaceTarget,
    "session-filesystem",
    selected && sessionFsOwner !== undefined,
  );
  const readiness =
    selected && sessionFsOwner ? makeSelectedOwnerReadinessProbe(sessionFsOwner) : readinessProbe;
  const readinessResult = await readiness(workspaceTarget);
  const bridge = await createRemoteWorkspaceBridge({ workspaceTarget, prefix, readmeLines });
  const stateRoot = path.join(bridge.bridgeDir, "session-state");
  await fs.mkdir(stateRoot, { recursive: true });
  const transportTarget = resolveToolTransportTarget(workspaceTarget);
  const initialCwd = workspaceTarget.cwd ?? "/";
  const runRemoteShell = (
    script: string,
    args: ReadonlyArray<string>,
    options?: RemoteSessionFsShellOptions,
  ) =>
    runToolCommand({
      target: transportTarget,
      ...(options?.invocationId !== undefined ? { invocationId: options.invocationId } : {}),
      command: "sh",
      args: ["-lc", script, "bigbud-session-fs", ...args],
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      timeoutMs: options?.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
    });

  return {
    cwd: bridge.cwd,
    initialCwd,
    sessionFsConfig: {
      initialCwd,
      sessionStatePath: REMOTE_WORKSPACE_SESSION_STATE_PATH,
      conventions: "posix",
    },
    createSessionFsHandler: (sessionId = "bigbud-session-fs") =>
      selected && sessionFsOwner
        ? createSelectedSessionFsProvider({
            capability: sessionFsOwner,
            initialCwd,
            bridgeCwd: bridge.cwd,
            stateRoot,
          })
        : createRemoteSessionFsProvider({
            sessionId,
            initialCwd,
            bridgeCwd: bridge.cwd,
            stateRoot,
            readiness: readinessResult,
            runRemoteShell,
          }),
    cleanup: bridge.cleanup,
  };
}
