import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { PtySpawnError, type PtySpawnInput } from "../terminal/Services/PTY.ts";
import { makeSshOwnerDevTerminal } from "./sshOwnerDevTerminal.ts";

const targetId = "ssh:host=fixture.invalid&transport=direct-ssh";
const workspaceRoot = "/tmp/fixture root";
const ownerKey = JSON.stringify(["thread", "pane"]);
const routeKey = `terminal:${ownerKey}`;
const spawnInput: PtySpawnInput = {
  ownerKey,
  executionTargetId: targetId,
  remoteCwd: workspaceRoot,
  cwd: "/fallback/home",
  shell: "/fallback/ssh",
  args: ["legacy transport arguments"],
  env: { PRIVATE: "not a native launch operand" },
  cols: 100,
  rows: 30,
};
const runtime: RemoteAgentRuntime = {
  generation: "dev-ssh-owner",
  version: "0.1.0",
  sha256: "a".repeat(64),
  buildDigest: "fixture",
  targetTriple: "aarch64-unknown-linux-musl",
  origin: "legacy-external",
  binaryPath: "/fixture/owner",
  statePath: "/fixture/state",
  socketPath: "/fixture/state/supervisor.sock",
  logPath: "/fixture/state/supervisor.log",
};
const lease = Buffer.alloc(32, 1);
const ownerEpoch = Buffer.alloc(32, 2);
const targetGeneration = Buffer.alloc(32, 3);
const live = { lease, pid: 42, live: true, sample: Buffer.from("not replay") };
const exited = { ...live, live: false };
const cut = (cursor: number, data?: string) => ({
  lease,
  nextSequence: cursor + (data ? 2 : 1),
  firstRetainedSequence: 1,
  gap: false,
  chunks: data ? [{ sequence: cursor + 1, data: Buffer.from(data) }] : [],
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function fixture() {
  const database = ManagedRuntime.make(NodeSqlite.layerMemory());
  cleanup.push(() => database.dispose());
  await database.runPromise(OwnersMigration.pipe(Effect.andThen(ReplayMigration)));
  const store = await database.runPromise(makeRemoteAgentRuntimeBindings);
  const owner = {
    ownerEpoch,
    probeProofTerminalCwd: vi.fn(async () => workspaceRoot),
    prepareProofTerminal: vi.fn(async () => ({ lease, ownerEpoch, targetGeneration })),
    cancelProofTerminalReservation: vi.fn(async () => {}),
    openReservedProofTerminal: vi.fn(async () => {
      expect(await store.get(routeKey)).toMatchObject({
        state: "may-have-been-sent",
        target: targetId,
        terminalCwd: workspaceRoot,
        resourceId: lease.toString("hex"),
      });
      return live;
    }),
    proofTerminalStatus: vi.fn(async () => live),
    closeProofTerminal: vi.fn(async () => exited),
    writeProofTerminalInput: vi.fn(async () => live),
    resizeProofTerminal: vi.fn(async () => live),
    replayProofTerminal: vi.fn(async (_lease: Uint8Array, cursor: number) => cut(cursor)),
  };
  const calls = vi.fn<(id: string) => void>();
  let active = false;
  const terminal = makeSshOwnerDevTerminal({
    targetId,
    workspaceRoot,
    owners: () => store,
    runtime,
    withOwner: async (id, use) => {
      calls(id);
      expect(id).toBe(targetId);
      expect(active).toBe(false);
      active = true;
      try {
        return await use(owner);
      } finally {
        active = false;
      }
    },
  });
  const original = {
    spawn: vi.fn(() =>
      Effect.fail(new PtySpawnError({ adapter: "original", message: "original" })),
    ),
    ownedRuntimeForTarget: vi.fn(() => undefined),
  };
  const adapter = terminal.wrapPtyAdapter(original);
  return { ...terminal, adapter, owner, calls, original, store };
}

it("falls back only for non-SSH and enforces exact fixture cwd before any owner traffic", async () => {
  const { adapter, original, calls, cwdOwner, owner } = await fixture();
  for (const id of ["local", "wsl:fixture"]) {
    const input = { ...spawnInput, executionTargetId: id };
    await expect(Effect.runPromise(adapter.spawn(input))).rejects.toThrow("original");
    expect(original.spawn).toHaveBeenLastCalledWith(input);
    expect(adapter.ownedRuntimeForTarget?.(id)).toBeUndefined();
    expect(original.ownedRuntimeForTarget).toHaveBeenLastCalledWith(id);
  }
  original.spawn.mockClear();
  original.ownedRuntimeForTarget.mockClear();
  for (const input of [
    { ...spawnInput, executionTargetId: "ssh:" },
    { ...spawnInput, executionTargetId: "ssh:host=fixture.invalid&transport=agent" },
    { ...spawnInput, remoteCwd: `${workspaceRoot}/.` },
    { ...spawnInput, remoteCwd: `${workspaceRoot}/subdir` },
  ]) {
    await expect(Effect.runPromise(adapter.spawn(input))).rejects.toThrow(
      "exact development fixture",
    );
  }
  expect(adapter.ownedRuntimeForTarget?.("ssh:other")).toBeUndefined();
  expect(adapter.ownedRuntimeForTarget?.(targetId)?.localSshClient).toBeDefined();
  expect(original.ownedRuntimeForTarget).not.toHaveBeenCalled();
  expect(original.spawn).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  const cwd = { executionTargetId: targetId, cwd: workspaceRoot, home: false };
  await expect(cwdOwner.probeCwd({ ...cwd, home: true }, signal)).rejects.toThrow(
    "exact development fixture",
  );
  await expect(cwdOwner.probeCwd(cwd, AbortSignal.abort())).rejects.toThrow();
  expect(calls).not.toHaveBeenCalled();
  await expect(cwdOwner.probeCwd(cwd, signal)).resolves.toEqual({
    kind: "resolved",
    cwd: workspaceRoot,
  });
  owner.probeProofTerminalCwd.mockResolvedValueOnce("/different-resolved-root");
  await expect(cwdOwner.probeCwd(cwd, signal)).rejects.toThrow("exact development fixture");
});

it("orders interactive input, splits large paste, and drains final output before durable exit", async () => {
  const { adapter, owner, store, original } = await fixture();
  owner.replayProofTerminal.mockResolvedValueOnce(cut(0, "$ "));
  const process = await Effect.runPromise(adapter.spawn(spawnInput));
  cleanup.push(() => process.detach?.());
  expect(process.remoteResourceId).toBe(lease.toString("hex"));
  expect(owner.prepareProofTerminal).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread",
    terminalId: "pane",
    cwd: workspaceRoot,
    cols: 100,
    rows: 30,
  });
  const order: string[] = [];
  process.onData((data) => order.push(data));
  process.onExit(({ exitCode }) => order.push(Number.isNaN(exitCode) ? "exited" : "numeric exit"));
  const failure = vi.fn();
  process.onError?.(failure);
  const first = Promise.withResolvers<typeof live>();
  owner.writeProofTerminalInput.mockImplementationOnce(() => first.promise);
  process.write("x".repeat(4097));
  process.resize(120, 40);
  process.write("exit\r");
  await vi.waitFor(() => expect(owner.writeProofTerminalInput).toHaveBeenCalledOnce());
  expect(owner.resizeProofTerminal).not.toHaveBeenCalled();
  first.resolve(live);
  await vi.waitFor(() => expect(owner.writeProofTerminalInput).toHaveBeenCalledTimes(3));
  expect(owner.writeProofTerminalInput.mock.calls).toEqual([
    [lease, 1, Buffer.alloc(4096, "x")],
    [lease, 2, Buffer.from("x")],
    [lease, 3, Buffer.from("exit\r")],
  ]);
  expect(owner.resizeProofTerminal).toHaveBeenCalledExactlyOnceWith(lease, 120, 40);
  expect(owner.resizeProofTerminal.mock.invocationCallOrder[0]).toBeLessThan(
    owner.writeProofTerminalInput.mock.invocationCallOrder[2]!,
  );
  owner.proofTerminalStatus.mockImplementation(async () => {
    owner.replayProofTerminal.mockResolvedValueOnce(cut(1, "bye\r\n"));
    return exited;
  });
  await vi.waitFor(() => expect(order).toEqual(["$ ", "bye\r\n", "exited"]));
  expect(await store.get(routeKey)).toMatchObject({ state: "terminal" });
  expect(failure).not.toHaveBeenCalled();
  expect(original.spawn).not.toHaveBeenCalled();
});

