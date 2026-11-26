import type { RemoteAgentPtyResolver } from "../remote-agent/remoteAgentPtyAdapter.ts";
import { createRemoteAgentWorkspacePty } from "../remote-agent/remoteAgentPtyAdapter.ts";
import {
  AcpTerminalOwnerError,
  createOwnedAcpTerminal,
  type SelectedAcpTerminalOwner,
} from "./remoteWorkspaceAcpTerminal.owner.ts";

export interface AcpTerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | number | null;
}

export interface AcpTerminalProcess {
  kill(signal?: NodeJS.Signals): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: AcpTerminalExit) => void): () => void;
  onError(callback: (error: Error) => void): () => void;
  close(terminate?: boolean): Promise<void>;
}

export async function createRemoteWorkspaceAcpTerminal(input: {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly ptyResolver: RemoteAgentPtyResolver | undefined;
  readonly sshOwner?: SelectedAcpTerminalOwner;
}): Promise<AcpTerminalProcess> {
  if (input.sshOwner) {
    if (input.ptyResolver) throw new AcpTerminalOwnerError("unsupported-target");
    return createOwnedAcpTerminal(input, input.sshOwner);
  }
  // A managed-agent PTY serves agent targets only. A direct SSH target needs
  // the owner capability; there is no TypeScript SSH launch to fall back to.
  if (input.ptyResolver) {
    return createRemoteAgentWorkspacePty(
      {
        executionTargetId: input.executionTargetId,
        workspaceRoot: input.workspaceRoot,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        command: input.command,
        args: input.args ?? [],
        cols: 80,
        rows: 24,
        ...(input.environment ? { environment: input.environment } : {}),
      },
      input.ptyResolver,
    );
  }

  throw new AcpTerminalOwnerError("ssh-owner-unavailable");
}
