import { Effect } from "effect";

import {
  ThreadShellRunnerError,
  type ThreadShellRunnerShape,
} from "../shell/Services/ThreadShellRunner.ts";
import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";
import { shellLeaseAdmits } from "./sshOwnerPickerProof.codec.shellLease.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "./sshOwnerProductionRegistry.ts";
import { boundedTimeout, ownerShellError, truncateShellOutput } from "./sshShellRunner.owner.ts";

/**
 * W2 T-shell production sources. Under production activation the thread shell,
 * the provider workspace shell and the ACP command run as owner exec leases on
 * the exact target (`resolveProductionTargetDescriptor` through the registry),
 * with that target's own trust and identity. There is no legacy fallback: a
 * missing owner or an unresolvable target is a typed refusal before any launch.
 *
 * @module sshShellRunner.production
 */
export type ProductionOwnerSource = () => SshOwnerProductionRegistration | undefined;

export class ProductionShellUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The production SSH owner cannot run this shell command: ${detail}. No legacy shell was started.`,
    );
    this.name = "ProductionShellUnavailableError";
  }
}

/** The live owner's bound target for one runtime target id, read per call. */
export async function productionShellTarget(
  owner: ProductionOwnerSource,
  executionTargetId: string,
): Promise<PickerProofBoundTarget> {
  const live = owner();
  if (!live) throw new ProductionShellUnavailableError("no production owner is open");
  const descriptor = await live.descriptorFor(executionTargetId).catch((cause: unknown) => {
    const reason =
      cause instanceof Error && "reason" in cause ? String(cause.reason) : "unresolved target";
    throw new ProductionShellUnavailableError(`target refused (${reason})`);
  });
  return live.handle.target(descriptor);
}

/**
 * Thread shell: the backend-resolved thread cwd is both the authorized root and
 * the start directory. One active command per thread, 30 s default / 120 s
 * ceiling, 8 MiB buffered output; abort kills only this lease.
 */
export function makeProductionShellRunner(
  executionTargetId: string,
  owner: ProductionOwnerSource = readSshOwnerProductionOwner,
): ThreadShellRunnerShape {
  const activeThreads = new Set<string>();
  return {
    isActive: (threadId) => Effect.sync(() => activeThreads.has(threadId)),
    run: (input) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (activeThreads.has(input.threadId)) {
            throw new Error("A direct SSH shell command is already running for this thread.");
          }
          if (!shellLeaseAdmits(input.cwd, input.cwd)) {
            throw new Error("The remote shell cwd is not an exact absolute workspace path.");
          }
          activeThreads.add(input.threadId);
          try {
            const bound = await productionShellTarget(owner, executionTargetId);
            const result = await bound.runThreadShell(
              {
                workspaceRoot: input.cwd,
                cwd: input.cwd,
                threadId: input.threadId,
                command: input.command,
                timeoutMs: boundedTimeout(input.timeoutMs),
              },
              signal,
            );
            const { output } = truncateShellOutput(result.output);
            if (output.length > 0) input.onOutputChunk?.(output);
            return { output, exitCode: result.exitCode };
          } finally {
            activeThreads.delete(input.threadId);
          }
        },
        catch: (cause) => new ThreadShellRunnerError({ message: ownerShellError(cause), cause }),
      }),
    closeThread: () => Effect.void,
  };
}
