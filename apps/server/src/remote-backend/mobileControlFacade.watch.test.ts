import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  fixtureAdmission,
  mobileFacadeFixture,
  pairUsing,
} from "./mobileControlFacade.test-fixtures.ts";

it("closes when an off/on durable revision changed before subscription, without resurrecting old tokens", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const { session } = yield* pairUsing(f.mobile);
      const validated = yield* f.mobile.validateSessionToken(session.token);
      if (!validated) throw new Error("Expected current fixture session");
      yield* f.settings.updateSettings({ mobileRemoteControl: { enabled: false } });
      f.state.stamp = { ...fixtureAdmission, consentRevision: 2 };
      yield* f.settings.updateSettings({ mobileRemoteControl: { enabled: true } });
      // The toggle happened before the watcher subscribes; its re-read must still reject it.
      expect(yield* f.mobile.watchSessionEnd!(validated)).toBe("revoked");
      expect(yield* f.mobile.validateSessionToken(session.token)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));

it("closes an active socket watch on readiness loss and leaves its same-revision token usable after recovery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const { session } = yield* pairUsing(f.mobile);
      const validated = yield* f.mobile.validateSessionToken(session.token);
      if (!validated) throw new Error("Expected current fixture session");
      const watcher = yield* f.mobile.watchSessionEnd!(validated).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      f.state.ready = false;
      yield* f.notify("disabled");
      expect(yield* Fiber.join(watcher)).toBe("disabled");
      expect(yield* f.mobile.validateSessionToken(session.token)).toBeNull();
      f.state.ready = true;
      expect(yield* f.mobile.validateSessionToken(session.token)).toMatchObject({
        sessionId: session.sessionId,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));

it("preserves actual revoke/expiry watch and rejects copied validation handles", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const { session } = yield* pairUsing(f.mobile);
      const validated = yield* f.mobile.validateSessionToken(session.token);
      if (!validated) throw new Error("Expected current fixture session");
      expect(yield* f.mobile.watchSessionEnd!({ ...validated })).toBe("revoked");
      const watcher = yield* f.mobile.watchSessionEnd!(validated).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* f.mobile.revokeSession(session.sessionId);
      expect(yield* Fiber.join(watcher)).toBe("revoked");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));

it("waits for the existing settings barrier before reading admission or validating a record", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const { session } = yield* pairUsing(f.mobile);
      const barrier = f.settings.withSnapshotBarrier;
      if (!barrier) throw new Error("Expected real fixture settings barrier");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* barrier(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const readsBefore = f.state.reads;
      const validating = yield* f.mobile.validateSessionToken(session.token).pipe(Effect.forkChild);
      yield* Effect.sleep("5 millis");
      expect(f.state.reads).toBe(readsBefore);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(validating)).toMatchObject({ sessionId: session.sessionId });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));
