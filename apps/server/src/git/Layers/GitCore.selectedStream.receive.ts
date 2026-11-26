import { randomBytes } from "node:crypto";

import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import {
  gitReceiveApprovalAdmits,
  type GitReceiveState,
} from "../../ssh/sshOwnerPickerProof.codec.gitReceive.ts";
import { runProcess } from "../../utils/processRunner";
import type {
  BoundedInitiatingGitTransport,
  TrackedReceiveReceipt,
} from "./GitCore.initiatingPush.composition.ts";
import {
  sanitizedTransportEnvironment,
  type InitiatingFetchBinding,
} from "./GitCore.initiatingTransport.ts";
import { openOwnerSocketLease, waitLeaseSettled } from "./GitCore.ownerSocketLease.ts";
import type { resolveSshEndpoint } from "./GitCore.remoteEndpoint.ts";
import { bridgeOwnerGitLease } from "./GitCore.selectedStream.ts";
import { selectProductionGitTarget } from "./GitCore.selectedStream.production.ts";
import type { SshTargetRecord } from "./GitCore.targetRecords.ts";

/**
 * U15 production push: the bounded transport behind `pushSelectedInitiatingBranch`. One
 * destination only. The owner's receive lease carries the approval (ref, expected old OID,
 * source OID); local Git pushes the exact source OID through the one-connection shim, and the
 * outcome is the owner's settled receipt, never Git's exit code.
 *
 * @module GitCore.selectedStream.receive
 */

/** After local Git exits, the owner settles once receive-pack has exited (bounded). */
const SETTLE_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 120_000;

type RunGit = (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly code: number; readonly stderr: string }>;

export interface ProductionReceiveDependencies {
  readonly owner: () => SshOwnerProductionRegistration | undefined;
  readonly records: () => Promise<ReadonlyArray<SshTargetRecord> | undefined>;
  readonly resolveEndpoint?: typeof resolveSshEndpoint;
  readonly runGit?: RunGit;
}

const defaultRunGit: RunGit = (args, options) =>
  runProcess("git", args, { ...options, allowNonZeroExit: true }).then((result) => ({
    code: result.code ?? -1,
    stderr: result.stderr,
  }));

const MAX_REASON = 200;
const BEHIND = /\((?:non-fast-forward|fetch first)\)/u;

/**
 * Git's own rejection reason from `git push` stderr: the ` ! [rejected] a -> b (why)` status
 * line, single-line and bounded. It names refs, never the URL or a path. Being behind the
 * remote gets an actionable sentence.
 */
