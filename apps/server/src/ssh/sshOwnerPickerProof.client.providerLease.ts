import type { RemoteAgentProxyLease } from "../remote-agent/remoteAgentConnection.owner.ts";
import type {
  PickerProofProviderFixture,
  ProofProviderScope,
} from "./sshOwnerPickerProof.codec.provider.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export function bindProofProviderScope(
  fixture: PickerProofProviderFixture | undefined,
  runtime: Omit<ProofProviderScope, "cwd"> & { readonly cwd?: string },
) {
  if (
    !fixture ||
    runtime.threadId !== fixture.threadId ||
    runtime.sessionEpoch !== fixture.sessionEpoch ||
    runtime.cwd !== fixture.cwd ||
    runtime.binaryPath !== fixture.binaryPath
  ) {
    throw new PickerProofOwnerError("operationDenied");
  }
  const { threadId, sessionEpoch, cwd, binaryPath } = fixture;
  return { threadId, sessionEpoch, cwd, binaryPath };
}

/** Return the cancellation handle before any native pipe can be consumed. */
export function startCancellableProofProvider(
  name: "Codex" | "Pi",
  open: (signal: AbortSignal) => Promise<RemoteAgentProxyLease>,
) {
  const controller = new AbortController();
  const cancelled = new Error(`${name} proof start cancelled`);
  const acquiring = Promise.resolve().then(() => open(controller.signal));
  const ready = acquiring.then((lease) => {
    const exit = lease.exit.then((result) => {
      if (result.code !== null) return { kind: "exited" as const, code: result.code };
      if (result.signal) return { kind: "signaled" as const, signal: result.signal };
      throw new PickerProofOwnerError("outcomeUnknown");
    });
    void exit.catch(() => {});
    return { ...lease.pipes, exit };
  });
  void ready.catch(() => {});
  let cancellation: Promise<void> | undefined;
  return {
    ready,
    cancel: () =>
      (cancellation ??= (async () => {
        controller.abort(cancelled);
        try {
          const lease = await acquiring;
          await lease.close({ mode: "terminate", timeoutMs: 2_000 });
        } catch (error) {
          if (error !== cancelled) throw error;
        }
      })()),
  };
}

export function makeProofProviderProbe(
  targetId: string,
  execute: (operation: PickerProofOperation) => Promise<Exclude<Outcome, { kind: "error" }>>,
) {
  return async (
    provider: "codex" | "pi",
    {
      executionTargetId,
      threadId,
      sessionEpoch,
      cwd,
      binaryPath,
    }: ProofProviderScope & { executionTargetId: string },
  ) => {
    if (executionTargetId !== targetId) throw new PickerProofOwnerError("invalidOperands");
    const outcome = await execute({
      kind: provider === "codex" ? "probeProofCodex" : "probeProofPi",
      threadId,
      sessionEpoch,
      cwd,
      binaryPath,
    });
    if (outcome.kind !== "proofCodexVersion" && outcome.kind !== "proofPiVersion") return invalid();
    const { code, stdout, stderr } = outcome.value;
    return { status: code, stdout, stderr };
  };
}
