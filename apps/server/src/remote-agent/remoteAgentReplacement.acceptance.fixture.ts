import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import * as BunSqlite from "@effect/sql-sqlite-bun/SqliteClient";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import { makeOwnedRemoteAgentProcess } from "./remoteAgentOwnedProcess.ts";
import { configureRemoteAgentOwners, type RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

const target = "ssh:host=replacement.invalid&auth=ssh-key&transport=agent";
const workspace = "/proof/workspace";
const statePath = "/proof/state";
const ownerKey = "proof:original-mutation";
const writeMarker = "printf 'original\n' >> witness; printf 'dispatched\n'; sleep 30";
const requestDigest = createHash("sha256").update(writeMarker).digest();
const capabilities = ["workspace.files", "process.run", "process.attach"];

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing disposable fixture setting ${key}`);
  return value;
}

const stage = requireEnv("BB_REPLACEMENT_STAGE");
assert(stage === "original" || stage === "replacement");
const container = requireEnv("BB_REPLACEMENT_CONTAINER");
const evidence: RemoteAgentFrame["type"][] = [];
const connections = new Set<RemoteAgentConnection>();

// This fixed fixture seam carries the real Linux supervisor's protobuf over its own Unix
// socket. Docker exec replaces only SSH launch. There is no network or remote script input.
function openProxy() {
  const connection = RemoteAgentConnection.local({
    binaryPath: requireEnv("BB_REPLACEMENT_DOCKER"),
    args: [
      "--config",
      requireEnv("BB_REPLACEMENT_DOCKER_CONFIG"),
      "--host",
      requireEnv("BB_REPLACEMENT_DOCKER_HOST"),
      "exec",
      "-i",
      "--env",
      `BIGBUD_AGENT_STATE_DIR=${statePath}`,
      container,
      "/agent",
      "--proxy",
    ],
    env: { PATH: "/usr/bin:/bin" },
  });
  connections.add(connection);
  const send = connection.send.bind(connection);
  connection.send = async (frame) => {
    evidence.push(frame.type);
    await send(frame);
  };
  return connection;
}

async function observeIdentity() {
  const connection = openProxy();
  try {
    const hello = await connection.handshake();
    assert.equal(hello.os, "linux");
    assert.equal(hello.architecture, "aarch64");
    assert.equal(hello.protocolMajor, 1);
    assert.equal(hello.protocolMinor, 9);
    assert(hello.agentInstanceId && hello.agentEpoch);
    return hello;
  } finally {
    await connection.closeConfirmed(1_000);
  }
}

async function runOriginal(store: RemoteAgentOwnerStore, pool: RemoteAgentConnectionPool) {
  const hello = await observeIdentity();
  const descriptor: RemoteAgentRuntime = {
    generation: "proof",
    version: hello.agentVersion,
    buildDigest: hello.buildDigest,
    sha256: requireEnv("BB_REPLACEMENT_AGENT_SHA"),
    targetTriple: "aarch64-unknown-linux-gnu",
    origin: "legacy-external",
    binaryPath: "/agent",
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
  };
  const binding = { runtime: descriptor, expectedEpoch: hello.agentEpoch };
  const connectionId = randomUUID();
  await store.bindConnection(target, connectionId, binding);
  const connection = await pool.getBound(target, binding, capabilities);
  // The parent cannot replace the supervisor until this backend has ended. One verified epoch
  // protects both the discovery hello and the connection used for the dispatched mutation.
  const workspaceHandle = randomUUID();
  await new RemoteAgentWorkspaceClient(connection).openWorkspace(workspaceHandle, workspace);
  const resourceId = randomUUID();
  await store.reserve({
    ownerKey,
    target,
    connectionId,
    runtime: descriptor,
    epoch: hello.agentEpoch,
    resourceId,
    invocationId: resourceId,
    reservationId: randomUUID(),
    digest: requestDigest.toString("hex"),
    state: "prepared",
    outputSequence: 0,
    nextInputSequence: 1,
    inputAcknowledged: 0,
  });
  await store.update(ownerKey, (owner) => ({ ...owner, state: "may-have-been-sent" }));
  const requestId = randomUUID();
  const accepted = await connection.request(
    {
      type: "processRequest",
      value: {
        requestId,
        operationId: resourceId,
        requestDigest,
        workspaceHandle,
        command: "/bin/sh",
        args: ["-c", writeMarker],
        timeoutMs: 35_000,
        maxOutputBytes: 1024,
      },
    },
    (frame) => frame.type === "processAccepted" && frame.value.requestId === requestId,
  );
  assert(
    accepted.type === "processAccepted" && accepted.value.accepted && !accepted.value.duplicate,
    JSON.stringify(accepted),
  );
  const output = await connection.nextFrame(
    (frame) => frame.type === "processOutput" && frame.value.operationId === resourceId,
  );
  assert(output.type === "processOutput" && output.value.sequence > 0);
  assert.equal(Buffer.from(output.value.bytes).toString(), "dispatched\n");
  await store.update(ownerKey, (owner) => ({
    ...owner,
    outputSequence: output.value.sequence,
  }));
  return {
    resourceId,
    cursor: output.value.sequence,
    epoch: hello.agentEpoch,
    instance: hello.agentInstanceId,
  };
}

async function runReplacement(store: RemoteAgentOwnerStore, pool: RemoteAgentConnectionPool) {
  const owner = await store.get(ownerKey);
  const retained = await store.getBinding(target);
  assert(owner && retained);
  assert.equal(owner.state, "may-have-been-sent");
  assert.equal(owner.epoch, retained.expectedEpoch);
  assert(owner.outputSequence > 0);
  const hello = await observeIdentity();
  assert.notEqual(hello.agentEpoch, owner.epoch);
  const replayOffset = evidence.length;
  await assert.rejects(
    makeOwnedRemoteAgentProcess(pool)({
      ownerKey,
      target,
      cwd: workspace,
      invocationId: owner.resourceId,
      request: {
        workspaceHandle: randomUUID(),
        operationId: owner.resourceId,
        requestDigest,
        command: "/bin/sh",
        args: ["-c", writeMarker],
      },
    }),
    /Remote agent epoch changed\. Retained operation continuity is unknown/,
  );
  assert.deepEqual(evidence.slice(replayOffset), ["clientHello"]);
  assert.equal(pool.liveConnection(target), null);
  assert.deepEqual(await store.get(ownerKey), owner);
  assert.deepEqual(await store.getBinding(target), retained);

  // A separate, explicitly admitted epoch may run a new operation against the same endpoint.
  const replacement = { runtime: retained.runtime, expectedEpoch: hello.agentEpoch };
  const connection = await pool.admitReplacement(target, replacement, retained);
  await store.bindConnection(target, randomUUID(), replacement);
  const workspaceHandle = randomUUID();
  await new RemoteAgentWorkspaceClient(connection).openWorkspace(workspaceHandle, workspace);
  const fresh = await new RemoteAgentProcessClient(connection).run({
    operationId: randomUUID(),
    requestDigest: createHash("sha256").update("fresh marker").digest(),
    workspaceHandle,
    command: "/bin/sh",
    args: ["-c", "printf 'fresh\n' >> witness; cat witness"],
    timeoutMs: 5_000,
  });
  assert.equal(fresh.completed.exitCode, 0);
  const stdout = Buffer.from(fresh.stdout).toString();
  assert.equal(stdout, "original\nfresh\n");
  assert.equal(evidence.filter((type) => type === "processRequest").length, 1);
  assert(!evidence.includes("processAttachRequest"));
  assert.deepEqual(await store.get(ownerKey), owner);
  return {
    resourceId: owner.resourceId,
    cursor: owner.outputSequence,
    epoch: hello.agentEpoch,
    instance: hello.agentInstanceId,
    stdout,
  };
}

const database = ManagedRuntime.make(
  BunSqlite.layer({ filename: requireEnv("BB_REPLACEMENT_DB") }),
);
const pool = new RemoteAgentConnectionPool({ create: async () => openProxy() });
try {
  if (stage === "original")
    await database.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
  const store = await database.runPromise(makeRemoteAgentRuntimeBindings);
  configureRemoteAgentOwners(store);
  const result = await (stage === "original"
    ? runOriginal(store, pool)
    : runReplacement(store, pool));
  console.log(JSON.stringify({ ...result, backendPid: process.pid }));
} finally {
  pool.close(target);
  await Promise.all([...connections].map((connection) => connection.closeConfirmed(1_000)));
  await database.dispose();
}
