import { expect, expectTypeOf, it, vi } from "vitest";
import {
  exitedReply,
  refusedReply,
} from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import type { ManagedNativeMobileActivationPreparation } from "./mobileGatewayActivation.native.assets.ts";
import {
  cancelledReply,
  detachedReply,
  runNativeActivation,
  spawnedReply,
} from "./mobileGatewayActivation.native.fixture.ts";
import { MobileActivationWorkerRepair } from "./mobileGatewayActivation.worker.ts";
import { nativeMobileActivationLease } from "./mobileGatewayActivation.native.ts";
import type { VerifiedNativeLease } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (path: string) => {
      if (path === `/proc/${process.pid}/stat`)
        return `${process.pid} (node) ${["S", ...Array<string>(18).fill("0"), "123"].join(" ")}`;
      if (path === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
      throw Error("Unexpected synthetic controller fixture read.");
    },
  };
});
const prelude = ["assets@0", "receipt@0", "prepare@0", "reserve@0", "mark-invoked@0"];
const completed = (disposition: "detached" | "exit-recorded") => ({
  ok: true,
  value: { kind: "completed", disposition, value: "ready-value" },
});
const repair = (outcome: { readonly ok: boolean; readonly cause?: unknown }) => {
  expect(outcome.ok).toBe(false);
  expect(outcome.cause).toBeInstanceOf(MobileActivationWorkerRepair);
};

it("keeps the managed preparation assignable to the activation port", () => {
  expectTypeOf<ManagedNativeMobileActivationPreparation>().not.toBeNever();
});

it("settles assets, receipt, preparation, reservation and invocation before the Start frame", async () => {
  const run = await runNativeActivation({
    script: { start: [spawnedReply], control: [exitedReply] },
  });
  expect(run.events.slice(0, prelude.length)).toEqual(prelude);
  expect(run.wire[0]).toBe("start");
});

it("stops the original, then records exit through confirmed cleanup before removal", async () => {
  const run = await runNativeActivation({
    script: { start: [spawnedReply], control: [exitedReply] },
  });
  expect(run.result).toEqual(completed("exit-recorded"));
  expect(run.events).toEqual([
    ...prelude,
    "use@1",
    "confirm:native-exit@2",
    "remove:native-exit@2",
  ]);
  // Confirmed exit already retired the grant; no detach frame follows a terminal scope.
  expect(run.wire).toEqual(["start", "stop-original"]);
});

it("completes detach-only without stopping the original child", async () => {
  const run = await runNativeActivation({
    script: { start: [spawnedReply], control: [detachedReply] },
    abortDetach: "use",
  });
  expect(run.result).toEqual(completed("detached"));
  expect(run.wire).toEqual(["start", "detach"]);
  expect(run.events).toEqual([...prelude, "use@1"]);
});

it("never treats a cancelled stop-original reply for a live lease as exit evidence", async () => {
  const run = await runNativeActivation({
    script: { start: [spawnedReply], control: [cancelledReply] },
  });
  repair(run.result);
  const failures = run.result.ok
    ? []
    : (run.result.cause as { cause: AggregateError }).cause.errors;
  // The binding itself refuses; the opaque exit accessor is not the only fence.
  expect(String(failures[0])).toMatch(/exit is unconfirmed/);
  expect(run.wire).toEqual(["start", "stop-original"]);
  expect(run.events).toEqual([...prelude, "use@1"]);
});

it("maps a lost Start acknowledgement reconciled live to the original lease", async () => {
  const run = await runNativeActivation({
    script: { start: [refusedReply], status: [spawnedReply], control: [exitedReply] },
  });
  expect(run.result).toEqual(completed("exit-recorded"));
  expect(run.wire).toEqual(["start", "status", "stop-original"]);
  expect(run.events).toEqual([
    ...prelude,
    "use@2",
    "confirm:native-exit@3",
    "remove:native-exit@3",
  ]);
});

