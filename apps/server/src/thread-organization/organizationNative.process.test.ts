import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { OrganizationNativeProcess } from "./organizationNative.process.ts";
import { schedulingFixtureFrames } from "./organizationScheduling.fixtures.ts";
import type { OrganizationNativeFrame } from "./organizationProtocol.ts";

const binary = resolve(
  import.meta.dirname,
  `../../../../target/debug/bigbud-desktop-supervisor${process.platform === "win32" ? ".exe" : ""}`,
);
const nativeIt = it.skipIf(!existsSync(binary));
const owner = { backendNonce: "scheduling-owner", generation: 1 };

nativeIt(
  "hands a TS compact snapshot to the actual Rust process and delivers ordered proposals",
  async () => {
    const received: OrganizationNativeFrame[] = [];
    const failures: Error[] = [];
    const native = new OrganizationNativeProcess({
      binary,
      ...owner,
      receive: async (frame) => {
        received.push(frame);
      },
      failed: (error) => {
        failures.push(error);
      },
    });
    try {
      native.start();
      for (const frame of schedulingFixtureFrames()) await native.send(frame);
      await expect.poll(() => received.some((frame) => frame.type === "proposal")).toBe(true);
      expect(received[0]?.type).toBe("ready");
      const proposal = received.find((frame) => frame.type === "proposal");
      expect(proposal?.type === "proposal" ? proposal.value.destination : undefined).toBe(2);
      expect(failures).toEqual([]);
      await expect(
        native.send({ ...owner, generation: 2, type: "heartbeat", value: { sequence: 1 } }),
      ).rejects.toThrow("stale");
    } finally {
      await native.stop();
    }
    await expect(
      native.send({ ...owner, type: "heartbeat", value: { sequence: 1 } }),
    ).rejects.toThrow("not running");
    expect(failures).toEqual([]);
  },
);

it("a missing binary fences all sends and can still be stopped idempotently", async () => {
  const failures: Error[] = [];
  const native = new OrganizationNativeProcess({
    ...owner,
    binary: resolve(import.meta.dirname, "not-a-binary"),
    receive: async () => {},
    failed: (error) => {
      failures.push(error);
    },
  });
  native.start();
  await expect.poll(() => failures.length).toBe(1);
  await expect(native.send(schedulingFixtureFrames()[0]!)).rejects.toThrow();
  await Promise.all([native.stop(), native.stop()]);
  expect(failures).toHaveLength(1);
});

nativeIt(
  "shutdown aborts a stalled receiver and does not wait for its unresolved callback",
  async () => {
    let signal: AbortSignal | undefined;
    const failures: Error[] = [];
    const native = new OrganizationNativeProcess({
      binary,
      ...owner,
      receive: async (_frame, receiverSignal) => {
        signal = receiverSignal;
        await new Promise<void>(() => {});
      },
      failed: (error) => {
        failures.push(error);
      },
    });
    try {
      native.start();
      for (const frame of schedulingFixtureFrames()) await native.send(frame);
      await expect.poll(() => signal !== undefined).toBe(true);
      await native.stop();
      expect(signal?.aborted).toBe(true);
      expect(failures).toEqual([]);
    } finally {
      await native.stop();
    }
  },
);

nativeIt("receiver failure fences the child without accepting further proposals", async () => {
  const failures: Error[] = [];
  const native = new OrganizationNativeProcess({
    binary,
    ...owner,
    receive: async () => {
      throw new Error("receipt owner unavailable");
    },
    failed: (error) => {
      failures.push(error);
    },
  });
  try {
    native.start();
    for (const frame of schedulingFixtureFrames()) await native.send(frame);
    await expect.poll(() => failures.length).toBe(1);
    expect(failures[0]?.message).toBe("receipt owner unavailable");
    await expect(
      native.send({ ...owner, type: "heartbeat", value: { sequence: 1 } }),
    ).rejects.toThrow("receipt owner");
  } finally {
    await native.stop();
  }
});
