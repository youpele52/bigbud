import { Layer } from "effect";

import type { GitCoreShape } from "../Services/GitCore.ts";
import {
  InitiatingGitOwner,
  type ApprovedInitiatingGitPush,
  type InitiatingGitOwnerShape,
  type InitiatingGitPushDestination,
  type InitiatingGitPushOutcome,
  type InitiatingGitPushRequest,
} from "../Services/InitiatingGitOwner.ts";
import { pushSelectedInitiatingBranch } from "./GitCore.initiatingPush.ts";
import { DEFAULT_TIMEOUT_MS } from "./GitCoreExecutor.ts";

type DestinationScope = Pick<
  InitiatingGitPushDestination,
  "effectiveUrl" | "executionTargetId" | "targetGeneration" | "endpoint"
>;

type TrackedDestination = DestinationScope & { readonly expectedOldOid: string };

/** The old OIDs are trusted admission inputs, not local remote-tracking refs. */
export type IsolatedInitiatingPushApproval = Pick<
  ApprovedInitiatingGitPush,
  "direction" | "repository" | "remoteName" | "refs" | "publish"
> & {
  readonly sourceOid: string;
  readonly destinations: readonly [TrackedDestination, ...TrackedDestination[]];
};

type ReceiveDestination = InitiatingGitPushDestination & TrackedDestination;

export type BoundedTrackedReceiveRequest = Omit<InitiatingGitPushRequest, "destinations"> & {
  readonly destinations: readonly [ReceiveDestination, ...ReceiveDestination[]];
  readonly timeoutMs: number;
};

export type TrackedReceiveReceipt = DestinationScope & {
  readonly index: number;
  /** `stale`: the live remote ref was not the expected old OID; nothing was written. */
  readonly outcome: "accepted" | "unchanged" | "rejected" | "stale" | "unconfirmed";
  /** For `rejected`: Git's bounded single-line reason, when it gave one. */
  readonly detail?: string;
};

/** Trusted owner capability. Not a Git argv runner or a writable SSH stream. */
export interface BoundedInitiatingGitTransport {
  /**
   * Admit the entire request before opening any transport: revalidate the repository,
   * refs/OIDs, exact ordered effective URLs, and every pinned target/generation. Fence
   * Git and all its descendants to the corresponding receive-pack only, without ambient
   * helpers, rewrites, hooks, or fallback. Before forwarding a write, serialize lease
   * revalidation with retirement and run the tracked-update gate with the expected old
   * OID. When old and new match, verify the remote ref without submitting an update.
   * Bound I/O and retire/reap the owned graph on abort or deadline. Return receipts from
   * the bounded protocol (not child exit codes); never retry an uncertain write.
   */
  readonly receiveTrackedPush: (
    request: BoundedTrackedReceiveRequest,
    signal: AbortSignal,
  ) => Promise<
    | { readonly status: "deniedBeforeDispatch" }
    | { readonly status: "finished"; readonly receipts: readonly TrackedReceiveReceipt[] }
  >;
}

function snapshotDestination({
  effectiveUrl,
  executionTargetId,
  targetGeneration,
  expectedOldOid,
  endpoint,
}: TrackedDestination): TrackedDestination {
  return {
    effectiveUrl,
    executionTargetId,
    targetGeneration,
    expectedOldOid,
    ...(endpoint ? { endpoint: { ...endpoint } } : {}),
  };
}

function snapshotDestinations(
  destinations: IsolatedInitiatingPushApproval["destinations"],
): readonly [TrackedDestination, ...TrackedDestination[]] {
  const [first, ...rest] = destinations;
  return [snapshotDestination(first), ...rest.map(snapshotDestination)];
}

function matchesScope(left: DestinationScope, right: DestinationScope): boolean {
  return (
    left.effectiveUrl === right.effectiveUrl &&
    left.executionTargetId === right.executionTargetId &&
    left.targetGeneration === right.targetGeneration
  );
}

function isObjectId(oid: string, width: number): boolean {
  return (
    (width === 40 || width === 64) &&
    oid.length === width &&
    /^[a-f0-9]+$/u.test(oid) &&
    /[1-9a-f]/u.test(oid)
  );
}

function summarize(
  request: BoundedTrackedReceiveRequest,
  receipts: readonly TrackedReceiveReceipt[],
): InitiatingGitPushOutcome {
  let written = false;
  let rejected = false;
  let stale = false;
  let incomplete = receipts.length !== request.destinations.length;
  for (const [index, destination] of request.destinations.entries()) {
    const receipt = receipts[index];
    if (receipt?.index !== index || !matchesScope(receipt, destination)) {
      incomplete = true;
    } else if (receipt.outcome === "accepted" && destination.expectedOldOid !== request.sourceOid) {
      written = true;
    } else if (receipt.outcome === "rejected") {
      rejected = true;
    } else if (receipt.outcome === "stale") {
      stale = true;
    } else if (
      receipt.outcome !== "unchanged" ||
      destination.expectedOldOid !== request.sourceOid
    ) {
      incomplete = true;
    }
  }
  if (written && (incomplete || rejected || stale)) return "partial";
  if (incomplete) return "unknown";
  if (stale) return "stale";
  if (rejected) return "rejectedRef";
  return written ? "pushed" : "upToDate";
}

