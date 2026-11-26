import type { PickerProofProductionProviderClient } from "../../../ssh/sshOwnerPickerProof.client.productionProvider.ts";
import type { ProviderLeaseScope } from "../../../ssh/sshOwnerPickerProof.codec.providerLease.ts";
import { PickerProofOwnerError } from "../../../ssh/sshOwnerPickerProof.codec.wire.ts";
import { startProductionProviderLease } from "../../../ssh/sshOwnerProductionProviderLease.ts";
import {
  bindProductionProviderTarget,
  type ProductionProviderSourceOptions,
} from "../../../ssh/sshOwnerProductionProviderSource.ts";
import type { PiOwnerRuntime, PiRpcOwner, SelectedPiRpcOwner } from "./RpcProcess.owner.ts";
import { PI_VERSION_PROBE_MAX_BYTES } from "./RpcProcess.version.ts";

/**
 * W2 T-prov: the Pi owner port over the production owner. The owner discovers `pi` on the
 * exact target and runs only `--version` or `--mode rpc [--session FILE]`; the configured local
 * `binaryPath` never reaches the owner. A resume file is admitted only when the target resolves
 * it (every symlink followed) beneath the account's own `~/.pi/agent/sessions`; the owner checks
 * that in a typed probe of the exact resume scope before the lease opens.
 *
 * @module RpcProcess.owner.production
 */

export class PiProductionResumeRefusedError extends Error {
  readonly code = "pi-production-resume-refused";
  constructor(options?: { readonly cause?: unknown }) {
    super(
      "The Pi session file is not inside the remote account's ~/.pi/agent/sessions; resume refused.",
      options,
    );
    this.name = "PiProductionResumeRefusedError";
  }
}

function scopeFor(
  runtime: PiOwnerRuntime & { readonly sessionFile?: string },
  targetId: string,
): ProviderLeaseScope {
  if (runtime.provider !== "pi" || runtime.executionTargetId !== targetId)
    throw new PickerProofOwnerError("operationDenied");
  if (runtime.cwd === undefined) throw new PickerProofOwnerError("invalidOperands");
  return {
    provider: "pi",
    threadId: runtime.threadId,
    sessionEpoch: runtime.sessionEpoch,
    cwd: runtime.cwd,
    ...(runtime.sessionFile !== undefined ? { sessionFile: runtime.sessionFile } : {}),
  };
}

export function makeProductionPiRpcOwner(
  client: PickerProofProductionProviderClient,
  targetId: string,
): PiRpcOwner {
  return {
    async probeProvider(runtime, signal) {
      signal.throwIfAborted();
      const result = await client.probeProvider(scopeFor(runtime, targetId));
      signal.throwIfAborted();
      if (
        result.code !== 0 ||
        Buffer.byteLength(result.stdout) > PI_VERSION_PROBE_MAX_BYTES ||
        Buffer.byteLength(result.stderr) > PI_VERSION_PROBE_MAX_BYTES
      )
        throw new PickerProofOwnerError("operationDenied");
      return result.stdout;
    },
    startProvider(request) {
      const scope = scopeFor(request, targetId);
      if (scope.sessionFile === undefined) return startProductionProviderLease(client, scope);
      // The open must match a probe of this exact resume scope (the owner arms per scope).
      return startProductionProviderLease(client, scope, async () => {
        const result = await client.probeProvider(scope).catch((cause: unknown) => {
          throw cause instanceof PickerProofOwnerError && cause.code === "operationDenied"
            ? new PiProductionResumeRefusedError({ cause })
            : cause;
        });
        if (result.code !== 0) throw new PickerProofOwnerError("operationDenied");
      });
    },
  };
}

/** The production Pi port for one runtime target, or `undefined` when production is not selected. */
export async function resolveProductionPiRpcOwner(
  executionTargetId: string,
  options: ProductionProviderSourceOptions = {},
): Promise<SelectedPiRpcOwner | undefined> {
  const client = await bindProductionProviderTarget(executionTargetId, options);
  return client
    ? { targetId: executionTargetId, owner: makeProductionPiRpcOwner(client, executionTargetId) }
    : undefined;
}
