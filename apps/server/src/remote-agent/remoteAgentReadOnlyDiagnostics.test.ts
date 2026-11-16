import { expect, it, vi } from "vitest";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry";
import { remoteAgentBuildId } from "./remoteAgentRuntime";
import { profileOwner, target } from "./remoteAgentOwnedPty.profile.testUtils";
import { remoteAgentReadOnlyDiagnostics } from "./remoteAgentReadOnlyDiagnostics";
import { readRemoteAgentInventoryWithoutStart } from "./remoteAgentReadOnlyInventory";
import type { RemoteAgentConnection } from "./remoteAgentConnection";

const owner = profileOwner();
const buildId = remoteAgentBuildId(owner.runtime);
function registry() {
  return {
    ...emptyRemoteAgentRegistry(),
    promotionSequence: 1,
    current: buildId,
    builds: [
      {
        id: buildId,
        runtime: owner.runtime,
        health: "healthy",
        promotion: 1,
        binary: "present",
        authenticated: true,
      },
    ],
    launches: [{ id: "launch", buildId, phase: "ready", epoch: owner.epoch }],
    pins: [{ owner: "retained", buildId }],
  };
}
const run = (value: unknown) =>
  vi.fn(async () => ({ stdout: JSON.stringify(value), stderr: "", code: 0 }));

it("reports unavailable observations as unknown without changing registry or launching", async () => {
  const state = registry();
  const before = JSON.stringify(state);
  const inventory = vi.fn(async () => {
    throw new Error("offline");
  });
  const result = await remoteAgentReadOnlyDiagnostics(target, run(state), 15_000, inventory);
  expect(result.terminals.running).toBeNull();
  expect(result.terminals.runtimes[0]).toMatchObject({ status: "unknown", pinnedOwners: 1 });
  expect(JSON.stringify(state)).toBe(before);
  expect(inventory).toHaveBeenCalledOnce();
});

it("does not contact a runtime without recorded epoch evidence", async () => {
  const inventory = vi.fn(async () => []);
  const result = await remoteAgentReadOnlyDiagnostics(
    target,
    run({ ...registry(), launches: [] }),
    15_000,
    inventory,
  );
  expect(inventory).not.toHaveBeenCalled();
  expect(result.terminals.running).toBeNull();
});

it("reports live PTYs separately from unknown entries and retained owner pins", async () => {
  const entry = {
    ptyId: "a",
    requestDigest: new Uint8Array(),
    state: "running",
    pid: 4,
    nextSequence: 1,
    firstRetainedSequence: 1,
    verifiedExit: false,
    launchStatus: "unconfirmed",
  };
  const result = await remoteAgentReadOnlyDiagnostics(target, run(registry()), 15_000, async () => [
    entry,
    { ...entry, ptyId: "b", state: "outcome-unknown", pid: 0 },
    { ...entry, ptyId: "c", state: "exited", verifiedExit: true },
  ]);
  expect(result.terminals).toMatchObject({ status: "observed", running: 1, unknown: 1 });
  expect(result.terminals.runtimes[0]).toMatchObject({ stopped: 1, pinnedOwners: 1 });
});

it("closes its own late-created proxy after cancellation and sends no handshake/list", async () => {
  let resolve!: (connection: RemoteAgentConnection) => void;
  const create = vi.fn(
    (_input: Parameters<typeof RemoteAgentConnection.ssh>[0]) =>
      new Promise<RemoteAgentConnection>((done) => {
        resolve = done;
      }),
  );
  const controller = new AbortController();
  const pending = readRemoteAgentInventoryWithoutStart(
    target,
    { runtime: owner.runtime, expectedEpoch: owner.epoch },
    controller.signal,
    create,
  );
  const rejection = expect(pending).rejects.toThrow();
  controller.abort();
  await rejection;
  const close = vi.fn();
  const handshake = vi.fn();
  resolve({ close, handshake } as unknown as RemoteAgentConnection);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(handshake).not.toHaveBeenCalled();
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    runtime: owner.runtime,
    binaryPath: owner.runtime.binaryPath,
  });
});

it("closes only its owned proxy when an in-flight handshake is cancelled", async () => {
  const close = vi.fn();
  const handshake = vi.fn(() => new Promise<never>(() => {}));
  const connection = { close, handshake } as unknown as RemoteAgentConnection;
  const controller = new AbortController();
  const pending = readRemoteAgentInventoryWithoutStart(
    target,
    { runtime: owner.runtime, expectedEpoch: owner.epoch },
    controller.signal,
    async () => connection,
  );
  const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(handshake).toHaveBeenCalledOnce());
  controller.abort();
  await rejection;
  expect(close).toHaveBeenCalledOnce();
});
