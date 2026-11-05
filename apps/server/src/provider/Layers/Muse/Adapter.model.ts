import { Effect, Option } from "effect";
import { decodeSessionRead } from "./Client.schema.ts";

import { mapMuseRequestError, museValidationError } from "./Client.errors.ts";
import type { MuseTransport } from "./Client.ts";

/**
 * Confirmed in-session model switch. The wire shape is the SDK
 * `ModelSelection` object (`model: { modelId, providerId }`); a bare `modelId`
 * is rejected as invalid params (live-verified, CLI 1.4.14-R7309.1). The ack
 * is admission only, so the switch is confirmed by `session/read`.
 */
export const switchMuseModel = Effect.fn("Muse.switchModel")(function* (input: {
  readonly transport: MuseTransport;
  readonly nativeSessionId: string;
  readonly model: string;
  readonly providerId: string;
  readonly operation: string;
}) {
  const cid = input.transport.mintCommandId();
  yield* Effect.tryPromise({
    try: () =>
      input.transport.command(
        "session/setModel",
        {
          commandId: cid,
          sessionId: input.nativeSessionId,
          model: { modelId: input.model, providerId: input.providerId },
        },
        cid,
      ),
    catch: (error) => mapMuseRequestError("session/setModel", error, "unsafe-to-replay"),
  });
  const readRaw = yield* Effect.tryPromise({
    try: () =>
      input.transport.request("session/read", {
        sessionId: input.nativeSessionId,
        excludeItems: true,
      }),
    catch: (error) => mapMuseRequestError("session/read", error, "unsafe-to-replay"),
  });
  const read = decodeSessionRead(readRaw);
  if (
    Option.isNone(read) ||
    read.value.session.sessionId !== input.nativeSessionId ||
    read.value.session.modelId !== input.model
  ) {
    return yield* museValidationError(
      input.operation,
      `Muse did not confirm model switch to '${input.model}'.`,
      "invalid-request",
    );
  }
});
