/**
 * Server-enforced confirmation for cross-project thread writes. One proof grants the
 * (caller thread, target project) pair until the server restarts. Missing grants service or
 * event-store reader fails closed: the write is refused and no grant can be recorded.
 *
 * @module ThreadCoordinationConfirmation
 */
import type { OrchestrationEvent, ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { generateThreadCoordinationCode } from "./threadCoordinationCode.ts";
import type {
  ThreadCoordinationChallenge,
  ThreadCoordinationGrantsShape,
  ThreadCoordinationIssuedChallenge,
} from "./Services/ThreadCoordinationGrants.ts";
import {
  IMPLICIT_APPROVAL_EVENT_WINDOW,
  matchImplicitThreadCoordinationApproval,
  type ThreadCoordinationTargetReference,
} from "./ThreadCoordinationConfirmation.implicit.ts";
import {
  matchThreadCoordinationProof,
  type ThreadCoordinationProofVerdict,
} from "./ThreadCoordinationConfirmation.logic.ts";
import {
  confirmationDeniedResult,
  confirmationRequiredResult,
  threadCoordinationQuestion,
  type ThreadCoordinationConfirmationDenied,
  type ThreadCoordinationConfirmationRequired,
} from "./ThreadCoordinationConfirmation.result.ts";

export const THREAD_COORDINATION_PROOF_PAGE_SIZE = 200;
/** Past this many scanned events the verifier fails closed and issues a fresh challenge. */
export const THREAD_COORDINATION_PROOF_SCAN_CAP = 2_000;

export type ThreadCoordinationProofReader = Pick<
  OrchestrationEventStoreShape,
  "readThreadProofEventsAfter" | "readThreadMaxSequence" | "readThreadRecentUserTurnEvents"
>;

/** Handles the installer passes to write tools; absent members fail closed. */
export interface ThreadCoordinationDeps {
  readonly grants?: ThreadCoordinationGrantsShape | undefined;
  readonly eventStore?: ThreadCoordinationProofReader | undefined;
}

export type ThreadCoordinationAccess =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "confirmation_required";
      readonly result: ThreadCoordinationConfirmationRequired;
    }
  | { readonly kind: "denied"; readonly result: ThreadCoordinationConfirmationDenied };

export interface ThreadCoordinationTargetProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly targetIsRemote: boolean;
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** A newer challenge for the same caller is still pending, so plain replies go to it instead. */
const isSupersededChallenge = (
  challenge: ThreadCoordinationChallenge,
  issuedChallenges: ReadonlyArray<ThreadCoordinationIssuedChallenge>,
) =>
  issuedChallenges.some(
    (record) =>
      record.code !== challenge.code &&
      record.issueOrder > challenge.issueOrder &&
      record.resolvedAtSequence === undefined,
  );

/**
 * Pages the caller thread's proof candidates after the challenge floor, bounded by the cap, then
 * decides once over the complete scan.
 */
export const verifyThreadCoordinationProof = Effect.fn("verifyThreadCoordinationProof")(
  function* (input: {
    readonly readThreadProofEventsAfter: NonNullable<
      OrchestrationEventStoreShape["readThreadProofEventsAfter"]
    >;
    readonly challenge: ThreadCoordinationChallenge;
    /** The caller's issued challenges, so a reply without a code reaches only the latest one. */
    readonly issuedChallenges?: ReadonlyArray<ThreadCoordinationIssuedChallenge> | undefined;
  }): Effect.fn.Return<ThreadCoordinationProofVerdict | "overflow", Error> {
    const events: Array<OrchestrationEvent> = [];
    let afterSequence = input.challenge.streamSequenceFloor;
    while (events.length < THREAD_COORDINATION_PROOF_SCAN_CAP) {
      const limit = Math.min(
        THREAD_COORDINATION_PROOF_PAGE_SIZE,
        THREAD_COORDINATION_PROOF_SCAN_CAP - events.length,
      );
      const page = yield* input
        .readThreadProofEventsAfter({
          threadId: input.challenge.callerThreadId,
          afterSequence,
          limit,
        })
        .pipe(Effect.mapError(asError));
      events.push(...page);
      const last = page.at(-1);
      // The whole scan is needed: the latest reply decides an Allow and any Deny stands.
      if (page.length < limit || last === undefined) {
        return matchThreadCoordinationProof({
          callerThreadId: input.challenge.callerThreadId,
          challenge: input.challenge,
          issuedChallenges: input.issuedChallenges,
          question: threadCoordinationQuestion(input.challenge),
          events,
        });
      }
      if (last.sequence <= afterSequence) return "overflow"; // A non-advancing page never loops.
      afterSequence = last.sequence;
    }
    return "overflow";
  },
);

/**
 * Whether the caller's latest user-role message is the user's own request for this target.
 * A missing reader or a failed read falls back to the question flow; it never allows.
 */