it("does not open on absent recovery or repeat a dispatch after a lost open receipt", async () => {
  const { adapter, owner, store, original } = await fixture();
  const spawn = (input: PtySpawnInput) => Effect.runPromise(adapter.spawn(input));
  await expect(spawn({ ...spawnInput, recoverOnly: true })).rejects.toThrow(
    "no retained native SSH binding",
  );
  expect(owner.prepareProofTerminal).not.toHaveBeenCalled();
  owner.openReservedProofTerminal.mockRejectedValueOnce(new Error("lost receipt"));
  await expect(spawn(spawnInput)).rejects.toThrow("could not be confirmed");
  await expect(spawn(spawnInput)).rejects.toThrow("could not be confirmed");
  await expect(
    spawn({ ...spawnInput, ownerKey: JSON.stringify(["thread", "different-pane"]) }),
  ).rejects.toThrow("could not be confirmed");
  expect(await store.get(routeKey)).toMatchObject({ state: "may-have-been-sent" });
  expect(owner.openReservedProofTerminal).toHaveBeenCalledOnce();
  expect(owner.prepareProofTerminal).toHaveBeenCalledOnce();
  expect(original.spawn).not.toHaveBeenCalled();
});

it("reports a missing live receipt as I/O failure, not exit or permission to replace", async () => {
  const { adapter, owner, store, original } = await fixture();
  const process = await Effect.runPromise(adapter.spawn(spawnInput));
  cleanup.push(() => process.detach?.());
  owner.proofTerminalStatus.mockRejectedValue(new Error("lease lost"));
  const failure = vi.fn();
  const exit = vi.fn();
  process.onError?.(failure);
  process.onExit(exit);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledExactlyOnceWith(new Error("lease lost")));
  expect(exit).not.toHaveBeenCalled();
  expect(await store.get(routeKey)).toMatchObject({ state: "may-have-been-sent" });
  await expect(Effect.runPromise(adapter.spawn(spawnInput))).rejects.toThrow(
    "could not be confirmed",
  );
  expect(owner.openReservedProofTerminal).toHaveBeenCalledOnce();
  expect(original.spawn).not.toHaveBeenCalled();
});
