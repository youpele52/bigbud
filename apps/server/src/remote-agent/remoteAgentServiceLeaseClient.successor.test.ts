import { expect, it, vi } from "vitest";
import { connectNativeServiceLeaseClient } from "./remoteAgentServiceLeaseClient.ts";
import { retainedReference, stateDir } from "./remoteAgentServiceLease.test.fixture.ts";
import {
  priorController,
  refusedReply,
  successorController,
  successorCredential,
  successorFixture,
  type SuccessorReply,
} from "./remoteAgentServiceLease.successor.fixture.ts";
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
async function successor(resume: SuccessorReply[]) {
  const f = successorFixture({ resume });
  const client = await connectNativeServiceLeaseClient(f.connection, {
    nativeEpoch: "epoch",
    stateDir,
  });
  return { f, client, pending: client.restorePending(retainedReference(f.input)) };
}
const credential = (env: ReadonlyArray<{ readonly value: string }>) => env[0]?.value;

it("Resume #1 attaching yields bootstrap only; Resume #2 stays attaching until native verifies", async () => {
  const { f, client, pending } = await successor([{}, {}, { state: "spawned" }]);
  try {
    const first = await client.resume(pending);
    if (first.state !== "attaching") throw Error("expected attaching");
    expect(client.withBootstrap(first.attaching, credential)).toBe(successorCredential);
    // The new socket is absent to native: still attaching, the same token, never a live lease.
    const absent = await client.attach(first.attaching);
    expect(absent).toEqual({ state: "attaching", attaching: first.attaching });
    const attached = await client.attach(first.attaching);
    if (attached.state !== "live") throw Error("expected live");
    expect(client.evidence(attached.lease).previousController).toEqual(priorController);
    expect(client.evidence(attached.lease).currentController).toEqual(successorController);
    expect(client.withBootstrap(attached.lease, credential)).toBe(successorCredential);
    // Readiness retires the attaching grant; it cannot be replayed.
    expect(() => client.withBootstrap(first.attaching, credential)).toThrow(/token required/);
    await expect(client.attach(first.attaching)).rejects.toThrow(/attaching token/);
    expect(f.sent()).toEqual(["resume", "resume", "resume"]);
  } finally {
    await client.dispose();
  }
});

it("a legacy native that only knows spawned resumes live; unknown states stay refused", async () => {
  const legacy = await successor([{ state: "spawned" }]);
  try {
    expect((await legacy.client.resume(legacy.pending)).state).toBe("live");
  } finally {
    await legacy.client.dispose();
  }
  for (const state of ["adopting", "detached", "exited", "uncertain", "SPAWNED"]) {
    const unknown = await successor([{ state }]);
    try {
      await expect(unknown.client.resume(unknown.pending)).rejects.toThrow(/not correlated/);
    } finally {
      await unknown.client.dispose();
    }
  }
});

it("refuses attaching without a distinct prior controller, bootstrap or stable generation", async () => {
  const cases: Array<[SuccessorReply[], RegExp, "resume" | "attach"]> = [
    [[{ previousController: undefined }], /distinct prior controller/, "resume"],
    [[{ previousController: successorController }], /distinct prior controller/, "resume"],
    [[{ bootstrap: [] }], /distinct prior controller/, "resume"],
    [[{ currentController: priorController }], /not correlated/, "resume"],
    [[{}, { generation: 3 }], /generation changed/, "attach"],
    [[{}, { generation: 3, state: "spawned" }], /generation changed/, "attach"],
    [[{}, { state: "adopting" }], /not correlated/, "attach"],
    [[{}, refusedReply], /refused or remains uncertain/, "attach"],
    [[{}, { ...(refusedReply as object), state: "uncertain" }], /refused or remains/, "attach"],
  ];
  for (const [script, error, step] of cases) {
    const { client, pending } = await successor(script);
    try {
      if (step === "resume") await expect(client.resume(pending)).rejects.toThrow(error);
      else {
        const first = await client.resume(pending);
        if (first.state !== "attaching") throw Error("expected attaching");
        await expect(client.attach(first.attaching)).rejects.toThrow(error);
      }
    } finally {
      await client.dispose();
    }
  }
});

it("an attaching status is never reconciled as live, and teardown stays available", async () => {
  const f = successorFixture({
    resume: [{}],
    status: [{}],
    control: [{ state: "exited", generation: 0, bootstrap: [] }],
  });
  const client = await connectNativeServiceLeaseClient(f.connection, {
    nativeEpoch: "epoch",
    stateDir,
  });
  try {
    const pending = client.restorePending(retainedReference(f.input));
    const first = await client.resume(pending);
    if (first.state !== "attaching") throw Error("expected attaching");
    await expect(client.reconcile(pending)).rejects.toThrow(/uncertain/);
    expect((await client.stopOriginal(pending)).state).toBe("exited");
    // Confirmed exit invalidates the successor bootstrap.
    expect(() => client.withBootstrap(first.attaching, credential)).toThrow(/stale/);
    expect(f.sent()).toEqual(["resume", "status", "stop-original"]);
  } finally {
    await client.dispose();
  }
});
