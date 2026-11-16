import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path } from "effect";

import { ServerConfig } from "../../startup/config.ts";
import { MobileSetting, mobileLayer, pairedSession } from "./MobileRemoteControl.test.fixtures.ts";

// Real time throughout: session expiry is computed from the wall clock.
describe("MobileRemoteControl.watchSessionEnd", () => {
  it.live("ends with 'revoked' when the session is revoked while watched", () =>
    Effect.gen(function* () {
      const { mobile, session, watch } = yield* pairedSession;
      const fiber = yield* Effect.forkChild(watch(session));
      yield* Effect.sleep("50 millis");
      yield* mobile.revokeSession(session.sessionId);
      assert.equal(yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds")), "revoked");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("ends immediately for a session revoked before watching began", () =>
    Effect.gen(function* () {
      const { mobile, session, watch } = yield* pairedSession;
      yield* mobile.revokeSession(session.sessionId);
      assert.equal(yield* watch(session).pipe(Effect.timeout("2 seconds")), "revoked");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("ends with 'expired' at the session's expiry", () =>
    Effect.gen(function* () {
      const { session, watch } = yield* pairedSession;
      const soon = { ...session, expiresAt: new Date(Date.now() + 100).toISOString() };
      assert.equal(yield* watch(soon).pipe(Effect.timeout("2 seconds")), "expired");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("ends with 'disabled' as soon as mobile remote control is turned off", () =>
    Effect.gen(function* () {
      const { session, watch } = yield* pairedSession;
      const setting = yield* MobileSetting;
      const fiber = yield* Effect.forkChild(watch(session));
      yield* Effect.sleep("50 millis");
      yield* setting.set(false, { announce: true });
      // Well inside the 5 s re-check interval: the change stream ended it.
      assert.equal(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second")), "disabled");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("ends immediately when mobile remote control was already off", () =>
    Effect.gen(function* () {
      const { session, watch } = yield* pairedSession;
      // Turned off without a change event, as if it landed before subscribing.
      yield* (yield* MobileSetting).set(false, { announce: false });
      assert.equal(yield* watch(session).pipe(Effect.timeout("1 second")), "disabled");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("keeps watching while mobile remote control stays on", () =>
    Effect.gen(function* () {
      const { session, watch } = yield* pairedSession;
      yield* (yield* MobileSetting).set(true, { announce: true });
      const outcome = yield* watch(session).pipe(Effect.timeoutOption("300 millis"));
      assert.equal(outcome._tag, "None");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("ends with 'revoked' when cleanup already removed the revoked record", () =>
    Effect.gen(function* () {
      const { mobile, session, watch } = yield* pairedSession;
      yield* mobile.revokeSession(session.sessionId);
      // Listing runs cleanup, which deletes revoked records.
      yield* mobile.listSessions;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionFile = path.join(
        config.stateDir,
        "mobile-remote",
        "sessions",
        `${session.sessionId}.json`,
      );
      assert.isFalse(yield* fs.exists(sessionFile));
      assert.equal(yield* watch(session).pipe(Effect.timeout("1 second")), "revoked");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("does not treat an unreadable session file as a revocation", () =>
    Effect.gen(function* () {
      const { session, watch } = yield* pairedSession;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionFile = path.join(
        config.stateDir,
        "mobile-remote",
        "sessions",
        `${session.sessionId}.json`,
      );
      yield* fs.writeFileString(sessionFile, "{ truncated");
      const outcome = yield* watch(session).pipe(Effect.timeoutOption("300 millis"));
      assert.equal(outcome._tag, "None");
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );
});
