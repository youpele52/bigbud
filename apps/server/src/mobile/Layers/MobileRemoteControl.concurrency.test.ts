import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { mobileLayer, pairedSession } from "./MobileRemoteControl.test.fixtures.ts";

const ROUNDS = 25;

// Real file I/O: these races only show up with real interleaved reads/writes.
describe("MobileRemoteControl store consistency", () => {
  it.live("a validation racing a revocation never un-revokes the session", () =>
    Effect.gen(function* () {
      for (let round = 0; round < ROUNDS; round += 1) {
        const { mobile, session } = yield* pairedSession;
        yield* Effect.all(
          [
            mobile.validateSessionToken(session.token),
            mobile.validateSessionToken(session.token),
            mobile.revokeSession(session.sessionId),
            mobile.validateSessionToken(session.token),
          ],
          { concurrency: "unbounded" },
        );
        // Once the revocation has completed, the token must stay dead.
        assert.isNull(yield* mobile.validateSessionToken(session.token), `round ${round}`);
      }
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );

  it.live("one pairing secret exchanged concurrently creates exactly one session", () =>
    Effect.gen(function* () {
      const { mobile } = yield* pairedSession;
      const pairing = yield* mobile.createPairing({
        scope: "thread-control",
        baseUrl: "https://desk.ts.net/mobile",
        backendBaseUrl: "https://desk.ts.net",
      });
      const before = (yield* mobile.listSessions).length;
      const outcomes = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          mobile
            .exchangePairing({ pairingId: pairing.pairingId, secret: pairing.secret, label: "x" })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
      assert.equal((yield* mobile.listSessions).length, before + 1);
    }).pipe(Effect.scoped, Effect.provide(mobileLayer)),
  );
});
