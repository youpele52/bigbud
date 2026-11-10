import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Option, Ref } from "effect";

import {
  ThreadCoordinationGrants,
  type ThreadCoordinationChallenge,
  type ThreadCoordinationGrantsShape,
  type ThreadCoordinationIssuedChallenge,
  type ThreadCoordinationResolution,
} from "../Services/ThreadCoordinationGrants.ts";
import { generateThreadCoordinationCode } from "../threadCoordinationCode.ts";

export const THREAD_COORDINATION_CHALLENGE_TTL_MS = 30 * 60 * 1000;
/** History outlives every challenge it can still attribute replies for, within a bound. */
const ISSUE_HISTORY_RETENTION_MS = 2 * THREAD_COORDINATION_CHALLENGE_TTL_MS;
const ISSUE_HISTORY_MAX_PER_CALLER = 100;

interface IssuedRecord extends ThreadCoordinationIssuedChallenge {
  readonly issuedAt: number;
}

interface GrantsState {
  readonly grants: ReadonlyMap<ThreadId, ReadonlySet<ProjectId>>;
  readonly challenges: ReadonlyMap<string, ThreadCoordinationChallenge>;
  readonly history: ReadonlyMap<ThreadId, ReadonlyArray<IssuedRecord>>;
  readonly issueCounter: number;
}

interface IssuedChallenge {
  readonly challenge: ThreadCoordinationChallenge;
  readonly issued: boolean;
}

const pairKey = (callerThreadId: ThreadId, projectId: ProjectId) =>
  `${callerThreadId}\n${projectId}`;

const withoutExpired = (
  challenges: ReadonlyMap<string, ThreadCoordinationChallenge>,
  now: number,
): Map<string, ThreadCoordinationChallenge> =>
  new Map([...challenges].filter(([, challenge]) => challenge.expiresAt > now));

/** Drops records past retention, and callers left with none, so history stays bounded. */
const withoutStaleHistory = (
  history: ReadonlyMap<ThreadId, ReadonlyArray<IssuedRecord>>,
  now: number,
): Map<ThreadId, ReadonlyArray<IssuedRecord>> =>
  new Map(
    [...history].flatMap(([callerThreadId, records]) => {
      const live = records.filter((record) => record.issuedAt + ISSUE_HISTORY_RETENTION_MS > now);
      return live.length > 0 ? [[callerThreadId, live] as const] : [];
    }),
  );

/** Marks the caller's history record for `code` resolved, keeping the first resolution. */
const withResolved = (
  history: ReadonlyMap<ThreadId, ReadonlyArray<IssuedRecord>>,
  callerThreadId: ThreadId,
  code: string,
  resolution: ThreadCoordinationResolution | undefined,
): ReadonlyMap<ThreadId, ReadonlyArray<IssuedRecord>> => {
  const resolvedAtSequence = resolution?.resolvedAtSequence;
  const records = history.get(callerThreadId);
  const index =
    records?.findIndex(
      (record) => record.code === code && record.resolvedAtSequence === undefined,
    ) ?? -1;
  if (resolvedAtSequence === undefined || !records || index < 0) return history;
  const updated = [...records];
  updated[index] = { ...records[index]!, resolvedAtSequence };
  const next = new Map(history);
  next.set(callerThreadId, updated);
  return next;
};