/**
 * Product composition: bind the trusted approval and the bounded owner transport into the
 * `InitiatingGitOwner` shape consumed by `pushSelectedInitiatingBranch`. No proof executor and
 * no legacy SSH path is retained.
 */
export function makeIsolatedInitiatingGitOwnerShape(
  approval: IsolatedInitiatingPushApproval,
  transport: BoundedInitiatingGitTransport,
): InitiateOwnerShape {
  return {
    approvedPush: {
      direction: approval.direction,
      repository: { ...approval.repository },
      remoteName: approval.remoteName,
      refs: { ...approval.refs },
      ...(approval.publish ? { publish: true as const } : {}),
      destinations: snapshotDestinations(approval.destinations),
    },
    owner: {
      push: makeIsolatedInitiatingPushOwner(approval, transport),
    },
  };
}

type InitiateOwnerShape = {
  readonly approvedPush: ApprovedInitiatingGitPush;
  readonly owner: NonNullable<InitiatingGitOwnerShape["owner"]>;
};

/**
 * Compose the isolated push binding into the product `InitiatingGitOwner` service. The caller
 * supplies the trusted approval producer and the owner transport; no proof executor or legacy
 * SSH fallback is retained in the resulting layer.
 */
export function makeIsolatedInitiatingGitOwnerLayer(
  approval: IsolatedInitiatingPushApproval,
  transport: BoundedInitiatingGitTransport,
): Layer.Layer<InitiatingGitOwner> {
  return Layer.succeed(
    InitiatingGitOwner,
    makeIsolatedInitiatingGitOwnerShape(approval, transport),
  );
}

/** Extract the bounded owner push so product composition and tests share one implementation. */
export function makeIsolatedInitiatingPushOwner(
  approval: IsolatedInitiatingPushApproval,
  transport: BoundedInitiatingGitTransport,
): NonNullable<InitiatingGitOwnerShape["owner"]>["push"] {
  const sourceOid = approval.sourceOid;
  const [firstScope, ...restScopes] = approval.destinations;
  const expected = firstScope
    ? ([snapshotDestination(firstScope), ...restScopes.map(snapshotDestination)] as const)
    : undefined;
  return async (request, signal) => {
    if (
      !expected ||
      signal.aborted ||
      sourceOid !== request.sourceOid ||
      (request.publish === true) !== (approval.publish === true) ||
      !isObjectId(sourceOid, sourceOid.length) ||
      request.destinations.length !== expected.length
    ) {
      return "denied";
    }
    const bound: ReceiveDestination[] = [];
    for (const [index, destination] of request.destinations.entries()) {
      const scope = expected[index];
      if (
        !scope ||
        !matchesScope(scope, destination) ||
        !(approval.publish
          ? scope.expectedOldOid === "0".repeat(sourceOid.length)
          : isObjectId(scope.expectedOldOid, sourceOid.length))
      ) {
        return "denied";
      }
      bound.push({ ...destination, expectedOldOid: scope.expectedOldOid });
    }
    const [first, ...rest] = bound;
    if (!first) return "denied";
    const receive: BoundedTrackedReceiveRequest = {
      ...request,
      destinations: [first, ...rest],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
    const result = await transport.receiveTrackedPush(receive, signal);
    if (result.status === "deniedBeforeDispatch") return "denied";
    if (result.status !== "finished" || !Array.isArray(result.receipts)) return "unknown";
    const outcome = summarize(receive, result.receipts);
    const detail = result.receipts.find((receipt) => receipt.outcome === "rejected")?.detail;
    return outcome === "rejectedRef" && detail ? { outcome, detail } : outcome;
  };
}

/**
 * Explicit isolated caller for a local tracked branch. `executeLocalProbe` runs only the
 * guard's metadata commands; no legacy Git mutation executor or SSH fallback is accepted.
 */
export function makeIsolatedInitiatingGitPush(
  executeLocalProbe: GitCoreShape["execute"],
  transport?: BoundedInitiatingGitTransport,
) {
  return (cwd: string, approval?: IsolatedInitiatingPushApproval) => {
    if (!approval || !transport) return pushSelectedInitiatingBranch(executeLocalProbe, cwd, {});

    return pushSelectedInitiatingBranch(executeLocalProbe, cwd, {
      approvedPush: {
        direction: approval.direction,
        repository: { ...approval.repository },
        remoteName: approval.remoteName,
        refs: { ...approval.refs },
        ...(approval.publish ? { publish: true as const } : {}),
        destinations: snapshotDestinations(approval.destinations),
      },
      owner: {
        push: makeIsolatedInitiatingPushOwner(approval, transport),
      },
    });
  };
}
