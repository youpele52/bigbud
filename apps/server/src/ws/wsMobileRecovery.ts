import {
  MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH,
  type MobileRecoveryFrame,
  type MobileRecoveryResyncReason,
  type MobileRecoverySubscriptionInput,
} from "@bigbud/contracts/server/mobile.recovery";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Clock, Duration, Effect, Option, Stream } from "effect";
import type { Scope } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeMobileRecoveryCompletionStream } from "./wsMobileRecovery.completion.ts";
import { makeMobileRecoveryAttemptDeadline } from "./wsMobileRecovery.deadline.ts";
import {
  batchFrames,
  MOBILE_RECOVERY_MAX_BATCH_BYTES,
  serializedBytes,
} from "./wsMobileRecovery.frames.ts";

export const MOBILE_RECOVERY_REPLAY_PAGE_LIMIT = MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH;
export const MOBILE_RECOVERY_CAPTURE_CAPACITY = 2_000;
export const MOBILE_RECOVERY_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
export const MOBILE_RECOVERY_MAX_REPLAY_EVENTS = 10_000;
export const MOBILE_RECOVERY_MAX_REPLAY_BYTES = 10 * 1024 * 1024;
export const MOBILE_RECOVERY_MAX_REPLAY_PAGE_BYTES = MOBILE_RECOVERY_MAX_BATCH_BYTES * 4;
export const MOBILE_RECOVERY_DEADLINE_MS = 15_000;

type RecoveryStreamInput = Omit<MobileRecoverySubscriptionInput, "serverEpoch"> & {
  /** Epoch supplied by the client in the matching baseline. */
  readonly clientServerEpoch: string;
  /** Current epoch captured from the authenticated server session. */
  readonly serverEpoch: string;
  readonly orchestrationEngine: OrchestrationEngineShape;
};

type ReadReplayPage =
  | { readonly _tag: "page"; readonly page: OrchestrationReplayEventsResult }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "overflow" }
  | { readonly _tag: "unavailable" };

type ReplayState = {
  readonly cursor: number;
  readonly watermark: number | null;
  readonly replayedEvents: number;
  readonly replayedBytes: number;
};

function isSafeSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function resyncFrame(
  input: RecoveryStreamInput,
  reason: MobileRecoveryResyncReason,
): MobileRecoveryFrame {
  return {
    version: 1,
    type: "resync-required",
    route: "direct-unmanaged",
    recoveryAttemptId: input.recoveryAttemptId,
    serverEpoch: input.serverEpoch,
    reason,
  };
}

function pageEventsThrough(page: OrchestrationReplayEventsResult, watermark: number) {
  return page.events.filter((event) => event.sequence <= watermark);
}

function readReplayPage(
  input: RecoveryStreamInput,
  cursor: number,
  deadline: number,
): Effect.Effect<ReadReplayPage> {
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const remainingMs = deadline - now;
      if (remainingMs <= 0) return Effect.succeed({ _tag: "timeout" } as const);
      return input.orchestrationEngine.readReplay(cursor, MOBILE_RECOVERY_REPLAY_PAGE_LIMIT).pipe(
        Effect.timeoutOption(Duration.millis(remainingMs)),
        Effect.map(
          Option.match({
            onNone: () => ({ _tag: "timeout" }) as const,
            onSome: (page) => {
              if (
                !isSafeSequence(page.latestSequence) ||
                page.latestSequence < cursor ||
                page.requestedFromSequenceExclusive !== cursor
              ) {
                return { _tag: "invalid" } as const;
              }
              if (
                page.events.length > MOBILE_RECOVERY_REPLAY_PAGE_LIMIT ||
                serializedBytes(page.events) > MOBILE_RECOVERY_MAX_REPLAY_PAGE_BYTES
              ) {
                return { _tag: "overflow" } as const;
              }
              return { _tag: "page", page } as const;
            },
          }),
        ),
        Effect.catch(() => Effect.succeed({ _tag: "unavailable" } as const)),
      );
    }),
  );
}

function verifyPage(
  page: ReadonlyArray<OrchestrationEvent>,
  cursor: number,
): { readonly _tag: "ok"; readonly cursor: number } | { readonly _tag: "gap" } {
  let expected = cursor + 1;
  for (const event of page) {
    if (!isSafeSequence(event.sequence) || event.sequence !== expected) {
      return { _tag: "gap" };
    }
    expected += 1;
  }
  return { _tag: "ok", cursor: expected - 1 };
}

function recoveryFrameForPage(
  input: RecoveryStreamInput,
  page: ReadReplayPage,
): MobileRecoveryFrame {
  if (page._tag === "timeout") return resyncFrame(input, "timeout");
  if (page._tag === "invalid") return resyncFrame(input, "invalid-cursor");
  if (page._tag === "overflow") return resyncFrame(input, "overflow");
  return resyncFrame(input, "unavailable");
}

