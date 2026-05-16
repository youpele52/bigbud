import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSshTransportArgs } from "../../../ssh/sshCommand.ts";
import { formatSshDestination, parseSshExecutionTarget } from "../../../ssh/sshExecutionTarget.ts";
import { assertSshExecutionTargetReady } from "../../../ssh/sshVerification.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { renderPiRemoteWorkspaceBridgeSource } from "./PiRemoteWorkspaceBridge.template.ts";

const PI_REMOTE_WORKSPACE_BRIDGE_PREFIX = "bigbud-pi-remote-workspace-";

export interface PiRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly extensionPath: string;
  readonly extraArgs: ReadonlyArray<string>;
  readonly cleanup: () => Promise<void>;
}

export async function createPiRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
): Promise<PiRemoteWorkspaceBridge> {
  if (!isRemoteWorkspaceTarget(workspaceTarget)) {
    throw new Error("Pi remote workspace bridge can only be created for remote workspaces.");
  }

  assertSshExecutionTargetReady(workspaceTarget.executionTargetId);
  const target = parseSshExecutionTarget(workspaceTarget.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${workspaceTarget.executionTargetId}'.`);
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), PI_REMOTE_WORKSPACE_BRIDGE_PREFIX));
  const bridgeDir = path.join(cwd, ".bigbud");
  await fs.mkdir(bridgeDir, { recursive: true });
  const extensionPath = path.join(bridgeDir, "bigbud-remote-workspace-bridge.ts");
  const extensionSource = renderPiRemoteWorkspaceBridgeSource({
    ...(workspaceTarget.cwd ? { cwd: workspaceTarget.cwd } : {}),
    destination: formatSshDestination(target),
    transportArgs: buildSshTransportArgs({
      executionTargetId: workspaceTarget.executionTargetId,
    }),
  });

  await fs.writeFile(extensionPath, extensionSource, "utf8");
  await fs.writeFile(
    path.join(cwd, "README.txt"),
    [
      "This directory is a synthetic local workspace used to run Pi against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    cwd,
    extensionPath,
    extraArgs: ["--no-builtin-tools", "--no-extensions", "--extension", extensionPath],
    cleanup: () => fs.rm(cwd, { recursive: true, force: true }),
  };
}
