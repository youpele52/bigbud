import type { PickerProofProductionProviderClient } from "../ssh/sshOwnerPickerProof.client.productionProvider.ts";
import type { ProviderLeaseScope } from "../ssh/sshOwnerPickerProof.codec.providerLease.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import { startProductionProviderLease } from "../ssh/sshOwnerProductionProviderLease.ts";
import {
  bindProductionProviderTarget,
  type ProductionProviderSourceOptions,
} from "../ssh/sshOwnerProductionProviderSource.ts";
import type {
  CodexOwnerRuntime,
  CodexOwnerSelection,
  CodexSshOwner,
} from "./codexAppServerManager.process.remote.owner.ts";

/**
 * W2 T-prov: the Codex owner port over the production owner. The owner discovers `codex` on the
 * exact target and runs only `--version` or `app-server` (plus, when the probed version supports
 * it, the owner-compiled default-mode question feature). The configured local `binaryPath` never
 * reaches the owner. A custom `CODEX_HOME` is admitted only when the target resolves it (every
 * symlink followed) to an existing directory beneath the account's home; the typed probe checks
 * that scope, and a refusal is `CodexProductionHomeRefusedError`.
 *
 * @module codexAppServerManager.process.remote.production
 */

export class CodexProductionHomeRefusedError extends Error {
  readonly code = "codex-production-home-refused";
  constructor(options?: { readonly cause?: unknown }) {
    super(
      "The Codex home is not an existing directory inside the remote account's home; refused.",
      options,
    );
    this.name = "CodexProductionHomeRefusedError";
  }
}

function scopeFor(runtime: CodexOwnerRuntime, targetId: string): ProviderLeaseScope {
  if (runtime.provider !== "codex" || runtime.executionTargetId !== targetId)
    throw new PickerProofOwnerError("operationDenied");
  return {
    provider: "codex",
    threadId: runtime.threadId,
    sessionEpoch: runtime.sessionEpoch,
    cwd: runtime.cwd,
    ...(runtime.homePath !== undefined ? { codexHome: runtime.homePath } : {}),
  };
}

export function makeProductionCodexSshOwner(
  client: PickerProofProductionProviderClient,
  targetId: string,
): CodexSshOwner {
  return {
    async probeProvider(runtime, signal) {
      signal.throwIfAborted();
      const scope = scopeFor(runtime, targetId);
      const result = await client.probeProvider(scope).catch((cause: unknown) => {
        throw scope.codexHome !== undefined &&
          cause instanceof PickerProofOwnerError &&
          cause.code === "operationDenied"
          ? new CodexProductionHomeRefusedError({ cause })
          : cause;
      });
      signal.throwIfAborted();
      return { status: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    startProvider(request) {
      return startProductionProviderLease(client, {
        ...scopeFor(request, targetId),
        defaultModeUserInput: request.enableDefaultModeUserInput,
      });
    },
  };
}

/**
 * The production Codex selection for one runtime target. With no live owner (or production not
 * selected) it is `{ owner: undefined }`, which the launcher reports as an unavailable owner
 * instead of starting legacy SSH.
 */
export async function resolveProductionCodexOwnerSelection(
  executionTargetId: string,
  options: ProductionProviderSourceOptions = {},
): Promise<CodexOwnerSelection> {
  const client = await bindProductionProviderTarget(executionTargetId, options);
  return { owner: client ? makeProductionCodexSshOwner(client, executionTargetId) : undefined };
}
