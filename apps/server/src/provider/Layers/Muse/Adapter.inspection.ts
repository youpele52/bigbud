import { Effect, Option, Ref } from "effect";

import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import type { MuseAdapterContext } from "./Adapter.types.ts";
import { mapMuseRequestError } from "./Client.errors.ts";
import { decodeSessionRead, museSnapshotQueue } from "./Client.schema.ts";
import { mapTerminalState } from "./Adapter.stream.turns.ts";

/**
 * Authoritative active-turn inspection via native `session/read`.
 * Transport errors report `unavailable`, never idle or success.
 */
export const makeMuseInspectActiveTurn = (
  ctx: MuseAdapterContext,
): MuseAdapterShape["inspectActiveTurn"] =>
  Effect.fn("Muse.inspectActiveTurn")(function* (threadId, turnId) {
    const sessions = yield* Ref.get(ctx.sessionsRef);
    const session = sessions.get(threadId);
    const now = new Date().toISOString();
    if (!session || session.closed) return { status: "unavailable", observedAt: now } as const;
    const rawOption = yield* Effect.tryPromise({
      try: () =>
        session.transport.request("session/read", {
          sessionId: session.nativeSessionId,
          excludeItems: false,
        }),
      catch: (cause) => mapMuseRequestError("session/read", cause),
    }).pipe(Effect.option);
    if (Option.isNone(rawOption)) {
      // Transport errors mean inspection unknown, not idle/success.
      return { status: "unavailable", observedAt: now } as const;
    }
    const read = decodeSessionRead(rawOption.value);
    if (Option.isNone(read) || read.value.session.sessionId !== session.nativeSessionId)
      return { status: "unavailable", observedAt: now } as const;
    const native = read.value;
    const queue = museSnapshotQueue(native);
    if (queue !== undefined) session.hasUnidentifiedQueuedInputs = false;
    else if (native.queuedInputs?.length) session.hasUnidentifiedQueuedInputs = true;
    if (native.lastTurn?.turnId === turnId) {
      const outcome = mapTerminalState(native.lastTurn.terminal);
      return outcome === "completed"
        ? ({
            status: "completed",
            observedAt: now,
            completionEvidence: { source: "muse.session/read.lastTurn" },
          } as const)
        : ({
            status: "failed",
            observedAt: now,
            errorEvidence: {
              source: "muse.session/read.lastTurn",
              message: `Muse turn ${outcome}.`,
            },
          } as const);
    }
    if (native.session.activeTurnId === turnId || queue?.some((entry) => entry.turnId === turnId))
      return { status: "running", observedAt: now } as const;
    // A root queue entry cannot be correlated by ID in this SDK. Do not infer missing.
    if (
      native.queuedInputs?.length ||
      (!queue && (session.queuedTurns.has(turnId) || session.hasUnidentifiedQueuedInputs))
    )
      return { status: "unavailable", observedAt: now } as const;
    return { status: "missing", observedAt: now } as const;
  });