export function pushRejectionReason(stderr: string): string | undefined {
  const line = stderr
    .split(/\r?\n/u)
    .map((text) => text.trim())
    .find((text) => /^! \[(?:remote )?rejected\]/u.test(text));
  if (!line) return undefined;
  if (BEHIND.test(line)) {
    return "the remote branch has commits you do not have (non-fast-forward). Pull, then push again.";
  }
  // oxlint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ");
  return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON)}…` : clean;
}

/** The settled owner state as one receipt; `undefined` means nothing can have been written. */
export function receiptOf(
  settled: GitReceiveState | "timedOut" | { readonly error: unknown },
): TrackedReceiveReceipt["outcome"] | undefined {
  if (settled === "timedOut" || "error" in settled) return "unconfirmed";
  switch (settled.phase) {
    case "finished":
      // `refused`: local Git's command deviated (for example its own non-fast-forward
      // refusal); the owner forwarded nothing, so it is a confirmed rejection.
      return settled.receipt === "refused" ? "rejected" : settled.receipt;
    case "closed":
    case "lost":
    case "rejected":
      return undefined;
    default:
      return "unconfirmed";
  }
}

export function makeProductionReceiveTransport(
  dependencies: ProductionReceiveDependencies,
): BoundedInitiatingGitTransport {
  const runGit = dependencies.runGit ?? defaultRunGit;
  return {
    async receiveTrackedPush(request, signal) {
      const denied = { status: "deniedBeforeDispatch" } as const;
      const [destination, ...others] = request.destinations;
      const live = dependencies.owner();
      const records = live && others.length === 0 ? await dependencies.records() : undefined;
      if (!live || !records || signal.aborted) return denied;
      const selected = await selectProductionGitTarget(
        live,
        records,
        destination.effectiveUrl,
        dependencies.resolveEndpoint,
      );
      const approval = selected && {
        workspaceRoot: selected.workspaceRoot,
        repositoryPath: selected.repositoryPath,
        destinationRef: request.refs.destination,
        expectedOldOid: destination.expectedOldOid,
        sourceOid: request.sourceOid,
      };
      if (
        !selected ||
        !approval ||
        selected.targetId !== destination.executionTargetId ||
        selected.repositoryPath !== destination.repositoryPath ||
        !gitReceiveApprovalAdmits(approval)
      ) {
        return denied;
      }
      const bound = live.handle.target(selected.descriptor);
      const lease = randomBytes(32);
      const verbs = {
        open: () => bound.openGitReceive(lease, approval),
        status: () => bound.gitReceiveStatus(lease),
        close: () => bound.closeGitReceive(lease),
      };
      const opened = await openOwnerSocketLease(verbs, "receive", signal).catch(() => undefined);
      if (!opened) return denied;
      let settled: Awaited<ReturnType<typeof waitLeaseSettled<GitReceiveState>>>;
      let stderr = "";
      const stream = await bridgeOwnerGitLease(opened, signal);
      try {
        const pushed = await runGit(
          [
            "push",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--no-signed",
            // A first publish names the branch so `-u` records the upstream; the owner still
            // admits only the approved source OID, so a moved branch is refused, not pushed.
            ...(request.publish
              ? ["-u", request.remoteName, `${request.refs.source}:${request.refs.destination}`]
              : [request.remoteName, `${request.sourceOid}:${request.refs.destination}`]),
          ],
          {
            cwd: request.repository.worktree,
            env: { ...sanitizedTransportEnvironment(process.env), ...stream.env },
            timeoutMs: Math.min(request.timeoutMs, PUSH_TIMEOUT_MS),
            signal,
          },
        ).catch(() => undefined);
        stderr = pushed?.stderr ?? "";
        // The owner's receipt decides; Git's exit status does not.
        settled = await waitLeaseSettled(verbs.status, SETTLE_TIMEOUT_MS);
      } finally {
        await stream.close();
      }
      const outcome = receiptOf(settled);
      if (!outcome) return denied;
      const detail = outcome === "rejected" ? pushRejectionReason(stderr) : undefined;
      return {
        status: "finished",
        receipts: [
          {
            index: 0,
            effectiveUrl: destination.effectiveUrl,
            executionTargetId: destination.executionTargetId,
            targetGeneration: destination.targetGeneration,
            outcome,
            ...(detail ? { detail } : {}),
          },
        ],
      };
    },
  };
}

/** The production push binding: target selection for the producer plus the transport. */
export function makeProductionPushBinding(
  dependencies: ProductionReceiveDependencies,
): NonNullable<InitiatingFetchBinding["push"]> {
  return {
    async select(url) {
      const live = dependencies.owner();
      const records = live ? await dependencies.records() : undefined;
      if (!live || !records) return undefined;
      const selected = await selectProductionGitTarget(
        live,
        records,
        url,
        dependencies.resolveEndpoint,
      );
      return (
        selected && {
          executionTargetId: selected.targetId,
          // The owner epoch: a restarted owner is a new generation for this approval.
          targetGeneration: Buffer.from(live.handle.ownerEpoch).toString("hex"),
          endpoint: {
            host: selected.descriptor.host,
            user: selected.descriptor.user,
            port: selected.descriptor.port,
            repositoryPath: selected.repositoryPath,
          },
        }
      );
    },
    transport: makeProductionReceiveTransport(dependencies),
  };
}
