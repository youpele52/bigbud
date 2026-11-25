import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import type { PtyExitEvent, PtySpawnInput } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostDirectSsh } from "./localTerminalHost.directSsh.ts";
import type {
  NativeDirectSshTerminalBinding,
  NativeDirectSshTerminalOpen,
  NativeDirectSshTerminalOwner,
} from "./localTerminalHost.directSsh.owner.port.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

const targetId = "ssh:host=fixture.invalid&transport=direct-ssh";
const ownerKey = JSON.stringify(["thread", "pane"]);
const routeKey = `terminal:${ownerKey}`;
const spawnInput: PtySpawnInput = {
  ownerKey,
  executionTargetId: targetId,
  remoteCwd: "/srv/a b",
  cwd: "/local/home",
  cols: 90,
  rows: 32,
  shell: "/legacy/ssh",
  args: ["-tt", "fixture.invalid"],
  env: { PRIVATE: "do not send" },
};
const binding: NativeDirectSshTerminalBinding = {
  targetId,
  ownerEpoch: "native-epoch",
  targetGeneration: "native-generation",
  leaseId: "native-lease",
};
const ownerRuntime: RemoteAgentRuntime = {
  generation: "native-runtime",
  version: "0.1.0",
  sha256: "a".repeat(64),
  buildDigest: "fixture",
  // The shared route schema models a local binary by architecture, like the legacy local host.
  targetTriple: "aarch64-unknown-linux-musl",
  origin: "legacy-external",
  binaryPath: "/test/bigbud-ssh-owner",
  statePath: "/test/owner-state",
  socketPath: "/test/owner-state/supervisor.sock",
  logPath: "/test/owner-state/supervisor.log",
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-direct-owner-"));
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  const openStore = async () => {
    const runtime = ManagedRuntime.make(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
    );
    cleanup.push(() => runtime.dispose());
    return runtime;
  };
  const database = await openStore();
  await database.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
  let store = await database.runPromise(makeRemoteAgentRuntimeBindings);
  const reopen = async () => {
    await database.dispose();
    const runtime = await openStore();
    store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
  };
  const detach = vi.fn();
  const kill = vi.fn();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  const process = {
    pid: 42,
    detach,
    kill,
    write: vi.fn(),
    resize: vi.fn(),
    onExit: (callback: (event: PtyExitEvent) => void) => {
      exitListeners.add(callback);
      return () => {
        exitListeners.delete(callback);
      };
    },
    onData: () => () => {},
  };
  const exit = () => {
    for (const callback of exitListeners) callback({ exitCode: 255, signal: null });
  };
  const port = {
    prepareOpen: vi.fn<NativeDirectSshTerminalOwner["prepareOpen"]>(async () => binding),
    open: vi.fn<NativeDirectSshTerminalOwner["open"]>(async (_input, lease) => ({
      binding: lease,
      process,
    })),
    reattach: vi.fn<NativeDirectSshTerminalOwner["reattach"]>(async (lease) => ({
      binding: lease,
      process,
    })),
    status: vi.fn<NativeDirectSshTerminalOwner["status"]>(async (lease) => ({
      binding: lease,
      state: "live",
    })),
    close: vi.fn<NativeDirectSshTerminalOwner["close"]>(async (lease) => ({
      binding: lease,
      state: "exited",
    })),
  } satisfies NativeDirectSshTerminalOwner;
  const fallback = vi.fn(() => Effect.die("unexpected legacy fallback"));
  const admitLegacy = vi.fn(() => Promise.reject(new Error("unexpected legacy admission")));
  const pool = new RemoteAgentConnectionPool({
    create: async () => {
      throw new Error("unexpected legacy connection");
    },
  });
  const control = vi.fn(() => Promise.reject(new Error("unexpected legacy control")));
  const buildAdapter = () =>
    makeLocalTerminalHostDirectSsh({
      controller: { resolveAdmittedBinding: admitLegacy } as unknown as LocalTerminalHostController,
      pool,
      runtime: {
        targetId: LOCAL_TERMINAL_HOST_TARGET_ID,
        owners: () => store,
        pool,
        control,
        pidNamespace: "backend-host",
      },
      fallback: { spawn: fallback },
      isClosed: () => false,
      nativeOwner: { port, owners: () => store, runtime: ownerRuntime },
    });
  return {
    buildAdapter,
    port,
    detach,
    kill,
    exit,
    reopen,
    fallback,
    admitLegacy,
    control,
    route: () => store.get(routeKey),
  };
}

