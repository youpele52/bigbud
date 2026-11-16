import { afterEach, expect, it, vi } from "vitest";
import { RemoteAgentOwnedInput, remoteAgentInputIdentity } from "./remoteAgentOwnedPty.input.ts";
import {
  parseRemoteAgentOwner,
  type RemoteAgentOwner,
  type RemoteAgentOwnerStore,
} from "./remoteAgentOwners.ts";
import { profileOwner } from "./remoteAgentOwnedPty.profile.testUtils.ts";

const coldFixture = vi.hoisted(() => ({ control: vi.fn() }));
vi.mock("./remoteAgentControl.ts", () => ({ openRemoteAgentControl: coldFixture.control }));
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import { spawnInput } from "./remoteAgentOwnedPty.profile.testUtils.ts";
afterEach(() => vi.restoreAllMocks());

const controller = { id: "controller-A", pid: 101, startedAt: "start-A" };
const bytes = new TextEncoder().encode("input");

function fixture() {
  let state: RemoteAgentOwner = {
    ...profileOwner(),
    controllerId: controller.id,
    controllerPid: controller.pid,
    controllerStartedAt: controller.startedAt,
  };
  let loseResponse = false;
  let nonce = 0;
  const store = {
    get: async () => state,
    update: async (_key: string, transition: (current: RemoteAgentOwner) => RemoteAgentOwner) => {
      state = parseRemoteAgentOwner(JSON.stringify(transition(state)));
      if (loseResponse) {
        loseResponse = false;
        throw new Error("committed response lost");
      }
      return state;
    },
  } as unknown as RemoteAgentOwnerStore;
  const environment = {
    controller,
    alive: vi.fn(async () => false),
    nonce: () => `observer-${++nonce}`,
  };
  return {
    store,
    environment,
    state: () => state,
    replace: (next: RemoteAgentOwner) => {
      state = next;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    claim: () => RemoteAgentOwnedInput.claim(store, state, environment),
  };
}

it("persists one exact identity before send and keeps zero delivery separate from written", async () => {
  const f = fixture();
  const input = await f.claim();
  await input.allocated(1, bytes);
  expect(f.state().pendingInput).toEqual(remoteAgentInputIdentity(1, bytes));
  await expect(input.allocated(2, bytes)).rejects.toThrow("unresolved");
  await input.settle({ ...f.state().pendingInput!, outcome: "not-admitted", writerUsable: true });
  expect(f.state()).toMatchObject({ nextInputSequence: 2, inputResolved: 1, inputAcknowledged: 0 });
  expect(f.state().pendingInput).toBeUndefined();
  await input.allocated(2, bytes);
  await input.acknowledged(2);
  expect(f.state()).toMatchObject({ nextInputSequence: 3, inputResolved: 2, inputAcknowledged: 2 });
  expect(f.state().inputAcknowledged).toBe(2);
});

it("fences a replaced observer at both allocation and settlement without losing its pending identity", async () => {
  const f = fixture();
  const a = await f.claim();
  await a.allocated(1, bytes);
  const pending = f.state().pendingInput!;
  const b = await f.claim();
  expect(b.snapshot().pendingInput).toEqual(pending);
  await expect(a.acknowledged(1)).rejects.toThrow("authority is stale");
  await expect(a.allocated(2, bytes)).rejects.toThrow("authority is stale");
  await b.settle({ ...pending, outcome: "written", writerUsable: true });
  await b.allocated(2, bytes);
  await expect(a.acknowledged(1)).rejects.toThrow("authority is stale");
  expect(f.state().pendingInput?.sequence).toBe(2);
});

it("an identical committed settlement retry preserves a newer pending allocation", async () => {
  const f = fixture();
  const input = await f.claim();
  await input.allocated(1, bytes);
  const receipt = { ...f.state().pendingInput!, outcome: "written" as const, writerUsable: true };
  f.loseResponse();
  await expect(input.settle(receipt)).rejects.toThrow("committed response lost");
  await input.settle(receipt);
  await input.allocated(2, bytes);
  const before = f.state();
  await input.settle(receipt);
  expect(f.state()).toEqual(before);
  await expect(input.settle({ ...receipt, sha256: "f".repeat(64) })).rejects.toThrow("conflicts");
  expect(f.state()).toEqual(before);
});

it("preserves allocated identity after a lost durable response and controller restart", async () => {
  const f = fixture();
  const a = await f.claim();
  f.loseResponse();
  await expect(a.allocated(1, bytes)).rejects.toThrow("committed response lost");
  const b = await RemoteAgentOwnedInput.claim(f.store, f.state(), {
    ...f.environment,
    controller: { id: "controller-B", pid: 102, startedAt: "start-B" },
  });
  expect(f.environment.alive).toHaveBeenCalledWith(expect.objectContaining(controller));
  const pending = b.snapshot().pendingInput!;
  expect(pending).toEqual(remoteAgentInputIdentity(1, bytes));
  await b.settle({ ...pending, outcome: "not-admitted", writerUsable: true });
  await b.allocated(2, bytes);
  expect(f.state().nextInputSequence).toBe(3);
});

it("refuses live/unknown controllers and rechecks a changed authority after liveness observation", async () => {
  const f = fixture();
  await f.claim();
  const observed = f.state();
  const alive = vi
    .fn(async () => {
      f.replace({
        ...f.state(),
        inputAuthority: { id: "controller-C", pid: 103, startedAt: "start-C", nonce: "C" },
      });
      return false;
    })
    .mockImplementationOnce(async () => {
      f.replace({
        ...f.state(),
        inputAuthority: { id: "controller-C", pid: 103, startedAt: "start-C", nonce: "C" },
      });
      return false;
    })
    .mockResolvedValueOnce(true);
  await expect(
    RemoteAgentOwnedInput.claim(f.store, observed, {
      ...f.environment,
      alive,
      controller: { id: "controller-B", pid: 102, startedAt: "start-B" },
    }),
  ).rejects.toThrow("live or unconfirmed");
  expect(alive).toHaveBeenCalledTimes(2);
  expect(f.state().inputAuthority?.id).toBe("controller-C");
});

it("does not synthesize an identity for a legacy gap or enable a natively fenced writer", async () => {
  const f = fixture();
  f.replace({ ...f.state(), nextInputSequence: 2 });
  const legacy = await f.claim();
  expect(legacy.snapshot().pendingInput).toBeUndefined();
  await expect(legacy.allocated(2, bytes)).rejects.toThrow("unresolved");
  const healthy = fixture();
  const input = await healthy.claim();
  await input.allocated(1, bytes);
  await input.settle({ ...healthy.state().pendingInput!, outcome: "written", writerUsable: false });
  expect(healthy.state().inputAcknowledged).toBe(1);
  await expect(input.allocated(2, bytes)).rejects.toThrow("unavailable");
});

it("rejects changed resource identity before mutation", async () => {
  const f = fixture();
  const input = await f.claim();
  f.replace({ ...f.state(), resourceId: "replacement" });
  await expect(input.allocated(1, bytes)).rejects.toThrow("resource authority changed");
  expect(f.state().nextInputSequence).toBe(1);
});

it("cold attach shares one deadline across stages and observes late results without disposing shared state", async () => {
  const { RemoteAgentColdAttach } = await import("./remoteAgentOwnedPty.input.ts");
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    const cold = new RemoteAgentColdAttach();
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(await cold.observe(Promise.resolve("acquired"))).toBe("acquired");
    let complete!: (value: string) => void;
    const durable = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const result = cold.observe(durable);
    const rejected = expect(result).rejects.toThrow("deadline");
    controller.abort(new Error("deadline"));
    await rejected;
    complete("late committed CAS");
    await expect(cold.observe(Promise.reject(new Error("late failure")))).rejects.toThrow();
    expect(timeout).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
  }
});

