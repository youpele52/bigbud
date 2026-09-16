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
  probeRemoteWorkspaceReadiness,
  type RemoteWorkspaceReadinessProbe,
} from "./remoteWorkspaceReadiness.ts";
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
): Promise<RemoteWorkspaceSessionFsBridge> {
  const readiness = await readinessProbe(workspaceTarget);
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
      createRemoteSessionFsProvider({
        sessionId,
        initialCwd,
        bridgeCwd: bridge.cwd,
        stateRoot,
        readiness,
        runRemoteShell,
      }),
    cleanup: bridge.cleanup,
  };
}