function sameEventIdentity(
  event: OrchestrationEvent,
  identity: { readonly eventId: string; readonly type: string },
): boolean {
  return event.eventId === identity.eventId && event.type === identity.type;
}

export function makeMobileRecoveryFrameStream(input: RecoveryStreamInput) {
  return Effect.gen(function* () {
    if (!isSafeSequence(input.baselineSequence)) {
      return Stream.succeed(resyncFrame(input, "invalid-cursor"));
    }
    if (input.clientServerEpoch !== input.serverEpoch) {
      return Stream.succeed(resyncFrame(input, "invalid-cursor"));
    }
    if (!input.orchestrationEngine.openDeliveryLiveCapture) {
      return Stream.succeed(resyncFrame(input, "unavailable"));
    }

    // Capture is opened before the first replay read. Events committed while
    // the bounded replay pages are being read therefore remain available for
    // the post-watermark live drain.
    const liveCapture = yield* input.orchestrationEngine.openDeliveryLiveCapture(
      MOBILE_RECOVERY_CAPTURE_CAPACITY,
      MOBILE_RECOVERY_CAPTURE_MAX_BYTES,
    );
    let throughSequence = input.baselineSequence;
    let caughtUp = false;
    let completionWatermark: number | null = null;
    let replayedEvents = 0;
    let replayedBytes = 0;
    const canonicalEvents = new Map<number, { readonly eventId: string; readonly type: string }>();
    const attemptDeadline = yield* makeMobileRecoveryAttemptDeadline({
      durationMs: MOBILE_RECOVERY_DEADLINE_MS,
      closeCapture: liveCapture.close,
      markCaughtUp: () => {
        caughtUp = true;
      },
    });

    const rememberCanonicalEvent = (event: OrchestrationEvent): boolean => {
      const known = canonicalEvents.get(event.sequence);
      if (known !== undefined) {
        return sameEventIdentity(event, known);
      }
      canonicalEvents.set(event.sequence, { eventId: event.eventId, type: event.type });
      while (canonicalEvents.size > MOBILE_RECOVERY_MAX_REPLAY_EVENTS) {
        const oldest = canonicalEvents.keys().next().value;
        if (oldest === undefined) break;
        canonicalEvents.delete(oldest);
      }
      return true;
    };

    const rememberPageEvents = (events: ReadonlyArray<OrchestrationEvent>): boolean =>
      events.every(rememberCanonicalEvent);

    const replay = Stream.paginate<ReplayState, MobileRecoveryFrame>(
      {
        cursor: input.baselineSequence,
        watermark: null,
        replayedEvents: 0,
        replayedBytes: 0,
      },
      (state) =>
        readReplayPage(input, state.cursor, attemptDeadline.deadlineAt).pipe(
          Effect.flatMap((readPage) =>
            Effect.sync(() => {
              if (readPage._tag !== "page") {
                return [
                  [recoveryFrameForPage(input, readPage)],
                  Option.none<ReplayState>(),
                ] as const;
              }

              const watermark = state.watermark ?? readPage.page.latestSequence;
              if (!isSafeSequence(watermark) || input.baselineSequence > watermark) {
                return [
                  [resyncFrame(input, "invalid-cursor")],
                  Option.none<ReplayState>(),
                ] as const;
              }
              if (readPage.page.availability === "gap") {
                return [[resyncFrame(input, "gap")], Option.none<ReplayState>()] as const;
              }

              const events = pageEventsThrough(readPage.page, watermark);
              if (replayedEvents + events.length > MOBILE_RECOVERY_MAX_REPLAY_EVENTS) {
                return [[resyncFrame(input, "overflow")], Option.none<ReplayState>()] as const;
              }
              const eventsBytes = serializedBytes(events);
              if (replayedBytes + eventsBytes > MOBILE_RECOVERY_MAX_REPLAY_BYTES) {
                return [[resyncFrame(input, "overflow")], Option.none<ReplayState>()] as const;
              }
              const checked = verifyPage(events, state.cursor);
              if (checked._tag === "gap") {
                return [[resyncFrame(input, "gap")], Option.none<ReplayState>()] as const;
              }
              if (!rememberPageEvents(events)) {
                return [[resyncFrame(input, "gap")], Option.none<ReplayState>()] as const;
              }
              if (events.length === 0 && state.cursor < watermark) {
                return [[resyncFrame(input, "gap")], Option.none<ReplayState>()] as const;
              }

              const nextCursor = checked.cursor;
              throughSequence = nextCursor;
              const frames = batchFrames(input, events);
              if (frames === null) {
                return [[resyncFrame(input, "overflow")], Option.none<ReplayState>()] as const;
              }
              replayedEvents += events.length;
              replayedBytes += eventsBytes;
              if (nextCursor >= watermark) {
                completionWatermark = watermark;
                return [frames, Option.none<ReplayState>()] as const;
              }

              return [
                frames,
                Option.some({
                  cursor: nextCursor,
                  watermark,
                  replayedEvents,
                  replayedBytes,
                }),
              ] as const;
            }),
          ),
        ),
    );

    const recoverLiveGap = (event: OrchestrationEvent) =>
      Effect.gen(function* () {
        const gapStartedAt = yield* Clock.currentTimeMillis;
        const gapDeadline = gapStartedAt + MOBILE_RECOVERY_DEADLINE_MS;
        let cursor = throughSequence;
        const recovered: OrchestrationEvent[] = [];
        while (cursor < event.sequence) {
          const page = yield* readReplayPage(input, cursor, gapDeadline);
          if (page._tag !== "page") {
            return [recoveryFrameForPage(input, page)];
          }
          if (page.page.availability === "gap") {
            return [resyncFrame(input, "gap")];
          }
          const events = page.page.events.filter(
            (candidate) => candidate.sequence <= event.sequence,
          );
          if (events.length === 0) {
            return [resyncFrame(input, "gap")];
          }
          const checked = verifyPage(events, cursor);
          if (checked._tag === "gap") {
            return [resyncFrame(input, "gap")];
          }
          if (!rememberPageEvents(events)) {
            return [resyncFrame(input, "gap")];
          }
          const eventsBytes = serializedBytes(events);
          if (replayedBytes + eventsBytes > MOBILE_RECOVERY_MAX_REPLAY_BYTES) {
            return [resyncFrame(input, "overflow")];
          }
          replayedBytes += eventsBytes;
          recovered.push(...events);
          replayedEvents += events.length;
          if (replayedEvents > MOBILE_RECOVERY_MAX_REPLAY_EVENTS) {
            return [resyncFrame(input, "overflow")];
          }
          cursor = checked.cursor;
        }
        const canonicalTrigger = canonicalEvents.get(event.sequence);
        if (canonicalTrigger === undefined || !sameEventIdentity(event, canonicalTrigger)) {
          return [resyncFrame(input, "gap")];
        }
        throughSequence = cursor;
        const frames = batchFrames(input, recovered);
        return frames === null ? [resyncFrame(input, "overflow")] : frames;
      });

    const live = liveCapture.stream.pipe(
      Stream.mapEffect((event) => {
        if (!isSafeSequence(event.sequence)) {
          return Effect.succeed([resyncFrame(input, "invalid-cursor")]);
        }
        if (event.sequence <= input.baselineSequence) {
          return Effect.succeed([] as ReadonlyArray<MobileRecoveryFrame>);
        }
        if (!caughtUp || event.sequence <= throughSequence) {
          if (event.sequence <= throughSequence) {
            const known = canonicalEvents.get(event.sequence);
            if (known === undefined || !sameEventIdentity(event, known)) {
              return Effect.succeed([resyncFrame(input, "gap")]);
            }
          }
          return Effect.succeed([] as ReadonlyArray<MobileRecoveryFrame>);
        }
        if (event.sequence === throughSequence + 1) {
          if (!rememberCanonicalEvent(event)) {
            return Effect.succeed([resyncFrame(input, "gap")]);
          }
          throughSequence = event.sequence;
          const frames = batchFrames(input, [event]);
          return Effect.succeed(frames ?? [resyncFrame(input, "overflow")]);
        }
        return recoverLiveGap(event);
      }),
      Stream.flatMap((frames) => Stream.fromIterable(frames)),
      Stream.catchCause(() => Stream.succeed(resyncFrame(input, "overflow"))),
    );

    const completion = makeMobileRecoveryCompletionStream({
      recoveryAttemptId: input.recoveryAttemptId,
      serverEpoch: input.serverEpoch,
      liveCapture,
      getWatermark: () => completionWatermark,
      completeIfCurrent: attemptDeadline.completeIfCurrent,
    });

    const replayWithDeadline = replay.pipe(
      Stream.mapEffect((frame) =>
        attemptDeadline.isExpired.pipe(
          Effect.map((expired) => (expired ? resyncFrame(input, "timeout") : frame)),
        ),
      ),
    );

    return Stream.concat(Stream.concat(replayWithDeadline, completion), live).pipe(
      Stream.takeUntil((frame) => frame.type === "resync-required"),
      Stream.ensuring(
        Effect.sync(() => {
          caughtUp = false;
        }),
      ),
    );
  });
}

export type MobileRecoveryFrameStream = Stream.Stream<MobileRecoveryFrame, never, Scope.Scope>;
