import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";
import {
  fixtureWithDescriptor,
  makeFakeAttachOwner,
  start,
  withPersistence,
} from "./sshOwner.productionClient.attach.fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const targetId = "ssh:host=fixture&auth=ssh-key&transport=direct-ssh";

/**
 * W6 defect (a)/(b): a backend never adopts an owner from another install path or build.
 * The owner refuses typed (82) and retires; the backend then starts its own owner instead
 * of attaching a foreign one whose every operation would fail.
 */
describe("production owner attach artifact identity", () => {
  it("refuses an owner from another artifact, waits for it to retire and spawns its own", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId,
      // A different install path or build measures a different identity.
      ownerIdentity: Buffer.alloc(32, 0x42),
    });
    cleanup.push(server.close);
    const ownArtifact = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, ownArtifact);
        expect(server.refused()).toBe(1);
        expect(server.accepted()).toBe(0);
        expect(handle.mode).toBe("spawned");
        expect(handle.state()).toBe("open");
        yield* handle.shutdown();
      }),
    );
  });

  it("never adopts an owner that cannot report its identity", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId,
      ownerIdentity: null,
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        // It keeps its socket, so no second owner may start: a typed refusal, no spawn.
        const failure = yield* start(fixture, sql, undefined, 200).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "artifact-mismatch" });
        expect(server.accepted()).toBe(0);
        expect(yield* Effect.promise(() => fixture.exists(fixture.observationFile))).toBe(false);
      }),
    );
  });

  it("attaches an owner whose identity matches the artifact this backend would launch", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId,
      ownerIdentity: identity,
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql);
        expect(handle.mode).toBe("attached");
        expect(server.refused()).toBe(0);
        yield* handle.shutdown();
      }),
    );
  });
});
