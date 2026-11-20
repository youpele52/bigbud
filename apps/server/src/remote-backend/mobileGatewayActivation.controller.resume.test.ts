import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { connectNativeServiceLeaseClient } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import {
  retainedReference,
  stateDir,
} from "../remote-agent/remoteAgentServiceLease.test.fixture.ts";
import {
  exitedReply,
  refusedReply,
  successorCredential,
  successorFixture,
  type SuccessorReply,
} from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import {
  createMobileActivationController,
  type MobileActivationLaunch,
  type MobileActivationRecover,
} from "./mobileGatewayActivation.controller.ts";
import { selectNativeMobileSuccessor } from "./mobileGatewayNative.restore.ts";
import {
  adoptNativeMobileSuccessor,
  type NativeMobileSuccessorOutcome,
} from "./mobileGatewayNative.successor.ts";

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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const current = { nonce: "successor", pid: process.pid, startedAt: "start-v2:linux:b:123" };
const configuration = { externalOrigin: "https://fixture.ts.net", port: 49322 };
const activation = { requestId: "00000000-0000-4000-8000-000000000001", configuration };
const row = (id: string, nonce: string, phase = "attempted") => ({
  nonce,
  phase,
  consentRevision: 1,
  configuration,
  controller:
    id === current.nonce ? { id, ...current, nonce: undefined } : { id, pid: 4242, startedAt: "s" },
  nativeOwnership: { binding: { nonce } },
});
const journal = (...attempts: unknown[]) =>
  ({
    schemaVersion: 3,
    mobile: { owner: {}, gatewayLifecycle: { attempts } },
  }) as unknown as RemoteAgentRegistry;
const foreign = journal(row("predecessor", "original-attempt"), row("successor", "own"));

/**
 * The resume pipeline below the composition's IO: canonical journal selection, the retained
 * intent on the actual owner client, and adoption over scripted native replies. The upstream,
 * journal exit and owner admission are recorded seams.
 */
function successor(
  script: Partial<Record<"resume" | "status" | "control", SuccessorReply[]>>,
  options: {
    state?: RemoteAgentRegistry;
    epoch?: string;
    consent?: boolean[];
    /** Owner admission ends by itself (e.g. a failed liveness read). */
    ownerEnds?: boolean;
  } = {},
) {
  const events: string[] = [];
  const f = successorFixture(script, options.epoch ? { epoch: options.epoch } : {});
  const recover: MobileActivationRecover = async (signals, onAdopted) => {
    const selection = selectNativeMobileSuccessor(options.state ?? foreign, current);
    if (selection.kind === "none") return { kind: "none" };
    if (selection.kind === "conflict")
      return { kind: "failed", repairRequired: true, cause: Error("conflict") };
    const client = await connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: options.epoch ?? "epoch",
      stateDir,
    });
    try {
      let pending;
      try {
        pending = client.restorePending(retainedReference(f.input));
      } catch (cause) {
        return { kind: "failed", repairRequired: true, cause };
      }
      onAdopted();
      const outcome = await adoptNativeMobileSuccessor({
        client,
        pending,
        signals,
        consented: async () => options.consent?.shift() ?? true,
        serveUpstream: async (credential) => {
          events.push(`serve:${credential === successorCredential}`);
          return { release: async () => void events.push("release") };
        },
        recordExit: async () => void events.push("journal-exit"),
        use: (_lease, _upstream, signal) =>
          new Promise<void>((resolve) => {
            events.push("owner-run");
            if (options.ownerEnds) resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      });
      events.push(`outcome:${outcome.kind}`);
      return outcome;
    } finally {
      await client.dispose();
    }
  };
  return { events, recover, wire: f.sent };
}
function launcher() {
  const launched: string[] = [];
  const launch: MobileActivationLaunch = async (request, _signals, onSelected) => {
    launched.push(request.requestId);
    onSelected();
    return { kind: "exit-recorded" };
  };
  return { launched, launch };
}
const settle = async (done: Promise<unknown>) => {
  await done.catch(() => {});
  await tick();
};

