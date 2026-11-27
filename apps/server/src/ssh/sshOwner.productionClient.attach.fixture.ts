import { createHmac, randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  ensurePrivateSshOwnerDirectory,
  writeSshOwnerAttachmentDescriptor,
} from "./sshOwnerProductionClient.attachment.ts";
import { measureSshOwnerArtifactIdentity } from "./sshOwnerProductionClient.identity.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import type { ProductionFixture } from "./sshOwnerProductionClient.fixture.ts";

/**
 * In-process fake of a surviving owner's attach socket for the production client
 * attach tests: mutual proof, reconciliation, and the artifact identity check
 * (typed refusal 82, then the fake retires as the real owner does).
 *
 * @module sshOwner.productionClient.attach.fixture
 */
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
const readVarint = (payload: Buffer, start: number): [number, number] => {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = payload[offset++];
    if (byte === undefined) throw new Error("truncated varint");
    value += (byte & 127) * 2 ** shift;
    if ((byte & 128) === 0) return [value, offset];
    shift += 7;
  }
};
const readBytesField = (payload: Buffer, field: number): Buffer | undefined => {
  let offset = 0;
  while (offset < payload.length) {
    const [key, afterKey] = readVarint(payload, offset);
    offset = afterKey;
    const wire = key & 7;
    if (wire === 2) {
      const [length, afterLength] = readVarint(payload, offset);
      offset = afterLength;
      if (key >> 3 === field) return payload.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 0) {
      const [, afterValue] = readVarint(payload, offset);
      offset = afterValue;
    } else return undefined;
  }
  return undefined;
};

export interface FakeAttachOwner {
  readonly accepted: () => number;
  /** Attaches refused for another artifact identity (82). */
  readonly refused: () => number;
  readonly close: () => Promise<void>;
}

export async function makeFakeAttachOwner(input: {
  socketPath: string;
  capability: Buffer;
  profileBinding: Buffer;
  targetId: string;
  rejectProof?: boolean;
  echoProfileBinding?: Buffer;
  /** The identity the fake reports in its challenge; `null` models an owner without one. */
  ownerIdentity: Buffer | null;
}): Promise<FakeAttachOwner> {
  const epoch = Buffer.alloc(32, 3);
  const reconciliationId = Buffer.alloc(32, 6);
  let accepted = 0;
  let refused = 0;
  let mismatch = false;
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
          const expected = readBytesField(payload, 2);
          mismatch =
            input.ownerIdentity !== null &&
            expected !== undefined &&
            !expected.equals(input.ownerIdentity);
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
                input.ownerIdentity === null ? Buffer.alloc(0) : bytesField(3, input.ownerIdentity),
              ]),
            ),
          );
          stage = 1;
        } else if (stage === 1 && readBytesField(body, 13) && mismatch) {
          // Another artifact: the typed refusal (82), then the owner retires itself.
          refused += 1;
          socket.write(
            frame(
              2,
              Buffer.concat([
                uintField(1, 1),
                uintField(2, 0),
                bytesField(3, epoch),
                bytesField(6, input.profileBinding),
                uintField(7, 1),
                uintField(13, 82),
              ]),
            ),
          );
          stage = 9;
          setTimeout(() => {
            for (const open of sockets) open.destroy();
            server.close();
          }, 20);
        } else if (stage === 1 && readBytesField(body, 13)) {
          // Production is multi-target but admits only after reconciling the
          // backend's retirement mirror and retained pane bindings.
          socket.write(
            frame(
              18,
              Buffer.concat([
                bytesField(1, reconciliationId),
                bytesField(2, epoch),
                Buffer.alloc(0),
              ]),
            ),
          );
          stage = 2;
        } else if (stage === 2) {
          const snapshot = readBytesField(body, 19);
          if (!snapshot) return;
          const requested = readBytesField(snapshot, 1) ?? Buffer.alloc(0);
          const digest = readBytesField(snapshot, 2) ?? Buffer.alloc(0);
          if (!requested.equals(reconciliationId)) return;
          stage = 3;
          accepted += 1;
          const hello = Buffer.concat([
            uintField(1, 1),
            uintField(2, 0),
            bytesField(3, epoch),
            bytesField(4, Buffer.alloc(0)),
            bytesField(6, input.echoProfileBinding ?? input.profileBinding),
            uintField(7, 1),
            uintField(8, 1),
            bytesField(9, reconciliationId),
            bytesField(10, digest),
            uintField(11, 0),
            uintField(12, 0),
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
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  };
}

export async function withPersistence<A, E>(
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

/** A real (never executed) artifact file, so the attach identity can be measured. */
export async function fixtureWithDescriptor(fixture: ProductionFixture) {
  const facts = resolveSshOwnerLaunchFacts(fixture.profile);
  const artifactPath = join(fixture.root, "owner-artifact");
  await writeFile(artifactPath, "attach-only owner artifact; never spawned\n", { mode: 0o700 });
  const identity = await measureSshOwnerArtifactIdentity(artifactPath);
  await ensurePrivateSshOwnerDirectory(facts.directory);
  const capability = randomBytes(32);
  await writeSshOwnerAttachmentDescriptor(facts.attachFile, {
    version: 1,
    socketPath: facts.socketPath,
    capability,
    profileBinding: facts.profileBindingText,
  });
  return { facts, capability, artifactPath, identity };
}

export const start = (
  fixture: ProductionFixture,
  sql: Sql,
  artifactPath = join(fixture.root, "owner-artifact"),
  ownerExitWaitMs?: number,
) =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact(artifactPath, "desktop-packaged"),
    facts: resolveSshOwnerLaunchFacts(fixture.profile),
    sql,
    ...(ownerExitWaitMs === undefined ? {} : { ownerExitWaitMs }),
  });
