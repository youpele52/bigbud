import { createHmac, randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  ensurePrivateSshOwnerDirectory,
  writeSshOwnerAttachmentDescriptor,
} from "./sshOwnerProductionClient.attachment.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import {
  makeProductionFixture,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";

type Sql = SqlClient.SqlClient;

const varint = (value: number) => {
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
};
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const uintField = (field: number, value: number) => Buffer.concat([tag(field, 0), varint(value)]);
const bytesField = (field: number, value: Buffer) =>
  Buffer.concat([tag(field, 2), varint(value.length), value]);
const frame = (field: number, payload: Buffer) => {
  const body = bytesField(field, payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};
const readBytesField = (payload: Buffer, field: number): Buffer | undefined => {
  let offset = 0;
  while (offset < payload.length) {
    const key = payload[offset]!;
    offset += 1;
    if ((key & 7) !== 2) return undefined;
    if (key >> 3 === field) {
      let length = 0;
      for (;;) {
        const byte = payload[offset++]!;
        length |= (byte & 127) << 0;
        if ((byte & 128) === 0) break;
        length <<= 7;
      }
      return payload.subarray(offset, offset + length);
    }
    return undefined;
  }
  return undefined;
};

interface FakeAttachOwner {
  readonly accepted: () => number;
  readonly close: () => Promise<void>;
}

async function makeFakeAttachOwner(input: {
  socketPath: string;
  capability: Buffer;
  profileBinding: Buffer;
  targetId: string;
  rejectProof?: boolean;
  echoProfileBinding?: Buffer;
}): Promise<FakeAttachOwner> {
  const epoch = Buffer.alloc(32, 3);
  let accepted = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < 4 + size) return;
        const body = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        const payload = readBytesField(body, 11);
        if (stage === 0 && payload) {
          const clientNonce = readBytesField(payload, 1) ?? Buffer.alloc(0);
          const serverNonce = randomBytes(32);
          const proof = createHmac("sha256", input.capability)
            .update("bigbud.ssh-owner.proof-server.v1\0", "ascii")
            .update(input.profileBinding)
            .update(clientNonce)
            .update(serverNonce)
            .digest();
          socket.write(
            frame(
              12,
              Buffer.concat([
                bytesField(1, serverNonce),
                bytesField(2, input.rejectProof ? Buffer.alloc(32) : proof),
              ]),
            ),
          );
          stage = 1;
        } else if (stage === 1 && readBytesField(body, 13)) {
          // Production is multi-target: acceptance first, no pinned target and
          // no generation. Each target hydrates on its first request.
          stage = 3;
          accepted += 1;
          const hello = Buffer.concat([
            uintField(1, 1),
            uintField(2, 0),
            bytesField(3, epoch),
            bytesField(4, Buffer.alloc(0)),
            bytesField(6, input.echoProfileBinding ?? input.profileBinding),
            uintField(7, 1),
          ]);
          socket.write(frame(2, hello));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => resolve());
  });
  await chmod(input.socketPath, 0o600);
  return {
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function withPersistence<A, E>(
  fixture: ProductionFixture,
  run: (sql: Sql) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  return Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), run).pipe(Effect.provide(layer)),
  );
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function fixtureWithDescriptor(fixture: ProductionFixture) {
  const facts = resolveSshOwnerLaunchFacts(fixture.profile);
  await ensurePrivateSshOwnerDirectory(facts.directory);
  const capability = randomBytes(32);
  await writeSshOwnerAttachmentDescriptor(facts.attachFile, {
    version: 1,
    socketPath: facts.socketPath,
    capability,
    profileBinding: facts.profileBindingText,
  });
  return { facts, capability };
}

const start = (fixture: ProductionFixture, sql: Sql) =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact("/nonexistent-owner-never-spawned", "desktop-packaged"),
    facts: resolveSshOwnerLaunchFacts(fixture.profile),
    sql,
  });

describe("production owner client attach", () => {
  it("attaches to a live verified owner without spawning", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
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
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
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
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
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
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
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
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
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
    const { facts, capability } = await fixtureWithDescriptor(fixture);
    const server = await makeFakeAttachOwner({
      socketPath: facts.socketPath,
      capability,
      profileBinding: facts.profileBinding,
      targetId: facts.target?.targetId ?? "ssh:host=fixture&auth=ssh-key&transport=direct-ssh",
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
