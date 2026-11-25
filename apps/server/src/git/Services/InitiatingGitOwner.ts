import { ServiceMap } from "effect";

export interface InitiatingGitRepository {
  readonly worktree: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

export interface InitiatingGitDestination {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly repositoryPath: string;
}

interface InitiatingGitPushScope {
  readonly direction: "push";
  readonly repository: InitiatingGitRepository;
  readonly remoteName: string;
  readonly refs: {
    readonly source: `refs/heads/${string}`;
    readonly destination: `refs/heads/${string}`;
  };
}

interface ApprovedInitiatingGitPushDestination {
  readonly effectiveUrl: string;
  readonly executionTargetId: string;
  readonly targetGeneration: string;
}

type PushDestinations<A> = readonly [A, ...A[]];

/** Supplied by trusted product composition, never inferred as a grant from Git config or RPC input. */
export type ApprovedInitiatingGitPush = InitiatingGitPushScope &
  (
    | {
        readonly destinations: PushDestinations<ApprovedInitiatingGitPushDestination>;
        readonly destination?: never;
        readonly executionTargetId?: never;
        readonly targetGeneration?: never;
      }
    | {
        /** Legacy scope binds only the single canonical SSH URL for this tuple. */
        readonly destination: InitiatingGitDestination;
        readonly executionTargetId: string;
        readonly targetGeneration: string;
        readonly destinations?: never;
      }
  );

export interface InitiatingGitPushDestination
  extends ApprovedInitiatingGitPushDestination, InitiatingGitDestination {}

export interface InitiatingGitPushRequest extends InitiatingGitPushScope {
  readonly destinations: PushDestinations<InitiatingGitPushDestination>;
  readonly sourceOid: string;
}

export type InitiatingGitPushOutcome =
  | "pushed"
  | "upToDate"
  | "denied"
  | "rejectedRef"
  | "partial"
  | "unknown";

export interface InitiatingGitOwnerShape {
  /** Presence selects this lane. A missing approval or owner is a denial, not legacy selection. */
  readonly approvedPush?: ApprovedInitiatingGitPush;
  readonly owner?: {
    /**
     * Revalidate the approval, repo identity, refs/OID, and the entire ordered effective URL
     * list (including each target generation) before starting any transport. Git keeps pack/ref
     * handling; only receive-pack at the approved destinations is authorized. Do not accept
     * ambient helpers or unowned descendants.
     * Admission is all-or-nothing, not a cross-server transaction. Report success only when
     * every destination is confirmed. Report partial on any confirmed write with incomplete
     * results, unknown if a write cannot be ruled out, and rejectedRef for a confirmed rejection
     * with no writes. Never replay an incomplete or uncertain write.
     */
    readonly push: (
      request: InitiatingGitPushRequest,
      signal: AbortSignal,
    ) => Promise<InitiatingGitPushOutcome>;
  };
}

export class InitiatingGitOwner extends ServiceMap.Service<
  InitiatingGitOwner,
  InitiatingGitOwnerShape
>()("t3/git/Services/InitiatingGitOwner") {}
