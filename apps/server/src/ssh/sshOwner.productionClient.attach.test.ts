import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { writeSshOwnerAttachmentDescriptor } from "./sshOwnerProductionClient.attachment.ts";
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

describe("production owner client attach", () => {
  it("attaches to a live verified owner without spawning", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
      ownerIdentity: identity,
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql);
        expect(handle.mode).toBe("attached");
        expect(handle.state()).toBe("open");
        expect(server.accepted()).toBe(1);
        expect(yield* Effect.promise(() => fixture.exists(fixture.observationFile))).toBe(false);
        yield* handle.shutdown();
        expect(handle.state()).toBe("detached");
      }),
    );
  });

  it("refuses a second owner when a live owner rejects the profile capability", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
      ownerIdentity: identity,
      rejectProof: true,
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* start(fixture, sql).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "attachment-refused" });
        // No spawn was attempted: no fake-owner observation and no second session.
        expect(yield* Effect.promise(() => fixture.exists(fixture.observationFile))).toBe(false);
        expect(server.accepted()).toBe(0);
      }),
    );
  });

  it("reattaches the same owner across a simulated backend restart", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
      ownerIdentity: identity,
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const first = yield* start(fixture, sql);
        expect(first.mode).toBe("attached");
        yield* first.shutdown();
        const second = yield* start(fixture, sql);
        expect(second.mode).toBe("attached");
        expect(second.ownerEpoch).toEqual(first.ownerEpoch);
        expect(server.accepted()).toBe(2);
        expect(yield* Effect.promise(() => fixture.exists(fixture.observationFile))).toBe(false);
        yield* second.shutdown();
      }),
    );
  });

  it("detaches a surviving attached owner and can attach again", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
      ownerIdentity: identity,
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const first = yield* start(fixture, sql);
        yield* first.shutdown();
        // Detach closed only the session; the owner is still reachable.
        const second = yield* start(fixture, sql);
        expect(server.accepted()).toBe(2);
        yield* second.shutdown();
      }),
    );
  });

  it("refuses an attach descriptor that names another profile", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
      ownerIdentity: identity,
    });
    cleanup.push(server.close);
    await writeSshOwnerAttachmentDescriptor(facts.attachFile, {
      version: 1,
      socketPath: facts.socketPath,
      capability,
      profileBinding: `bbso1:standalone:${"0".repeat(64)}`,
    });
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* start(fixture, sql).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "profile-mismatch" });
        expect(server.accepted()).toBe(0);
        expect(yield* Effect.promise(() => fixture.exists(fixture.observationFile))).toBe(false);
      }),
    );
  });

  it("refuses an owner that echoes a different profile binding and shuts it down", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability, identity } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
      ownerIdentity: identity,
      echoProfileBinding: Buffer.alloc(32, 0xee),
    });
    cleanup.push(server.close);
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* start(fixture, sql).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "profile-mismatch" });
        expect(server.accepted()).toBe(1);
        expect(yield* Effect.promise(() => fixture.exists(fixture.observationFile))).toBe(false);
      }),
    );
  });
});