export const hasImplicitThreadCoordinationApproval = Effect.fn(
  "hasImplicitThreadCoordinationApproval",
)(function* (input: {
  readonly reader: ThreadCoordinationProofReader["readThreadRecentUserTurnEvents"];
  readonly callerThreadId: ThreadId;
  readonly referencesTarget: ThreadCoordinationTargetReference;
}): Effect.fn.Return<boolean> {
  if (!input.reader) return false;
  const events = yield* input
    .reader({ threadId: input.callerThreadId, limit: IMPLICIT_APPROVAL_EVENT_WINDOW })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationEvent> => []));
  return matchImplicitThreadCoordinationApproval({
    callerThreadId: input.callerThreadId,
    events,
    referencesTarget: input.referencesTarget,
  });
});

/**
 * Gate for a write by `callerThreadId` into another project, after the same-project and
 * direct-child exemptions. Grants are checked first, so a granted pair costs no event read; then
 * implicit approval; then the question or chat-reply challenge.
 */
export const requireCrossProjectConfirmation = Effect.fn("requireCrossProjectConfirmation")(
  function* (input: {
    readonly coordination?: ThreadCoordinationDeps | undefined;
    readonly callerThreadId: ThreadId;
    readonly project: ThreadCoordinationTargetProject;
    /** Which attached threads name this write's target; absent disables implicit approval. */
    readonly referencesTarget?: ThreadCoordinationTargetReference | undefined;
  }): Effect.fn.Return<ThreadCoordinationAccess, Error> {
    const { callerThreadId, project } = input;
    const unavailable = (): ThreadCoordinationAccess => ({
      kind: "confirmation_required",
      result: confirmationRequiredResult(
        {
          code: generateThreadCoordinationCode(),
          projectId: project.id,
          projectTitle: project.title,
          targetIsRemote: project.targetIsRemote,
        },
        { unavailable: true },
      ),
    });
    const grants = input.coordination?.grants;
    if (!grants) return unavailable();
    if (yield* grants.hasGrant(callerThreadId, project.id)) return { kind: "allowed" };
    // Decision 3a, before any challenge is issued or consulted: the user's own request for this
    // target allows this call only. No grant is recorded and a pending challenge is left alone.
    if (
      input.referencesTarget !== undefined &&
      (yield* hasImplicitThreadCoordinationApproval({
        reader: input.coordination?.eventStore?.readThreadRecentUserTurnEvents,
        callerThreadId,
        referencesTarget: input.referencesTarget,
      }))
    ) {
      return { kind: "allowed" };
    }

    const readThreadProofEventsAfter = input.coordination?.eventStore?.readThreadProofEventsAfter;
    const readThreadMaxSequence = input.coordination?.eventStore?.readThreadMaxSequence;
    if (!readThreadProofEventsAfter || !readThreadMaxSequence) return unavailable();

    // The caller-thread sequence at resolution: replies typed after it go to other challenges.
    const resolution = Effect.fn("resolveThreadCoordinationChallenge")(function* () {
      return {
        resolvedAtSequence: yield* readThreadMaxSequence(callerThreadId).pipe(
          Effect.mapError(asError),
        ),
      };
    });

    let streamSequenceFloor: number | undefined;
    const existing = yield* grants.getChallenge(callerThreadId, project.id);
    if (Option.isSome(existing)) {
      const challenge = existing.value;
      const issuedChallenges = yield* grants.listIssuedChallenges(callerThreadId);
      const verdict = yield* verifyThreadCoordinationProof({
        readThreadProofEventsAfter,
        challenge,
        issuedChallenges,
      });
      if (verdict === "allowed") {
        yield* grants.grant(callerThreadId, project.id, yield* resolution());
        return { kind: "allowed" };
      }
      if (verdict === "denied") {
        yield* grants.clearChallenge(
          callerThreadId,
          project.id,
          challenge.code,
          yield* resolution(),
        );
        return { kind: "denied", result: confirmationDeniedResult(challenge) };
      }
      if (verdict === "none" && !isSupersededChallenge(challenge, issuedChallenges)) {
        return { kind: "confirmation_required", result: confirmationRequiredResult(challenge) };
      }
      // Overflow fails closed. A superseded challenge would lose every reply to the newer one,
      // so asking again issues it afresh as the latest. Both get a new code and floor.
      const resolved = yield* resolution();
      yield* grants.clearChallenge(callerThreadId, project.id, challenge.code, resolved);
      streamSequenceFloor = resolved.resolvedAtSequence;
    }

    streamSequenceFloor ??= yield* readThreadMaxSequence(callerThreadId).pipe(
      Effect.mapError(asError),
    );
    const { challenge } = yield* grants.getOrIssueChallenge({
      callerThreadId,
      projectId: project.id,
      projectTitle: project.title,
      targetIsRemote: project.targetIsRemote,
      streamSequenceFloor,
    });
    return { kind: "confirmation_required", result: confirmationRequiredResult(challenge) };
  },
);
