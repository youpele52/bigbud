import { randomBytes } from "node:crypto";

import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { ProofShellResult } from "./sshOwnerPickerProof.codec.shell.ts";
import {
  SHELL_LEASE_MAX_OUTPUT_BYTES,
  type ShellLeaseRole,
  type ShellLeaseState,
} from "./sshOwnerPickerProof.codec.shellLease.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";
import type {
  AcpCommandRunInput,
  ProviderWorkspaceShellRunInput,
  ThreadShellRunInput,
} from "./sshOwnerPickerProof.client.shell.ts";

/**
 * W2 T-shell production exec leases on one bound target. Opening returns at
 * once; completion is observed by bounded status polls and the output is read
 * back in owner-sized chunks. Abort kills only this lease (never replays it)
 * and reports `shellCancelled`; a kill whose teardown is not confirmed reports
 * `outcomeUnknown`.
 *
 * @module sshOwnerPickerProof.client.productionShell
 */
export interface ProductionShellLease {
  readonly lease: Uint8Array;
  readonly role: ShellLeaseRole;
  /** Wait for the settled result, read every chunk, then release the lease. */
  wait(signal?: AbortSignal): Promise<ProofShellResult>;
  /** Kill (if running) and release. Resolves only on confirmed teardown. */
  close(): Promise<void>;
}

export interface PickerProofProductionShellClient {
  runThreadShell(input: ThreadShellRunInput, signal?: AbortSignal): Promise<ProofShellResult>;
  runProviderWorkspaceShell(
    input: ProviderWorkspaceShellRunInput,
    signal?: AbortSignal,
  ): Promise<ProofShellResult>;
  openAcpCommand(input: AcpCommandRunInput): Promise<ProductionShellLease>;
  /** U21: open one approved ACP terminal command as its own lease. */
  openAcpShell(input: AcpShellRunInput): Promise<ProductionShellLease>;
}

export interface AcpShellRunInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly command: string;
  readonly timeoutMs: number;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

/** Poll back-off: quick for short commands, bounded for long ones. */
const POLL_DELAYS_MS = [10, 25, 50, 100, 200, 250] as const;
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function sameLease(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function makePickerProofProductionShellClient(
  execute: Execute,
): PickerProofProductionShellClient {
  const shell = async (operation: PickerProofOperation, lease: Uint8Array) => {
    const outcome = await execute(operation);
    if (outcome.kind !== "shell" || !sameLease(outcome.value.lease, lease)) return invalid();
    return outcome.value;
  };

  const handle = (lease: Uint8Array, role: ShellLeaseRole): ProductionShellLease => {
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= shell({ kind: "shellClose", lease, role }, lease).then((state) => {
        if (state.phase !== "closed") invalid();
      }));
    const readAll = async (first: Extract<ShellLeaseState, { phase: "exited" }>) => {
      const chunks: Uint8Array[] = [first.output];
      let read = first.output.length;
      while (read < first.outputSize) {
        const next = await shell({ kind: "shellStatus", lease, role, offset: read }, lease);
        if (next.phase !== "exited" || next.output.length === 0) return invalid();
        if (next.outputSize !== first.outputSize) return invalid();
        chunks.push(next.output);
        read += next.output.length;
      }
      if (read !== first.outputSize || read > SHELL_LEASE_MAX_OUTPUT_BYTES) return invalid();
      return {
        output: decoder.decode(Buffer.concat(chunks)),
        exitCode: first.exitCode,
        truncated: first.truncated,
        timedOut: false,
      } satisfies ProofShellResult;
    };
    const cancelled = async (): Promise<never> => {
      // Kill only this lease; an unconfirmed teardown is never reported as cancelled.
      await close();
      throw new PickerProofOwnerError("shellCancelled");
    };
    return {
      lease,
      role,
      close,
      async wait(signal) {
        for (let attempt = 0; ; attempt += 1) {
          if (signal?.aborted) return cancelled();
          const state = await shell({ kind: "shellStatus", lease, role, offset: 0 }, lease);
          if (state.phase === "exited") {
            const result = await readAll(state);
            // Release the settled lease; a failed release cannot change the result.
            await close().catch(() => undefined);
            return result;
          }
          if (state.phase !== "running") return invalid();
          await pause(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]!, signal);
        }
      },
    };
  };

  const open = async (
    operation: (lease: Uint8Array) => PickerProofOperation,
    role: ShellLeaseRole,
  ) => {
    const lease = Uint8Array.from(randomBytes(PROOF_TOKEN_BYTES));
    const state = await shell(operation(lease), lease);
    if (state.phase !== "running" || state.role !== role) return invalid();
    return handle(lease, role);
  };

  const run = async (
    operation: (lease: Uint8Array) => PickerProofOperation,
    role: ShellLeaseRole,
    signal: AbortSignal | undefined,
  ) => {
    signal?.throwIfAborted();
    const lease = await open(operation, role);
    return lease.wait(signal);
  };

  return {
    runThreadShell: (input, signal) =>
      run((lease) => ({ kind: "runThreadShell", lease, ...input }), "thread", signal),
    runProviderWorkspaceShell: (input, signal) =>
      run(
        (lease) => ({ kind: "runProviderWorkspaceShell", lease, ...input }),
        "providerWorkspace",
        signal,
      ),
    openAcpCommand: (input) => open((lease) => ({ kind: "runAcpCommand", lease, ...input }), "acp"),
    openAcpShell: (input) =>
      open((lease) => ({ kind: "runAcpShell", lease, ...input }), "acpShell"),
  };
}
