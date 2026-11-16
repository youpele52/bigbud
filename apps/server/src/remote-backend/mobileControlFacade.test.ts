import * as NodeServices from "@effect/platform-node/NodeServices";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  fixtureAdmission,
  mobileFacadeFixture,
  pairUsing,
} from "./mobileControlFacade.test-fixtures.ts";

it.each([
  { name: "missing lifecycle", status: false },
  { name: "missing committed admission", admission: false },
  { name: "legacy ready-only status", legacyReadyOnly: true },
  { name: "missing settings barrier", barrier: false },
])("denies $name before creating mobile files, preserving empty owner administration", (options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture(options);
      const issued = yield* Effect.exit(pairUsing(f.mobile));
      expect(Exit.isFailure(issued)).toBe(true);
      expect(yield* f.mobile.getPairingStatus("fixture-id")).toBeNull();
      expect(
        yield* f.mobile
          .exchangePairing({ pairingId: "fixture-id", secret: "fixture-secret", label: "phone" })
          .pipe(Effect.exit)
          .pipe(Effect.map(Exit.isFailure)),
      ).toBe(true);
      expect(yield* f.mobile.validateSessionToken("fixture-token")).toBeNull();
      expect(yield* f.mobile.listSessions).toEqual([]);
      yield* f.mobile.revokeSession("fixture-id");
      expect(existsSync(join(f.config.stateDir, "mobile-remote"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ),
);

it("uses one real store and persists private admission without changing returned credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const { pairing, session } = yield* pairUsing(f.mobile);
      const saved = yield* Effect.promise(() =>
        fs.readFile(
          join(f.config.stateDir, "mobile-remote", "sessions", `${session.sessionId}.json`),
          "utf8",
        ),
      );
      expect(JSON.parse(saved).remoteAdmission).toEqual(fixtureAdmission);
      expect(session).not.toHaveProperty("remoteAdmission");
      expect(pairing.pairUrl).toContain(`${fixtureAdmission.backendExternalOrigin}/mobile/pair/`);
      expect(yield* f.mobile.validateSessionToken(session.token)).toMatchObject({
        sessionId: session.sessionId,
      });
      // Fresh facade/store over the same files must not rely on an in-memory token binding.
      const rebuilt = yield* f.rebuild;
      expect(yield* rebuilt.validateSessionToken(session.token)).toMatchObject({
        sessionId: session.sessionId,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));

it("rejects a foreign target before issue and keeps prior-revision sessions administrable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            f.mobile.createPairing({
              scope: "read-only",
              baseUrl: "https://foreign.invalid",
              backendBaseUrl: "https://foreign.invalid",
            }),
          ),
        ),
      ).toBe(true);
      expect(existsSync(join(f.config.stateDir, "mobile-remote"))).toBe(false);
      const { session } = yield* pairUsing(f.mobile);
      f.state.stamp = { ...fixtureAdmission, consentRevision: 2 };
      expect(yield* f.mobile.validateSessionToken(session.token)).toBeNull();
      expect(yield* f.mobile.listSessions).toHaveLength(1);
      yield* f.mobile.revokeSession(session.sessionId);
      f.state.stamp = structuredClone(fixtureAdmission);
      expect(yield* f.mobile.validateSessionToken(session.token)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));

it("refuses unstamped legacy files remotely and refuses stale pairing exchange", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const { session } = yield* pairUsing(f.mobile);
      const file = join(
        f.config.stateDir,
        "mobile-remote",
        "sessions",
        `${session.sessionId}.json`,
      );
      yield* Effect.promise(async () => {
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        delete data.remoteAdmission;
        await fs.writeFile(file, JSON.stringify(data));
      });
      expect(yield* f.mobile.validateSessionToken(session.token)).toBeNull();
      const pairing = yield* f.mobile.createPairing({
        scope: "read-only",
        baseUrl: fixtureAdmission.backendExternalOrigin,
        backendBaseUrl: fixtureAdmission.backendExternalOrigin,
      });
      f.state.stamp = { ...fixtureAdmission, consentRevision: 2 };
      expect(yield* f.mobile.getPairingStatus(pairing.pairingId)).toBeNull();
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            f.mobile.exchangePairing({
              pairingId: pairing.pairingId,
              secret: pairing.secret,
              label: "phone",
            }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ));

it.each([
  { name: "unsafe consent revision", patch: { consentRevision: Number.MAX_SAFE_INTEGER + 1 } },
  {
    name: "credential-bearing origin",
    patch: { backendExternalOrigin: "https://user:fixture@fixture.ts.net" },
  },
  { name: "unknown future stamp", patch: { future: true } },
])("rejects $name before issuing or creating records", ({ patch }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* mobileFacadeFixture();
      const supplied = { ...fixtureAdmission, ...patch };
      f.state.stamp = supplied;
      expect(Exit.isFailure(yield* Effect.exit(pairUsing(f.mobile)))).toBe(true);
      expect(existsSync(join(f.config.stateDir, "mobile-remote"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  ),
);
