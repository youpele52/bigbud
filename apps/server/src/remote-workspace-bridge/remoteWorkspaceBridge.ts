import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { isRemoteWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";

export interface RemoteWorkspaceBridge {
  readonly cwd: string;
  readonly bridgeDir: string;
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

export async function createRemoteWorkspaceBridge(input: {
  readonly workspaceTarget: WorkspaceTarget;
  readonly prefix: string;
  readonly readmeLines?: ReadonlyArray<string>;
}): Promise<RemoteWorkspaceBridge> {
  assertRemoteWorkspaceTarget(input.workspaceTarget);

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