const approvedRequest: NativeDirectSshTerminalOpen = {
  pane: { threadId: "thread", terminalId: "pane" },
  targetId,
  cwd: "/srv/a b",
  cols: 90,
  rows: 32,
};

describe("native direct SSH terminal application boundary", () => {
  it("replaces only a confirmed terminal route for an explicit restart", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    const first = await Effect.runPromise(adapter.spawn(spawnInput));
    expect(
      (
        await Effect.runPromise(
          Effect.result(adapter.spawn({ ...spawnInput, replaceTerminalOwner: true })),
        )
      )._tag,
    ).toBe("Failure");
    expect(f.port.open).toHaveBeenCalledTimes(1);
    await first.prepareRestart!();
    expect((await f.route())?.state).toBe("terminal");
    expect((await Effect.runPromise(Effect.result(adapter.spawn(spawnInput))))._tag).toBe(
      "Failure",
    );
    const replacement = { ...binding, leaseId: "replacement-lease" };
    f.port.prepareOpen.mockResolvedValueOnce(replacement);
    await Effect.runPromise(adapter.spawn({ ...spawnInput, replaceTerminalOwner: true }));
    expect((await f.route())?.resourceId).toBe(replacement.leaseId);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    expect(f.port.reattach).not.toHaveBeenCalled();
  });
  it("reserves the exact typed binding before dispatch and only reattaches it after a backend restart", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    expect(adapter.runtimeForTarget("local")).toBeUndefined();
    expect(adapter.runtimeForTarget("ssh:host=fixture.invalid&transport=agent")).toBeUndefined();
    const dispatch = f.port.open.getMockImplementation()!;
    f.port.open.mockImplementationOnce(async (...args) => {
      expect(await f.route()).toMatchObject({
        target: targetId,
        terminalCwd: approvedRequest.cwd,
        state: "may-have-been-sent",
        epoch: binding.ownerEpoch,
        connectionId: `ssh-owner:${binding.targetGeneration}`,
        resourceId: binding.leaseId,
      });
      return dispatch(...args);
    });
    const first = await Effect.runPromise(adapter.spawn(spawnInput));
    expect(first).toMatchObject({
      pid: 42,
      pidDomain: "remote",
      remoteResourceId: binding.leaseId,
      recovered: false,
    });
    expect(f.port.prepareOpen).toHaveBeenCalledExactlyOnceWith(
      approvedRequest,
      expect.any(AbortSignal),
    );
    expect(f.port.open).toHaveBeenCalledExactlyOnceWith(
      approvedRequest,
      binding,
      expect.any(AbortSignal),
    );
    first.detach?.();
    await f.reopen();
    const recovered = await Effect.runPromise(
      f.buildAdapter().spawn({
        ...spawnInput,
        recoverOnly: true,
        expectedRemoteResourceId: binding.leaseId,
        remoteCwd: "/changed",
      }),
    );
    expect(recovered).toMatchObject({
      pid: first.pid,
      remoteResourceId: first.remoteResourceId,
      recovered: true,
    });
    expect(f.port.reattach).toHaveBeenCalledExactlyOnceWith(binding, expect.any(AbortSignal));
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.admitLegacy).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("never prepares or opens on missing recovery, wrong lease, wrong target or a rejected policy", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    const run = (input: PtySpawnInput) => Effect.runPromise(Effect.result(adapter.spawn(input)));
    const { ownerKey: _ownerKey, ...ownerless } = spawnInput;
    for (const input of [
      ownerless,
      { ...spawnInput, recoverOnly: true },
      { ...spawnInput, expectedRemoteResourceId: binding.leaseId },
      { ...spawnInput, remoteCwd: "relative" },
      { ...spawnInput, cols: 1001 },
      { ...spawnInput, hostLifecycle: { evictPtyId: "other-pane" } },
    ])
      expect((await run(input))._tag).toBe("Failure");
    expect(f.port.prepareOpen).not.toHaveBeenCalled();
    await Effect.runPromise(adapter.spawn(spawnInput));
    expect(
      (await run({ ...spawnInput, recoverOnly: true, expectedRemoteResourceId: "stale" }))._tag,
    ).toBe("Failure");
    expect(
      (
        await run({
          ...spawnInput,
          executionTargetId: "ssh:host=other.invalid&transport=direct-ssh",
        })
      )._tag,
    ).toBe("Failure");
    expect(f.port.prepareOpen).toHaveBeenCalledTimes(1);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.port.reattach).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("allows only the durable reservation winner to dispatch competing opens", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    const ready = Promise.withResolvers<void>();
    let prepares = 0;
    f.port.prepareOpen.mockImplementation(async () => {
      const leaseId = `lease-${++prepares}`;
      if (prepares === 2) ready.resolve();
      await ready.promise;
      return { ...binding, leaseId };
    });
    const results = await Promise.all([
      Effect.runPromise(Effect.result(adapter.spawn(spawnInput))),
      Effect.runPromise(Effect.result(adapter.spawn(spawnInput))),
    ]);
    expect(results.map((result) => result._tag).toSorted()).toEqual(["Failure", "Success"]);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.port.open.mock.calls[0]?.[1].leaseId).toBe((await f.route())?.resourceId);
    expect(f.port.reattach).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("detaches a late cancelled recovery observer without acting on its lease", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    await Effect.runPromise(adapter.spawn(spawnInput));
    const route = await f.route();
    const cancel = new AbortController();
    const attach = f.port.reattach.getMockImplementation()!;
    f.port.reattach.mockImplementationOnce(async (...args) => {
      cancel.abort();
      return attach(...args);
    });
    const result = await Effect.runPromise(
      Effect.result(
        adapter.spawn({
          ...spawnInput,
          recoverOnly: true,
          recoverySignal: cancel.signal,
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.port.close).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(await f.route()).toEqual(route);
  });

  it("rejects an attachment from a different generation and detaches only its observer", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    await Effect.runPromise(adapter.spawn(spawnInput));
    const route = await f.route();
    const attach = f.port.reattach.getMockImplementation()!;
    f.port.reattach.mockImplementationOnce((lease, signal) =>
      attach({ ...lease, targetGeneration: "different-generation" }, signal),
    );
    expect(
      (await Effect.runPromise(Effect.result(adapter.spawn({ ...spawnInput, recoverOnly: true }))))
        ._tag,
    ).toBe("Failure");
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.port.close).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(await f.route()).toEqual(route);
  });

  it("rejects unconfirmed close and stale receipts; confirmed close never resurrects a pane", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    const process = await Effect.runPromise(adapter.spawn(spawnInput));
    const route = (await f.route())!;
    const lifecycle = adapter.runtimeForTarget(targetId)!.localSshClient!;
    f.port.close.mockRejectedValueOnce(new Error("transport closed"));
    await expect(process.prepareRestart?.()).rejects.toThrow("stays reserved");
    f.port.close.mockResolvedValueOnce({
      binding: { ...binding, ownerEpoch: "other-epoch" },
      state: "exited",
    });
    await expect(lifecycle.close(route)).rejects.toThrow("stays reserved");
    expect(await f.route()).toEqual(route);
    expect(f.kill).not.toHaveBeenCalled();
    await lifecycle.close(route);
    expect(f.port.close).toHaveBeenLastCalledWith(binding, expect.any(AbortSignal));
    expect(await f.route()).toMatchObject({ resourceId: binding.leaseId, state: "terminal" });
    await f.reopen();
    const restarted = f.buildAdapter();
    for (const recoverOnly of [true, false])
      expect(
        (await Effect.runPromise(Effect.result(restarted.spawn({ ...spawnInput, recoverOnly }))))
          ._tag,
      ).toBe("Failure");
    expect(f.port.reattach).not.toHaveBeenCalled();
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous launch reserved and never uses inferred exit or creates a replacement", async () => {
    const f = await setup();
    const adapter = f.buildAdapter();
    f.port.open.mockRejectedValueOnce(new Error("reply lost after dispatch"));
    expect((await Effect.runPromise(Effect.result(adapter.spawn(spawnInput))))._tag).toBe(
      "Failure",
    );
    const route = await f.route();
    expect(route?.resourceId).toBe(binding.leaseId);
    const next = f.buildAdapter();
    f.port.reattach.mockRejectedValueOnce(new Error("owner restarted"));
    expect((await Effect.runPromise(Effect.result(next.spawn(spawnInput))))._tag).toBe("Failure");
    expect(await f.route()).toEqual(route);
    const observed = await Effect.runPromise(next.spawn({ ...spawnInput, recoverOnly: true }));
    f.port.status.mockRejectedValueOnce(new Error("owner unavailable"));
    const delivered = new Promise<void>((resolve) => observed.onExit(() => resolve()));
    f.exit();
    await delivered;
    expect(observed.interruptionReason).toBe("ssh-owner-termination-unconfirmed");
    expect(await f.route()).toEqual(route);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });
});
