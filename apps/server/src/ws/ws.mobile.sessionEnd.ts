import { Deferred, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import type {
  MobileRemoteSessionEndReason,
  MobileRemoteSessionRecord,
  MobileRemoteControlShape,
} from "../mobile/Services/MobileRemoteControl";

/**
 * Close code for an established mobile socket whose session ended. The phone
 * treats 4401 with an "unauthorized/revoked/expired" reason as an explicit
 * authorization rejection (re-pair), not a network failure to retry.
 * Upgrade-time rejections stay plain HTTP 401, which browsers cannot read.
 */
export const MOBILE_SESSION_ENDED_CLOSE_CODE = 4401;

/**
 * Close code when the host turns mobile remote control off. The session itself
 * stays valid, so this is deliberately not an authorization close: the phone
 * keeps its pairing and reconnects once access is turned back on.
 */
export const MOBILE_REMOTE_CONTROL_DISABLED_CLOSE_CODE = 4503;

export function mobileSessionEndedClose(reason: MobileRemoteSessionEndReason): {
  readonly code: number;
  readonly reason: string;
} {
  switch (reason) {
    case "revoked":
      return {
        code: MOBILE_SESSION_ENDED_CLOSE_CODE,
        reason: "unauthorized: mobile session revoked",
      };
    case "expired":
      return {
        code: MOBILE_SESSION_ENDED_CLOSE_CODE,
        reason: "unauthorized: mobile session expired",
      };
    case "disabled":
      return {
        code: MOBILE_REMOTE_CONTROL_DISABLED_CLOSE_CODE,
        reason: "mobile remote control was turned off on this host",
      };
  }
}

/**
 * Wraps the request so the socket produced by its upgrade is captured. Every
 * other property reads from the original request unchanged.
 */
function captureUpgrade(
  request: HttpServerRequest.HttpServerRequest,
  upgraded: Deferred.Deferred<Socket.Socket>,
): HttpServerRequest.HttpServerRequest {
  return new Proxy(request, {
    get(target, property) {
      if (property === "upgrade") {
        return target.upgrade.pipe(Effect.tap((socket) => Deferred.succeed(upgraded, socket)));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Serves the mobile RPC socket until the client leaves or the session ends.
 * On revocation, expiry or mobile access being turned off, the socket is closed with an explicit code, so no
 * further request on it is accepted. Commands the backend accepted before
 * that point are not cancelled.
 */
export function serveUntilMobileSessionEnds<R>(
  rpcWebSocketHttpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
  request: HttpServerRequest.HttpServerRequest,
  mobileRemoteControl: MobileRemoteControlShape,
  session: MobileRemoteSessionRecord,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
  const watchSessionEnd = mobileRemoteControl.watchSessionEnd;
  if (watchSessionEnd === undefined) return rpcWebSocketHttpEffect;
  return Effect.gen(function* () {
    const upgraded = yield* Deferred.make<Socket.Socket>();
    const closeWhenSessionEnds = watchSessionEnd(session).pipe(
      Effect.flatMap((reason) =>
        Deferred.await(upgraded).pipe(
          Effect.flatMap((socket) =>
            Effect.scoped(
              Effect.flatMap(socket.writer, (write) =>
                write(
                  new Socket.CloseEvent(
                    mobileSessionEndedClose(reason).code,
                    mobileSessionEndedClose(reason).reason,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      // If writing the close frame fails the socket is already gone.
      Effect.ignore,
      Effect.andThen(Effect.never),
    );
    return yield* rpcWebSocketHttpEffect.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, captureUpgrade(request, upgraded)),
      Effect.raceFirst(closeWhenSessionEnds),
    );
  });
}
