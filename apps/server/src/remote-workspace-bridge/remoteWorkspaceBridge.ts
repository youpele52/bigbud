import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSshTransportArgs } from "../ssh/sshCommand.ts";
import { formatSshDestination, parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { assertSshExecutionTargetReady } from "../ssh/sshVerification.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { isRemoteWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";

export interface RemoteWorkspaceBridgeConfig {
  readonly executionTargetId: string;
  readonly cwd: string | undefined;
  readonly destination: string;
  readonly transportArgs: ReadonlyArray<string>;
}

export interface RemoteWorkspaceBridge {
  readonly cwd: string;
  readonly bridgeDir: string;
  readonly config: RemoteWorkspaceBridgeConfig;
  writeWorkspaceFile(relativePath: string, source: string): Promise<string>;
  cleanup(): Promise<void>;
}

function getDefaultReadmeLines(): ReadonlyArray<string> {
  return [
    "This directory is a synthetic local workspace used to run a local provider against a remote workspace.",
    "The actual project files live on the remote host configured for this thread.",
    "",
  ];
}

function assertRemoteWorkspaceTarget(workspaceTarget: WorkspaceTarget): void {
  if (!isRemoteWorkspaceTarget(workspaceTarget)) {
    throw new Error("Remote workspace bridge can only be created for remote workspaces.");
  }
}

export function resolveRemoteWorkspaceBridgeConfig(
  workspaceTarget: WorkspaceTarget,
): RemoteWorkspaceBridgeConfig | undefined {
  if (!isRemoteWorkspaceTarget(workspaceTarget)) {
    return undefined;
  }

  assertSshExecutionTargetReady(workspaceTarget.executionTargetId);
  const target = parseSshExecutionTarget(workspaceTarget.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${workspaceTarget.executionTargetId}'.`);
  }

  return {
    executionTargetId: workspaceTarget.executionTargetId,
    cwd: workspaceTarget.cwd,
    destination: formatSshDestination(target),
    transportArgs: buildSshTransportArgs({
      executionTargetId: workspaceTarget.executionTargetId,
    }),
  };
}

export async function createRemoteWorkspaceBridge(input: {
  readonly workspaceTarget: WorkspaceTarget;
  readonly prefix: string;
  readonly readmeLines?: ReadonlyArray<string>;
}): Promise<RemoteWorkspaceBridge> {
  assertRemoteWorkspaceTarget(input.workspaceTarget);
  const config = resolveRemoteWorkspaceBridgeConfig(input.workspaceTarget);
  if (!config) {
    throw new Error("Remote workspace bridge config was not available.");
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), input.prefix));
  const bridgeDir = path.join(cwd, ".bigbud");
  await fs.mkdir(bridgeDir, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "README.txt"),
    (input.readmeLines ?? getDefaultReadmeLines()).join("\n"),
    "utf8",
  );

  return {
    cwd,
    bridgeDir,
    config,
    async writeWorkspaceFile(relativePath: string, source: string): Promise<string> {
      const normalizedRelativePath = relativePath.replace(/^[/\\]+/, "");
      const absolutePath = path.join(cwd, normalizedRelativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, source, "utf8");
      return absolutePath;
    },
    cleanup() {
      return fs.rm(cwd, { recursive: true, force: true });
    },
  };
}
