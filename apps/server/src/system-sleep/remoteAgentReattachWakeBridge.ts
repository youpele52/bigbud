/**
 * Bridges sleep evidence to delayed remote-process reattach.
 *
 * A remote process client whose immediate reattach attempts failed waits on its
 * jittered backoff. Every `network-online` and `epoch-ended` event from
 * `SystemSleepEpochs` wakes those waiters, so reattach retries as soon as the
 * link can work again instead of at the next backoff tick. Reattach itself is
 * unchanged: it never spawns, it only attaches to the original operation.
 *
 * @module remoteAgentReattachWakeBridge
 */
import { Effect, Layer, Stream } from "effect";

import { notifyRemoteAgentReattachWake } from "../remote-agent/remoteAgentProcessClient.wake.ts";
import { SystemSleepEpochs } from "./Services/SystemSleepEpochs.ts";

/** Runs one wake notification per sleep event, for the server's lifetime. */
export const runRemoteAgentReattachWakeBridge = Effect.fn("runRemoteAgentReattachWakeBridge")(
  function* (notify: () => void = notifyRemoteAgentReattachWake) {
    const sleep = yield* SystemSleepEpochs;
    yield* Stream.runForEach(sleep.events, () => Effect.sync(notify));
  },
);

export const RemoteAgentReattachWakeBridgeLive = Layer.effectDiscard(
  runRemoteAgentReattachWakeBridge().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("remote agent reattach wake bridge stopped", { cause }),
    ),
    Effect.forkScoped,
  ),
);