describe("successor recovery wiring", () => {
  it("is a no-op without a foreign attempted native row and leaves activate available", async () => {
    const own = journal(row("successor", "own"), row("predecessor", "reserved", "reserved"));
    const s = successor({}, { state: own });
    const l = launcher();
    const controller = createMobileActivationController(l.launch, "linux", s.recover);
    expect(await controller.resume()).toEqual({ requestId: null, status: "retired" });
    expect(s.wire()).toEqual([]);
    await tick();
    expect(await controller.activate(activation)).toMatchObject({ status: "accepted" });
    expect(l.launched).toHaveLength(1);
  });

  it("adopts attaching → spawned, hands readiness to the owner and stops with a journal exit", async () => {
    const s = successor({ resume: [{}, { state: "spawned" }], control: [exitedReply] });
    const controller = createMobileActivationController(launcher().launch, "linux", s.recover);
    expect(await controller.resume()).toEqual({ requestId: null, status: "accepted" });
    await vi.waitFor(() => expect(s.events).toContain("owner-run"));
    expect(s.wire()).toEqual(["resume", "resume"]);
    await expect(controller.activate(activation)).rejects.toThrow(/Another mobile gateway/);
    await controller.stop();
    // Native settles (stop + journal-only exit) before the credential-bearing upstream closes.
    expect(s.events).toEqual([
      "serve:true",
      "owner-run",
      "journal-exit",
      "release",
      "outcome:exit-recorded",
    ]);
    expect(s.wire()).toEqual(["resume", "resume", "stop-original"]);
  });

  it("stops the adopted original with a journal exit when owner admission ends by itself", async () => {
    const s = successor(
      { resume: [{}, { state: "spawned" }], control: [exitedReply] },
      { ownerEnds: true },
    );
    const l = launcher();
    const controller = createMobileActivationController(l.launch, "linux", s.recover);
    await controller.resume();
    await vi.waitFor(() => expect(s.events).toContain("outcome:exit-recorded"));
    expect(s.wire()).toEqual(["resume", "resume", "stop-original"]);
    await tick();
    expect(await controller.activate(activation)).toMatchObject({ status: "accepted" });
  });

  it("turns an explicit stop during recovery into native stop plus a journal exit", async () => {
    const s = successor({ resume: [{}], control: [exitedReply] });
    const controller = createMobileActivationController(launcher().launch, "linux", s.recover);
    const resumed = controller.resume();
    await expect(controller.stop()).resolves.toBeUndefined();
    await resumed;
    expect(s.wire()).toEqual(["stop-original"]);
    expect(s.events).toEqual(["journal-exit", "outcome:exit-recorded"]);
  });

  it("detaches an adopted original on retirement without stopping it", async () => {
    const detached = { state: "detached", bootstrap: [] } as const;
    const s = successor({ resume: [{}, { state: "spawned" }], control: [detached] });
    const controller = createMobileActivationController(launcher().launch, "linux", s.recover);
    await controller.resume();
    await vi.waitFor(() => expect(s.events).toContain("owner-run"));
    await controller.close();
    expect(s.wire()).toEqual(["resume", "resume", "detach"]);
    expect(s.events).toEqual(["serve:true", "owner-run", "release", "outcome:detached"]);
  });

  it("records a Gone original journal-only, then allows a fresh activation", async () => {
    const s = successor({ resume: [refusedReply], status: [exitedReply] });
    const l = launcher();
    const controller = createMobileActivationController(l.launch, "linux", s.recover);
    expect(await controller.resume()).toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(s.events).toEqual(["journal-exit", "outcome:exit-recorded"]));
    await tick();
    expect(s.wire()).toEqual(["resume", "status"]);
    await expect(controller.stop()).resolves.toBeUndefined();
    expect(await controller.activate(activation)).toMatchObject({ status: "accepted" });
    expect(l.launched).toHaveLength(1);
  });

  it("takes the revoke path when consent turns off during recovery", async () => {
    const s = successor({ resume: [{}], control: [exitedReply] }, { consent: [true, true, false] });
    const controller = createMobileActivationController(launcher().launch, "linux", s.recover);
    await controller.resume();
    await vi.waitFor(() =>
      expect(s.events).toEqual(["serve:true", "journal-exit", "release", "outcome:exit-recorded"]),
    );
    expect(s.wire()).toEqual(["resume", "stop-original"]);
    await tick();
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  const uncertain: Array<
    [string, Parameters<typeof successor>[0], Parameters<typeof successor>[1], string[]]
  > = [
    ["an older native epoch", {}, { epoch: "epoch-2" }, []],
    ["two foreign rows", {}, { state: journal(row("a", "n1"), row("b", "n2")) }, []],
    ["a legacy native", { resume: [{ state: "spawned" }] }, {}, ["resume"]],
    ["a native that never observes the socket", { resume: [{}, {}] }, {}, ["resume", "resume"]],
  ];
  it.each(uncertain)(
    "stays uncertain and blocks activate for %s",
    async (_name, script, options, wire) => {
      const s = successor(script, options);
      const l = launcher();
      const controller = createMobileActivationController(l.launch, "linux", s.recover);
      await settle(controller.resume());
      expect(await controller.activate(activation)).toEqual({
        requestId: null,
        status: "unavailable",
      });
      await expect(controller.stop()).rejects.toThrow(/cannot be confirmed/);
      expect(l.launched).toEqual([]);
      // Nothing is restored for a refused row; nothing is ever stopped or freshly started.
      expect(s.wire()).toEqual(wire);
    },
  );

  it("clears uncertainty only through a later successful recovery", async () => {
    const outcomes: NativeMobileSuccessorOutcome[] = [
      { kind: "failed", repairRequired: true, cause: Error("consent-unknown") },
      { kind: "none" },
      { kind: "exit-recorded" },
    ];
    const recover: MobileActivationRecover = async (_signals, onAdopted) => {
      const outcome = outcomes.shift()!;
      if (outcome.kind !== "none") onAdopted();
      return outcome;
    };
    const l = launcher();
    const controller = createMobileActivationController(l.launch, "linux", recover);
    await settle(controller.resume());
    expect(await controller.activate(activation)).toMatchObject({ status: "unavailable" });
    // Nothing foreign to adopt is not a recovery: the repair state remains.
    expect(await controller.resume()).toMatchObject({ status: "retired" });
    await tick();
    expect(await controller.activate(activation)).toMatchObject({ status: "unavailable" });
    await settle(controller.resume());
    expect(await controller.activate(activation)).toMatchObject({ status: "accepted" });
    expect(l.launched).toHaveLength(1);
  });

  it("is unavailable off Linux and joins a resume already in flight", async () => {
    let calls = 0;
    let finish!: (outcome: NativeMobileSuccessorOutcome) => void;
    const recover: MobileActivationRecover = (_signals, onAdopted) => {
      calls++;
      onAdopted();
      return new Promise((resolve) => (finish = resolve));
    };
    const off = createMobileActivationController(launcher().launch, "darwin", recover);
    expect(await off.resume()).toEqual({ requestId: null, status: "unavailable" });
    const controller = createMobileActivationController(launcher().launch, "linux", recover);
    const first = controller.resume();
    expect(await controller.resume()).toEqual(await first);
    expect(calls).toBe(1);
    finish({ kind: "exit-recorded" });
  });
});
