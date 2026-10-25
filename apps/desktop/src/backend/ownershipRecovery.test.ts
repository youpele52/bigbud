import { describe, expect, it, vi } from "vitest";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { StateDirLockRecord } from "@bigbud/shared/backendOwnership.record";
import { createOwnershipRecovery, type OwnershipRecoveryDeps } from "./ownershipRecovery";

function fixture(overrides: Partial<OwnershipRecoveryDeps> = {}) {
  let state: DesktopBackendStartupState = {
    generation: 1,
    startedAt: 1,
    status: "failed",
    failureReason: "state_directory_in_use",
  };
  let time = 0;
  let living = true;
  const owner: StateDirLockRecord = {
    format: "bigbud.backend-lock.v1",
    pid: 123,
    startedAt: "start-v2:linux:boot:42",
    hostname: "test",
    machineId: `machine-v1:${"a".repeat(64)}`,
    nonce: "b".repeat(32),
    acquiredAt: "now",
    port: 3000,
    control: { version: 1, port: 3001, secret: "c".repeat(64) },
  };
  const publish = vi.fn((_generation, recovery) => {
    state = { ...state, ownershipRecovery: recovery };
  });
  const start = vi.fn(async () => {
    state = { generation: 2, startedAt: 2, status: "starting" };
  });
  const request = vi.fn(async (_control, input) => {
    if (input.action === "commit") living = false;
    return input.action === "inspect"
      ? "available"
      : input.action === "prepare"
        ? "prepared"
        : "committed";
  });
  const verify = vi.fn(async () => {});
  const deps: OwnershipRecoveryDeps = {
    state: () => state,
    launch: () => ({
      generation: 1,
      stateDir: "/test",
      launcher: "/test/bigbud",
      entry: "/test/bin.mjs",
      inspector: "/test/inspector",
    }),
    blocked: () => false,
    childPresent: () => false,
    start,
    publish,
    platform: "linux",
    machine: () => owner.machineId!,
    token: () => owner.startedAt!,
    alive: () => living,
    verify,
    read: async () => owner,
    request,
    canonical: vi.fn(async () => "/test") as unknown as typeof import("node:fs/promises").realpath,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    ...overrides,
  };
  return { recover: createOwnershipRecovery(deps), deps, owner, request, verify, publish, start };
}

describe("ownership recovery", () => {
  it("a fresh recovery can finish after post-prepare verification fails", async () => {
    let verifications = 0;
    const f = fixture({
      verify: async () => {
        if (++verifications === 3) throw new Error("temporary inspection failure after quiescence");
      },
    });
    await f.recover(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([, input]) => input.action)).toEqual(["inspect", "prepare"]);
    const firstOperation = f.request.mock.calls[0]![1].operation;
    await f.recover(1);
    expect(f.request.mock.calls[2]![1].operation).not.toBe(firstOperation);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("reconciles a lost prepare response without replaying a committed shutdown", async () => {
    let alive = true;
    const actions: string[] = [];
    const f = fixture({
      alive: () => alive,
      request: async (_control, input) => {
        actions.push(input.action);
        if (input.action === "prepare")
          throw new Error("prepare response lost after parent quiesced");
        if (input.action === "status") return "prepared";
        if (input.action === "commit") {
          alive = false;
          return "committed";
        }
        return "available";
      },
    });
    await f.recover(1);
    expect(actions).toEqual(["inspect", "prepare", "status", "commit"]);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("retries preparation once when the parent acknowledgment is delayed", async () => {
    let alive = true;
    let attempts = 0;
    const f = fixture({
      alive: () => alive,
      request: async (_control, input) => {
        if (input.action === "prepare")
          return ++attempts === 1 ? "supervisor_unavailable" : "prepared";
        if (input.action === "commit") {
          alive = false;
          return "committed";
        }
        return "available";
      },
    });
    await f.recover(1);
    expect(attempts).toBe(2);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("eligibility checks never prepare, stop, or start a backend", async () => {
    const f = fixture();
    await f.recover.check(1);
    expect(f.request.mock.calls.map(([, input]) => input.action)).toEqual(["inspect"]);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(1, { phase: "available" });
  });
  it("does not commit or restart after quitting begins during verification", async () => {
    let quitting = false;
    const f = fixture({
      blocked: () => quitting,
      verify: async () => {
        quitting = true;
      },
    });
    await f.recover(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(1, {
      phase: "failed",
      error: "application_quitting",
    });
  });
  it("fails closed when OS executable verification fails", async () => {
    const f = fixture({
      verify: async () => {
        throw new Error("wrong executable");
      },
    });
    await f.recover(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not stop a legacy backend that lacks the cooperative protocol", async () => {
    const f = fixture({
      read: async () => {
        const legacy = { ...f.owner };
        delete legacy.control;
        return legacy;
      },
    });
    await f.recover(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("single-flights, verifies three times, quiesces before committing and retries once", async () => {
    const f = fixture();
    const first = f.recover(1);
    expect(f.recover(1)).toBe(first);
    await first;
    expect(f.request.mock.calls.map(([, input]) => input.action)).toEqual([
      "inspect",
      "prepare",
      "commit",
    ]);
    expect(f.verify).toHaveBeenCalledTimes(3);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it.each(["win32", "freebsd"])("fails closed on %s", async (platform) => {
    const f = fixture({ platform });
    await f.recover(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(1, {
      phase: "failed",
      error: "unsupported_platform",
    });
  });
  it("does not trust an in-use reason with an unknown start token", async () => {
    const f = fixture({ token: () => undefined });
    await f.recover(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not stop a foreign machine owner", async () => {
    const f = fixture({ machine: () => "another-machine" });
    await f.recover(1);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("retries a missing or proven-dead owner without stopping anything", async () => {
    for (const overrides of [{ read: async () => undefined }, { alive: () => false }]) {
      const f = fixture(overrides);
      await f.recover(1);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.start).toHaveBeenCalledOnce();
    }
  });
  it("rejects stale generations without a process operation", async () => {
    const f = fixture();
    await f.recover(2);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("stops before commit when a successor changes the lock", async () => {
    let reads = 0;
    const f = fixture({
      read: async (): Promise<StateDirLockRecord> => {
        reads++;
        return reads >= 4 ? { ...f.owner, nonce: "d".repeat(32) } : f.owner;
      },
    });
    await f.recover(1);
    expect(f.request.mock.calls.map(([, input]) => input.action)).toEqual(["inspect", "prepare"]);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(1, { phase: "failed", error: "owner_changed" });
  });
  it("times out without retry or escalation if the owner remains alive", async () => {
    const f = fixture({ alive: () => true });
    await f.recover(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(1, { phase: "failed", error: "shutdown_timed_out" });
  });
  it("requires supervisor preparation", async () => {
    const f = fixture({
      request: async (_control, input) =>
        input.action === "inspect" ? "available" : "supervisor_unavailable",
    });
    await f.recover(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(1, {
      phase: "failed",
      error: "supervisor_unavailable",
    });
  });
});
