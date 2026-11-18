import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

/** A pending cross-project confirmation for one (caller thread, target project) pair. */
export interface ThreadCoordinationChallenge {
  readonly callerThreadId: ThreadId;
  readonly projectId: ProjectId;
  /** `BB-` plus 8 random base32 characters. */
  readonly code: string;
  /** Captured at issue time so a project rename in between does not break matching. */
  readonly projectTitle: string;
  readonly targetIsRemote: boolean;
  readonly issuedAt: number;
  /** Caller-thread stream sequence at issue time; proof must come strictly after it. */
  readonly streamSequenceFloor: number;
  readonly expiresAt: number;
  /** Monotonic per server; orders challenges issued for one caller. */
  readonly issueOrder: number;
}

/**
 * What reply attribution needs about an issued challenge. Kept after the challenge is granted,
 * denied or cleared, with the caller-thread sequence at that moment, so replies typed later go to
 * the next pending challenge instead.
 */
export interface ThreadCoordinationIssuedChallenge extends Pick<
  ThreadCoordinationChallenge,
  "projectId" | "code" | "streamSequenceFloor" | "issueOrder"
> {
  readonly resolvedAtSequence?: number | undefined;
}

/** Caller-thread sequence when a challenge was resolved; absent keeps it pending for attribution. */
export interface ThreadCoordinationResolution {
  readonly resolvedAtSequence?: number | undefined;
}

export interface ThreadCoordinationChallengeRequest {
  readonly callerThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly targetIsRemote: boolean;
  readonly streamSequenceFloor: number;
}

/**
 * In-memory record of user confirmations that let a caller thread write to threads in another
 * project, and of the messaging lines those approvals open between two threads. Grants,
 * challenges and lines live until the server process restarts, by design.
 */
export interface ThreadCoordinationGrantsShape {
  readonly hasGrant: (callerThreadId: ThreadId, projectId: ProjectId) => Effect.Effect<boolean>;
  /** The pair's unexpired challenge, if any. */
  readonly getChallenge: (
    callerThreadId: ThreadId,
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadCoordinationChallenge>>;
  /** Atomically returns the unexpired challenge, or issues one; concurrent calls share it. */
  readonly getOrIssueChallenge: (
    request: ThreadCoordinationChallengeRequest,
  ) => Effect.Effect<{ readonly challenge: ThreadCoordinationChallenge; readonly issued: boolean }>;
  /**
   * The caller's recently issued challenges, oldest first, including resolved ones. A chat reply
   * without a code decides only the latest one still pending when the reply was typed.
   */
  readonly listIssuedChallenges: (
    callerThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadCoordinationIssuedChallenge>>;
  /** Records the grant and resolves the pair's challenge. Idempotent. */
  readonly grant: (
    callerThreadId: ThreadId,
    projectId: ProjectId,
    resolution?: ThreadCoordinationResolution,
  ) => Effect.Effect<void>;
  /** Clears and resolves the pair's challenge; with `code`, only when it is still that challenge. */
  readonly clearChallenge: (
    callerThreadId: ThreadId,
    projectId: ProjectId,
    code?: string,
    resolution?: ThreadCoordinationResolution,
  ) => Effect.Effect<void>;
  /**
   * Opens a two-way messaging line between two threads in different projects, after the user
   * approved a message between them. Order does not matter. Idempotent.
   */
  readonly openLine: (threadA: ThreadId, threadB: ThreadId) => Effect.Effect<void>;
  /** Whether an open line lets these two threads message each other, in either direction. */
  readonly hasLine: (threadA: ThreadId, threadB: ThreadId) => Effect.Effect<boolean>;
}

export class ThreadCoordinationGrants extends ServiceMap.Service<
  ThreadCoordinationGrants,
  ThreadCoordinationGrantsShape
>()("t3/orchestration-tools/Services/ThreadCoordinationGrants") {}
