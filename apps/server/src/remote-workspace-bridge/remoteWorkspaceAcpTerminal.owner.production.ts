import { PassThrough } from "node:stream";

import type { ProductionShellLease } from "../ssh/sshOwnerPickerProof.client.productionShell.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import {
  productionShellTarget,
  type ProductionOwnerSource,
} from "../ssh/sshShellRunner.production.ts";
import { validatedCwd, validatedScope } from "./remoteWorkspaceAcpTerminal.owner.proof.ts";
import {
  AcpTerminalOwnerError,
  type AcpOwnerCommandLease,
  type AcpOwnerExit,
  type AcpTerminalSshOwner,
} from "./remoteWorkspaceAcpTerminal.owner.ts";

/** U21: the provider-shell ceiling; the owner applies the same bound. */
const ACP_SHELL_TIMEOUT_MS = 120_000;

/**
 * W2 T-shell production ACP terminal owner. `runAcpCommand` is the approved
 * fixed `pwd` recipe; `runAcpShell` (U21) is one approved `terminal/create`
 * command as its own owner grant with the provider-shell bounds. Both run as
 * owner exec leases on the exact target with the target's own trust and
 * identity, non-interactive (no stdin, PTY or environment). A cancel kills only
 * that lease and settles as a SIGKILL exit once the owner confirms teardown; an
 * unconfirmed teardown rejects as `outcomeUnknown`.
 *
 * @module remoteWorkspaceAcpTerminal.owner.production
 */
export function makeProductionAcpTerminalOwner({
  targetId,
  workspaceRoot,
  owner = readSshOwnerProductionOwner,
}: {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly owner?: ProductionOwnerSource;
}): AcpTerminalSshOwner {
  const settle = (
    lease: ProductionShellLease,
    check: (output: string, truncated: boolean) => void,
  ): AcpOwnerCommandLease => {
    const output = new PassThrough();
    const stop = new AbortController();
    const exit: Promise<AcpOwnerExit> = lease.wait(stop.signal).then(
      (result) => {
        check(result.output, result.truncated);
        output.end(Buffer.from(result.output, "utf8"));
        return { kind: "exited", code: result.exitCode } as const;
      },
      (cause: unknown) => {
        if (cause instanceof PickerProofOwnerError && cause.code === "shellCancelled") {
          output.end();
          return { kind: "signaled", signal: "SIGKILL" } as const;
        }
        throw cause;
      },
    );
    void exit.catch((cause: unknown) => output.destroy(cause as Error));
    return {
      output,
      exit,
      cancel: async () => {
        stop.abort();
        await exit.catch(() => undefined);
      },
    };
  };
  const acquire = async (
    signal: AbortSignal,
    open: (
      bound: Awaited<ReturnType<typeof productionShellTarget>>,
    ) => Promise<ProductionShellLease>,
  ) => {
    const bound = await productionShellTarget(owner, targetId);
    signal.throwIfAborted();
    const lease = await open(bound);
    if (signal.aborted) {
      // Reap the lease that was not returned; never replay it.
      await lease.close().catch(() => undefined);
      signal.throwIfAborted();
    }
    return lease;
  };
  return {
    async runAcpCommand(approved, acquisitionSignal) {
      acquisitionSignal.throwIfAborted();
      const cwd = validatedCwd(approved, targetId, workspaceRoot);
      const lease = await acquire(acquisitionSignal, (bound) =>
        bound.openAcpCommand({ workspaceRoot, cwd }),
      );
      return settle(lease, (text, truncated) => {
        if (truncated || text !== `${cwd}\n`) throw new AcpTerminalOwnerError("unsupported-cwd");
      });
    },
    async runAcpShell(approved, acquisitionSignal) {
      acquisitionSignal.throwIfAborted();
      if (approved.operation !== "shell-command" || approved.command === undefined)
        throw new AcpTerminalOwnerError("unsupported-command");
      const command = approved.command;
      const cwd = validatedScope(approved, targetId, workspaceRoot);
      const lease = await acquire(acquisitionSignal, (bound) =>
        bound.openAcpShell({
          workspaceRoot,
          cwd,
          sessionId: approved.approval.acpSessionId,
          toolCallId: approved.approval.toolCallId,
          command,
          timeoutMs: ACP_SHELL_TIMEOUT_MS,
        }),
      );
      return settle(lease, () => undefined);
    },
  };
}
