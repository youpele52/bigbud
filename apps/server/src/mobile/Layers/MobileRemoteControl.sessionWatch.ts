import { Duration, Effect, Option, PubSub, Schedule, Stream } from "effect";

import type { ServerSettingsShape } from "../../ws/serverSettings";
import type {
  MobileRemoteSessionEndReason,
  MobileRemoteSessionRecord,
} from "../Services/MobileRemoteControl";

/** Backstop re-read of the mobile setting while a session socket is open. */
const DISABLED_RECHECK_INTERVAL = Duration.seconds(5);

/**
 * Ends once mobile remote control is explicitly off. The change stream reports
 * a toggle as it happens; the periodic re-read (immediate first) covers a
 * toggle that lands before the stream has subscribed. A failed settings read
 * is not proof of "off", so it keeps waiting.
 */
function untilMobileDisabled(
  serverSettings: Pick<ServerSettingsShape, "getSettings" | "streamChanges">,
): Effect.Effect<"disabled"> {
  return Effect.raceFirst(
    serverSettings.streamChanges.pipe(
      Stream.filter((settings) => !settings.mobileRemoteControl.enabled),
      Stream.runHead,
      Effect.flatMap((first) => (Option.isSome(first) ? Effect.void : Effect.never)),
    ),
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.mobileRemoteControl.enabled),
      Effect.orElseSucceed(() => true),
      Effect.repeat({
        until: (enabled) => !enabled,
        schedule: Schedule.spaced(DISABLED_RECHECK_INTERVAL),
      }),
      Effect.asVoid,
    ),
  ).pipe(Effect.as("disabled" as const));
}

/**
 * Builds `watchSessionEnd`: completes when the session is revoked, expires,
 * or mobile remote control is turned off, whichever happens first.
 */
export function makeWatchSessionEnd(input: {
  /** Publishes the ID of every session revoked from now on. */
  readonly revocations: PubSub.PubSub<string>;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings" | "streamChanges">;
  /** True once this process revoked the session, even if cleanup removed its record. */
  readonly wasRevoked: (sessionId: string) => boolean;
  /** The stored `revokedAt`, or none when the record is missing or unreadable. */
  readonly readRevokedAt: (sessionId: string) => Effect.Effect<Option.Option<string | null>>;
}): (session: MobileRemoteSessionRecord) => Effect.Effect<MobileRemoteSessionEndReason> {
  return (session) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before re-checking, so a revocation between the socket's
        // validation and this point is still observed.
        const subscription = yield* PubSub.subscribe(input.revocations);
        const revokedAt = yield* input.readRevokedAt(session.sessionId);
        // Only an explicit revocation counts; an unreadable or missing file is
        // not proof of revocation, and expiry below still bounds the wait.
        if (
          input.wasRevoked(session.sessionId) ||
          (Option.isSome(revokedAt) && revokedAt.value !== null)
        ) {
          return "revoked" as const;
        }
        const untilRevoked = PubSub.take(subscription).pipe(
          Effect.repeat({ until: (revokedId) => revokedId === session.sessionId }),
          Effect.as("revoked" as const),
        );
        const untilExpired = Effect.sleep(
          Duration.millis(Math.max(0, Date.parse(session.expiresAt) - Date.now())),
        ).pipe(Effect.as("expired" as const));
        const endings: ReadonlyArray<Effect.Effect<MobileRemoteSessionEndReason>> = [
          untilRevoked,
          untilExpired,
          untilMobileDisabled(input.serverSettings),
        ];
        return yield* Effect.raceAll(endings);
      }),
    );
}