it.each(
  ["pool", "control", "pin", "attach"].flatMap((stage) => [
    { stage, caller: false },
    { stage, caller: true },
  ]),
)(
  "cold $stage wait expires without a late observer (caller: $caller)",
  async ({ stage, caller }) => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      caller ? new AbortController().signal : deadline.signal,
    );
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = async (name: string) => {
      if (stage === name) {
        entered();
        await blocked;
      }
    };
    const listeners = new Set<unknown>();
    const close = vi.fn();
    const request = vi.fn(async () => {
      await wait("attach");
      throw new Error("late response");
    });
    const subscribe = (listener: unknown) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const connection = {
      close,
      request,
      supportsCapability: () => false,
      onFrame: subscribe,
      onFailure: subscribe,
    };
    const registryUpdate = vi.fn(async () => {
      await wait("pin");
      return {};
    });
    coldFixture.control.mockImplementation(async () => {
      await wait("control");
      return { registry: { update: registryUpdate } };
    });
    const owner = profileOwner();
    const update = vi.fn();
    const reserve = vi.fn();
    const store = { get: async () => owner, update, reserve } as unknown as RemoteAgentOwnerStore;
    const pool = {
      getBound: async () => {
        await wait("pool");
        return connection;
      },
      onRuntimeRestart: vi.fn(),
    };
    const spawn = makeOwnedRemoteAgentPty(
      pool as unknown as RemoteAgentConnectionPool,
      () => store,
    );
    const result = spawn({
      ...spawnInput(),
      recoverOnly: true,
      expectedRemoteResourceId: owner.resourceId,
      ...(caller ? { recoverySignal: deadline.signal } : {}),
    });
    const failed = expect(result).rejects.toThrow("cold deadline");
    await reached;
    deadline.abort(new Error("cold deadline"));
    await failed;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listeners.size).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(pool.onRuntimeRestart).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(stage === "attach" ? 1 : 0);
  },
);
