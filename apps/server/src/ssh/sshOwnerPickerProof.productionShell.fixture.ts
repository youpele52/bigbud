import { makePickerProofProductionShellClient } from "./sshOwnerPickerProof.client.productionShell.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { ShellLeaseRole, ShellLeaseState } from "./sshOwnerPickerProof.codec.shellLease.ts";
import {
  PickerProofOwnerError,
  type PickerProofOwnerErrorCode,
} from "./sshOwnerPickerProof.codec.wire.ts";

/** How a fake owner lease settles after `pollsBeforeExit` running polls. */
export type FakeShellOutcome =
  | { readonly exit: number; readonly output: Uint8Array; readonly truncated?: boolean }
  | { readonly error: PickerProofOwnerErrorCode };

interface FakeLease {
  readonly role: ShellLeaseRole;
  polls: number;
  killed: boolean;
}

const CHUNK = 1024 * 1024;
const key = (lease: Uint8Array) => Buffer.from(lease).toString("hex");

/**
 * A disposable in-memory owner with the Rust lease semantics: open answers
 * `running`, status polls settle after N polls, output is served in 1 MiB
 * chunks, close kills a running lease, a lease never answers another role, and
 * typed failures release the lease.
 */
export function makeFakeShellOwner(options: {
  readonly pollsBeforeExit?: number;
  readonly outcome: FakeShellOutcome;
}) {
  const leases = new Map<string, FakeLease>();
  const operations: PickerProofOperation[] = [];
  const reply = (lease: Uint8Array, role: ShellLeaseRole, value: Partial<ShellLeaseState>) =>
    ({
      kind: "shell",
      value: { lease, role, phase: "running", ...value } as ShellLeaseState,
    }) satisfies Outcome;
  const execute = async (operation: PickerProofOperation): Promise<Outcome> => {
    operations.push(operation);
    if (!("lease" in operation) || !(operation.lease instanceof Uint8Array))
      throw new PickerProofOwnerError("operationDenied");
    const id = key(operation.lease);
    if (
      operation.kind === "runThreadShell" ||
      operation.kind === "runProviderWorkspaceShell" ||
      operation.kind === "runAcpCommand" ||
      operation.kind === "runAcpShell"
    ) {
      const role: ShellLeaseRole =
        operation.kind === "runThreadShell"
          ? "thread"
          : operation.kind === "runAcpCommand"
            ? "acp"
            : operation.kind === "runAcpShell"
              ? "acpShell"
              : "providerWorkspace";
      leases.set(id, { role, polls: 0, killed: false });
      return reply(operation.lease, role, {});
    }
    if (operation.kind !== "shellStatus" && operation.kind !== "shellClose")
      throw new PickerProofOwnerError("operationDenied");
    const lease = leases.get(id);
    if (!lease || lease.role !== operation.role) throw new PickerProofOwnerError("operationDenied");
    if (operation.kind === "shellClose") {
      lease.killed = true;
      leases.delete(id);
      return reply(operation.lease, lease.role, { phase: "closed" });
    }
    if (lease.polls < (options.pollsBeforeExit ?? 0)) {
      lease.polls += 1;
      return reply(operation.lease, lease.role, {});
    }
    if ("error" in options.outcome) {
      leases.delete(id);
      throw new PickerProofOwnerError(options.outcome.error);
    }
    const { output, exit, truncated } = options.outcome;
    const chunk = output.subarray(operation.offset, operation.offset + CHUNK);
    return reply(operation.lease, lease.role, {
      phase: "exited",
      output: chunk,
      outputSize: output.length,
      exitCode: exit,
      truncated: truncated ?? false,
    } as Partial<ShellLeaseState>);
  };
  return {
    execute,
    operations,
    leases,
    client: makePickerProofProductionShellClient(execute),
  };
}