it("maps lost-Start cancelled/exited reconciliation to confirmed cleanup, then fails", async () => {
  const cancelled = await runNativeActivation({
    script: { start: [refusedReply], status: [cancelledReply] },
  });
  expect(cancelled.result.ok).toBe(false);
  expect(cancelled.result.ok || cancelled.result.cause).not.toBeInstanceOf(
    MobileActivationWorkerRepair,
  );
  expect(cancelled.wire).toEqual(["start", "status"]);
  expect(cancelled.events).toEqual([
    ...prelude,
    "confirm:native-cancel@2",
    "remove:native-cancel@2",
  ]);
  const exited = await runNativeActivation({
    script: { start: [refusedReply], status: [exitedReply] },
  });
  expect(exited.result.ok).toBe(false);
  expect(exited.events).toEqual([...prelude, "confirm:native-exit@2", "remove:native-exit@2"]);
});

it("keeps an uncertain lost Start for repair without confirming or removing anything", async () => {
  for (const scenario of [
    { script: { start: [refusedReply], status: [{}] } },
    { script: { start: [refusedReply], status: [refusedReply] } },
    { script: { start: ["lost" as const], status: [{}] }, abortDetach: "start" as const },
  ]) {
    const run = await runNativeActivation(scenario);
    repair(run.result);
    expect(run.wire).toEqual(["start", "status"]);
    expect(run.events).toEqual(prelude);
  }
});

it("cancels unlaunched work by progress: unarmed, never-invoked, then fenced pending", async () => {
  const unarmed = await runNativeActivation({ script: {}, fail: "prepare" });
  expect(unarmed.result.ok).toBe(false);
  expect(unarmed.wire).toEqual([]);
  expect(unarmed.events).toEqual(["assets@0", "receipt@0", "prepare@0", "remove:unarmed@0"]);
  const unreserved = await runNativeActivation({ script: {}, fail: "reserve" });
  expect(unreserved.wire).toEqual([]);
  expect(unreserved.events).toEqual([
    ...prelude.slice(0, 4),
    "confirm:never-invoked@0",
    "remove:never-invoked@0",
  ]);
  const uninvoked = await runNativeActivation({
    script: { control: [cancelledReply] },
    fail: "mark-invoked",
  });
  expect(uninvoked.result.ok).toBe(false);
  expect(uninvoked.wire).toEqual(["cancel-pending"]);
  expect(uninvoked.events).toEqual([
    ...prelude,
    "confirm:native-cancel@1",
    "remove:native-cancel@1",
  ]);
});

it("fails closed on a null durable intent and never sends Start", async () => {
  const run = await runNativeActivation({ script: {}, nullIntent: true });
  expect(run.result.ok).toBe(false);
  expect(String(run.result.ok || run.result.cause)).toMatch(/not admitted/);
  expect(run.wire).toEqual([]);
  expect(run.events).toEqual([
    ...prelude.slice(0, 4),
    "confirm:never-invoked@0",
    "remove:never-invoked@0",
  ]);
});

it("exposes the held lease's client and pending only until stop or detach retires it", async () => {
  for (const scenario of [
    { script: { start: [spawnedReply], control: [exitedReply] } },
    { script: { start: [spawnedReply], control: [detachedReply] }, abortDetach: "use" as const },
  ]) {
    let held: VerifiedNativeLease | undefined;
    const run = await runNativeActivation({
      ...scenario,
      inspect: (lease, client) => {
        held = lease;
        const { client: owner, pending } = nativeMobileActivationLease(lease);
        expect(owner).toBe(client);
        expect(client.binding(pending)).toEqual(client.evidence(lease).binding);
      },
    });
    expect(run.result.ok).toBe(true);
    expect(() => nativeMobileActivationLease(held!)).toThrow(/Held original/);
  }
  expect(() => nativeMobileActivationLease(Object.freeze({}) as VerifiedNativeLease)).toThrow(
    /Held original/,
  );
});