export const makeThreadCoordinationGrants = (
  options: { readonly now?: () => number; readonly generateCode?: () => string } = {},
) =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const generateCode = options.generateCode ?? (() => generateThreadCoordinationCode());
    const state = yield* Ref.make<GrantsState>({
      grants: new Map(),
      challenges: new Map(),
      history: new Map(),
      issueCounter: 0,
    });

    const getChallenge: ThreadCoordinationGrantsShape["getChallenge"] = (
      callerThreadId,
      projectId,
    ) =>
      Ref.get(state).pipe(
        Effect.map((current) => {
          const challenge = current.challenges.get(pairKey(callerThreadId, projectId));
          return challenge && challenge.expiresAt > now() ? Option.some(challenge) : Option.none();
        }),
      );

    const getOrIssueChallenge: ThreadCoordinationGrantsShape["getOrIssueChallenge"] = (request) =>
      Effect.sync(() => ({ at: now(), code: generateCode() })).pipe(
        Effect.flatMap(({ at, code }) =>
          Ref.modify(state, (current): readonly [IssuedChallenge, GrantsState] => {
            const key = pairKey(request.callerThreadId, request.projectId);
            const existing = current.challenges.get(key);
            if (existing && existing.expiresAt > at) {
              return [{ challenge: existing, issued: false }, current];
            }
            const challenge: ThreadCoordinationChallenge = {
              callerThreadId: request.callerThreadId,
              projectId: request.projectId,
              code,
              projectTitle: request.projectTitle,
              targetIsRemote: request.targetIsRemote,
              issuedAt: at,
              streamSequenceFloor: request.streamSequenceFloor,
              expiresAt: at + THREAD_COORDINATION_CHALLENGE_TTL_MS,
              issueOrder: current.issueCounter + 1,
            };
            // Sweeping expired challenges on issue keeps memory bounded by live pairs.
            const challenges = withoutExpired(current.challenges, at);
            challenges.set(key, challenge);
            const history = withoutStaleHistory(current.history, at);
            history.set(
              request.callerThreadId,
              [
                ...(history.get(request.callerThreadId) ?? []),
                {
                  projectId: challenge.projectId,
                  code: challenge.code,
                  streamSequenceFloor: challenge.streamSequenceFloor,
                  issueOrder: challenge.issueOrder,
                  issuedAt: at,
                },
              ].slice(-ISSUE_HISTORY_MAX_PER_CALLER),
            );
            return [
              { challenge, issued: true },
              { ...current, challenges, history, issueCounter: challenge.issueOrder },
            ];
          }),
        ),
      );

    const grant: ThreadCoordinationGrantsShape["grant"] = (callerThreadId, projectId, resolution) =>
      Ref.update(state, (current) => {
        const grants = new Map(current.grants);
        grants.set(callerThreadId, new Set([...(grants.get(callerThreadId) ?? []), projectId]));
        const key = pairKey(callerThreadId, projectId);
        const existing = current.challenges.get(key);
        const challenges = new Map(current.challenges);
        challenges.delete(key);
        const history = existing
          ? withResolved(current.history, callerThreadId, existing.code, resolution)
          : current.history;
        return { ...current, grants, challenges, history };
      });

    const clearChallenge: ThreadCoordinationGrantsShape["clearChallenge"] = (
      callerThreadId,
      projectId,
      code,
      resolution,
    ) =>
      Ref.update(state, (current) => {
        const key = pairKey(callerThreadId, projectId);
        const existing = current.challenges.get(key);
        if (!existing || (code !== undefined && existing.code !== code)) return current;
        const challenges = new Map(current.challenges);
        challenges.delete(key);
        const history = withResolved(current.history, callerThreadId, existing.code, resolution);
        return { ...current, challenges, history };
      });

    return ThreadCoordinationGrants.of({
      hasGrant: (callerThreadId, projectId) =>
        Ref.get(state).pipe(
          Effect.map((current) => current.grants.get(callerThreadId)?.has(projectId) === true),
        ),
      getChallenge,
      getOrIssueChallenge,
      listIssuedChallenges: (callerThreadId) =>
        Ref.get(state).pipe(
          Effect.map((current) =>
            (current.history.get(callerThreadId) ?? []).map(
              ({ issuedAt: _issuedAt, ...issued }): ThreadCoordinationIssuedChallenge => issued,
            ),
          ),
        ),
      grant,
      clearChallenge,
    });
  });

export const ThreadCoordinationGrantsLive = Layer.effect(
  ThreadCoordinationGrants,
  makeThreadCoordinationGrants(),
);
