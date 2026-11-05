import { Effect } from "effect";

import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import { museValidationError } from "./Client.errors.ts";
import type { MuseAdapterContext } from "./Adapter.types.ts";
import { mapMuseRequestError } from "./Client.errors.ts";
import { validateMuseAck } from "./Adapter.interactions.ts";

/**
 * Exact-turn Stop: queued submissions are reclaimed with exact-ID
 * `turn/unqueue`; running turns use the Phase 0-qualified exact-ID
 * `turn/cancel`. Neither acknowledgement is the outcome — the terminal or
 * reclaim notification settles the turn.
 */
export const makeMuseInterruptTurn = (ctx: MuseAdapterContext): MuseAdapterShape["interruptTurn"] =>
  Effect.fn("Muse.interruptTurn")(function* (threadId, turnId) {
    const session = yield* ctx.getSession(threadId);
    const target = turnId ?? session.activeTurnId;
    if (!target)
      return yield* museValidationError(
        "interruptTurn",
        "No active Muse turn to stop.",
        "invalid-request",
      );
    const cid = session.transport.mintCommandId();
    // Queued work is reclaimed by exact ID; running work uses the Phase 0
    // qualified turn/cancel (ack is admission, not the outcome).
    const method = session.queuedTurns.has(String(target)) ? "turn/unqueue" : "turn/cancel";
    const raw = yield* Effect.tryPromise({
      try: () =>
        session.transport.command(
          method,
          { commandId: cid, sessionId: session.nativeSessionId, turnId: target },
          cid,
        ),
      catch: (error) => mapMuseRequestError(method, error, "unsafe-to-replay"),
    });
    yield* Effect.try({
      try: () => validateMuseAck(raw, method, cid, { turnId: target }),
      catch: (cause) => mapMuseRequestError(method, cause, "unsafe-to-replay"),
    });
  });
