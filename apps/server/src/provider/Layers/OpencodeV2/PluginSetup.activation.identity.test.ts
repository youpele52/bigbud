import { expect, it, vi } from "vitest";
import { makeV2IdentityPublication } from "./PluginSetup.activation.identity.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";

it("identity maintenance keeps the code epoch/readiness stamps and joins issued metadata on gate expiry", async () => {
  vi.useFakeTimers();
  const gate = new V2ActivationGate("scope", "artifact", () => {});
  const stamp = gate.verify("/location", "artifact", "setup");
  const phase = vi.fn();
  const job = {
    id: "metadata",
    signal: new AbortController().signal,
    assertCurrent: () => {},
    phase,
  } as unknown as V2OwnedActivationJob;
  const fresh = vi.fn(async () => {});
  const metadata = makeV2IdentityPublication(job, gate, new Map(), fresh);
  let finish: () => void = () => {};
  try {
    await metadata.authority.prepare();
    const release = await metadata.authority.locked();
    await metadata.authority.beforeMutation();
    const issued = new Promise<void>((resolve) => {
      finish = resolve;
    });
    metadata.authority.observePhysical!(issued);
    await vi.advanceTimersByTimeAsync(15001);
    expect(() => metadata.authority.assertGate()).toThrow();
    expect(phase).toHaveBeenCalledWith("uncertain", expect.stringContaining("gate expired"));
    expect(gate.knownReady("/location")).toBe(stamp);
    expect(gate.snapshot().epoch).toBe(0);
    let drained = false;
    const drain = metadata.authority.joinPhysical!().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await drain;
    release(); // Exact cleanup is idempotent after the short gate expired.
    expect(fresh).toHaveBeenCalledTimes(2);
  } finally {
    finish();
    await metadata.close();
    vi.useRealTimers();
  }
});

it("identity authority cannot authorize a mutation before closing admission", async () => {
  const gate = new V2ActivationGate("scope", "artifact", () => {});
  const job = {
    id: "metadata",
    signal: new AbortController().signal,
    assertCurrent: () => {},
    phase: () => {},
  } as unknown as V2OwnedActivationJob;
  const metadata = makeV2IdentityPublication(job, gate, new Map(), async () => {});
  try {
    await expect(metadata.authority.beforeMutation()).rejects.toThrow("closed admission");
    const release = await metadata.authority.locked();
    await metadata.authority.beforeMutation();
    release();
    expect(() => metadata.authority.assertGate()).toThrow("released");
    await expect(metadata.authority.beforeMutation()).rejects.toThrow("closed admission");
  } finally {
    await metadata.close();
  }
});
